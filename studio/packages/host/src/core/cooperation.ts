import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { login, register, logout, clearAccount, recentServers, readCooperation, updateCooperation, privateClientPath } from "@amo-studio/account";
import { RelayStore, startRelayServer, type RelayServer } from "@amo-studio/relay";
import type { CooperationState, TransferRequest } from "@amo-studio/protocol";
import type { HostService } from "../service.js";
import { HostError } from "./shared.js";

function defaultPhonePort(): number {
  const value = process.env.AMO_STUDIO_PHONE_PORT;
  return value !== undefined && /^\d+$/.test(value) && Number(value) <= 65535 ? Number(value) : 47950;
}

// Security controls belong to the Host, not to agent permission modes. There is no MCP tool to approve a transfer.
export class Cooperation {
  private server: RelayServer | null = null;
  private relayStore: RelayStore | null = null;
  private error: string | null = null;
  private changing: Promise<void> = Promise.resolve();
  private invite = "";
  private pending = new Map<string, { request: TransferRequest; resolve(allow: boolean): void }>();
  private fileGrants = new Map<string, number>();
  private policyWatch: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly host: HostService, private readonly serverPort = defaultPhonePort()) {}
  modelChoices(profileId: string) { return this.host.config.choices(profileId); }
  teamMembers() { return this.host.teamRelay.members(); }
  assertRemoteEnabled(): void { if (!this.host.remote.enabled()) throw new HostError("read_only", "远程已关闭"); }
  ownDevice(account: string): boolean { return !!this.host.teamLink.account && this.host.teamLink.account.name === account && readCooperation(this.env).syncOwnDevices; }
  taskAllowed(taskId: string): boolean {
    const imported = this.host.store.db.prepare("SELECT value FROM kv WHERE key LIKE 'claude-adopted:%'").all() as Array<{ value: string }>;
    return !this.host.store.listSessions({ taskId }).some((s) => imported.some((row) => row.value === s.id));
  }
  get env() { return this.host.teamLink.env; }
  initializePrivacy(): void {
    if (this.host.store.getKv("cooperation.security-version")?.value === "1") return;
    // Upgrade into a disconnected state before the remote feature starts; existing data and pair records remain.
    this.host.store.setKv("remote.enabled", "null");
    updateCooperation({ relayEnabled: false, serverLan: false, syncOwnDevices: false }, this.env);
    this.host.store.setKv("cooperation.security-version", "1");
  }
  state(): CooperationState {
    const a = this.host.teamLink.account;
    const p = readCooperation(this.env);
    const addresses = this.server ? [`http://127.0.0.1:${this.server.port}`, ...(p.serverLan ? Object.values(networkInterfaces()).flatMap((all) => (all ?? []).filter((n) => !n.internal && n.family === "IPv4").map((n) => `http://${n.address}:${this.server!.port}`)) : [])] : [];
    return { account: a ? { name: a.name, server: a.server } : null, recentServers: recentServers({ env: this.env }), relayEnabled: p.relayEnabled, remoteEnabled: this.host.remote.enabled(), syncOwnDevices: p.syncOwnDevices, server: { running: !!this.server, lan: p.serverLan, port: this.server?.port ?? null, addresses, invite: this.invite, error: this.error }, transfers: [...this.pending.values()].map((p) => p.request) };
  }
  async account(input: { action: string; server: string; name: string; password: string; passphrase?: string }): Promise<CooperationState> {
    if (input.action !== "login" && input.action !== "register") throw new HostError("bad_request", "账号操作无效");
    await this.host.remote.setEnabled(false);
    this.relay(false);
    if (this.host.teamLink.account) { await logout(this.host.teamLink.accountOptions); await this.host.teamLink.reload(); }
    await (input.action === "register" ? register(input, this.host.teamLink.accountOptions) : login(input, this.host.teamLink.accountOptions));
    await this.host.teamLink.reload();
    return this.state();
  }
  relay(on: boolean): CooperationState {
    if (on && !this.host.teamLink.account) throw new HostError("bad_request", "请先在合作模式中登录账号");
    updateCooperation({ relayEnabled: on }, this.env);
    if (on) this.host.teamRelay.start(); else this.host.teamRelay.stop();
    return this.state();
  }
  syncOwn(on: boolean): CooperationState { updateCooperation({ syncOwnDevices: on }, this.env); if (on) this.syncOwnTasks(); return this.state(); }
  syncOwnTasks(): void {
    if (!readCooperation(this.env).syncOwnDevices || !this.host.remote.enabled()) return;
    const account = this.host.teamLink.account?.name;
    for (const peer of this.host.remote.pairs().filter((p) => p.role === "owner" && p.account === account)) {
      for (const task of this.host.store.listTasks().filter((t) => !t.remote && !t.archivedAt && this.taskAllowed(t.id))) {
        if (!this.host.remote.grants.list().some((g) => g.taskId === task.id && g.account === peer.account && g.device === peer.device)) this.host.remote.grants.grant(task.id, peer);
      }
    }
  }
  async mirrorInbox(threadId: string, title: string, seq: number, text: string): Promise<void> {
    if (!readCooperation(this.env).relayEnabled) return;
    const a = this.host.teamLink.account;
    if (!a) return;
    const key = `${a.server}\n${a.name}\n${threadId}`;
    const mapping = JSON.parse(this.host.store.getKv("cooperation.inbox")?.value ?? "{}") as Record<string, { taskId: string; seq: number }>;
    const old = mapping[key];
    if (old?.seq === seq && this.host.store.getTask(old.taskId)) return;
    let taskId = old?.taskId;
    if (!taskId || !this.host.store.getTask(taskId)) {
      const made = await this.host.tasks.createTask({ title: `中转 · ${title || threadId}`, column: "todo", firstMessage: text.slice(0, 19000) });
      taskId = made.task.id;
    }
    this.host.tasks.updateTask(taskId, { description: `来自 Work中转的消息（不会自动执行）\n\n${text.slice(-19000)}` });
    mapping[key] = { taskId, seq };
    this.host.store.setKv("cooperation.inbox", JSON.stringify(mapping));
    this.syncOwnTasks();
  }
  async logout(): Promise<CooperationState> {
    await this.host.remote.setEnabled(false);
    this.relay(false);
    // Local credentials are removed even when the team server cannot be reached.
    try { await logout(this.host.teamLink.accountOptions); } finally { clearAccount({ env: this.env }); await this.host.teamLink.reload(); }
    return this.state();
  }
  async off(): Promise<CooperationState> {
    await this.logout();
    await this.setServer(false);
    this.fileGrants.clear();
    for (const p of this.pending.values()) p.resolve(false);
    this.pending.clear();
    return this.state();
  }
  async startDefault(): Promise<void> {
    this.policyWatch = setInterval(() => { if (readCooperation(this.env).relayEnabled && this.host.teamLink.account) this.host.teamRelay.start(); else this.host.teamRelay.stop(); }, 500);
    this.policyWatch.unref();
    const p = readCooperation(this.env);
    if (p.serverEnabled) await this.setServer(true, p.serverLan);
  }
  async setServer(on: boolean, lan = false): Promise<CooperationState> {
    this.changing = this.changing.catch(() => undefined).then(async () => {
      updateCooperation({ serverEnabled: on, serverLan: lan }, this.env);
      await this.stopServer();
      if (!on) return;
      const dir = join(dirname(this.host.store.path), "phone-server");
      mkdirSync(dir, { recursive: true });
      this.invite = this.host.store.getKv("cooperation.invite")?.value ?? randomBytes(18).toString("base64url");
      this.host.store.setKv("cooperation.invite", this.invite);
      try {
        this.relayStore = new RelayStore(join(dir, "relay.db"));
        this.server = await startRelayServer({ store: this.relayStore, filesDir: join(dir, "files"), host: lan ? "0.0.0.0" : "127.0.0.1", port: this.serverPort, name: "WorkStudio 手机服务", passphrase: this.invite, minPasswordLength: 12 });
        this.error = null;
      } catch (e) { this.relayStore?.close(); this.relayStore = null; this.error = e instanceof Error ? e.message : String(e); }
    });
    await this.changing;
    return this.state();
  }
  private async stopServer(): Promise<void> {
    await this.server?.close(); this.server = null;
    this.relayStore?.close(); this.relayStore = null;
  }
  async stop(): Promise<void> { if (this.policyWatch) clearInterval(this.policyWatch); this.policyWatch = null; await this.changing; await this.stopServer(); for (const p of this.pending.values()) p.resolve(false); this.pending.clear(); this.fileGrants.clear(); }
  async confirmTransfer(taskId: string, peer: string, path: string, offset = 0): Promise<void> {
    if (privateClientPath(path)) throw new HostError("read_only", "禁止发送原生客户端的对话和私有数据");
    const key = `${taskId}\n${peer}\n${path}`;
    if (offset > 0) { if ((this.fileGrants.get(key) ?? 0) < Date.now()) throw new HostError("read_only", "文件外发尚未得到本机确认"); return; }
    const id = randomBytes(16).toString("hex");
    const allowed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(false); }, 120_000);
      timer.unref();
      this.pending.set(id, { request: { id, taskId, peer, path, createdAt: new Date().toISOString() }, resolve: (allow) => { clearTimeout(timer); this.pending.delete(id); resolve(allow); } });
    });
    if (!allowed) throw new HostError("read_only", "本机用户未确认文件外发；模型的全部允许不会跳过此确认");
    this.fileGrants.set(key, Date.now() + 120_000);
  }
  answer(id: string, allow: boolean): CooperationState { const p = this.pending.get(id); if (!p) throw new HostError("not_found", "确认已过期"); p.resolve(allow); return this.state(); }
}
