import { randomBytes } from "node:crypto";
import { login, register, logout, clearAccount, recentServers, readCooperation, updateCooperation, privateClientPath } from "@amo-studio/account";
import { PhoneRemote } from "./phone-remote.js";
import type { CooperationState, TransferRequest } from "@amo-studio/protocol";
import type { HostService } from "../service.js";
import { HostError } from "./shared.js";

function defaultPhonePort(): number {
  const value = process.env.AMO_STUDIO_PHONE_PORT;
  return value !== undefined && /^\d+$/.test(value) && Number(value) <= 65535 ? Number(value) : 47950;
}

// Security controls belong to the Host, not to agent permission modes. There is no MCP tool to approve a transfer.
export class Cooperation {
  readonly phone: PhoneRemote;
  private changing: Promise<void> = Promise.resolve();
  private pending = new Map<string, { request: TransferRequest; resolve(allow: boolean): void }>();
  private fileGrants = new Map<string, number>();
  private policyWatch: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly host: HostService, serverPort = defaultPhonePort()) { this.phone = new PhoneRemote(host, serverPort); }
  modelChoices(profileId: string) { return this.host.config.choices(profileId); }
  teamMembers() { return this.host.teamRelay.members(); }
  assertRemoteEnabled(): void { if (!this.host.remote.enabled()) throw new HostError("read_only", "远程已关闭"); }
  ownDevice(account: string): boolean { return !!this.host.teamLink.account && this.host.teamLink.account.name === account && readCooperation(this.env).syncOwnDevices; }
  taskAllowed(taskId: string): boolean {
    const imported = new Set((this.host.store.db.prepare("SELECT value FROM kv WHERE key LIKE 'claude-adopted:%'").all() as Array<{ value: string }>).map((r) => r.value));
    return !this.host.store.listSessions({ taskId }).some((session) => {
      const seen = new Set<string>(); let current = session;
      while (!seen.has(current.id)) { if (imported.has(current.id)) return true; seen.add(current.id); const parent = current.parentId ? this.host.store.getSession(current.parentId) : undefined; if (!parent) break; current = parent; }
      return false;
    });
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
    return { account: a ? { name: a.name, server: a.server } : null, recentServers: recentServers({ env: this.env }), relayEnabled: p.relayEnabled, remoteEnabled: this.host.remote.enabled(), syncOwnDevices: p.syncOwnDevices, server: { ...this.phone.state(), lan: p.serverLan }, transfers: [...this.pending.values()].map((p) => p.request) };
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
    this.phone.markTeamInbox(taskId);
    await this.host.sessions.receiveTeamInbox(taskId, text.slice(-19000), title || "团队消息");
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
    // A busy phone port must not stop local chats or the independent team account from starting.
    if (p.serverEnabled) await this.setServer(true, p.serverLan).catch((e) => this.host.log("手机远程未启动：" + (e instanceof Error ? e.message : String(e))));
  }
  async setServer(on: boolean, lan = false): Promise<CooperationState> {
    this.changing = this.changing.catch(() => undefined).then(async () => {
      updateCooperation({ serverEnabled: on, serverLan: lan }, this.env);
      if (on) await this.phone.start(lan); else await this.phone.stop(lan);
    });
    await this.changing; return this.state();
  }
  createPhoneAccount(input: { name: string; password: string; forwardTeamInbox?: boolean }): CooperationState { this.phone.create(input.name, input.password, input.forwardTeamInbox === true); return this.state(); }
  updatePhoneAccount(name: string, patch: { enabled?: boolean; password?: string; forwardTeamInbox?: boolean }): CooperationState { this.phone.update(name, patch); return this.state(); }
  deletePhoneAccount(name: string): CooperationState { this.phone.delete(name); return this.state(); }
  async stop(): Promise<void> { if (this.policyWatch) clearInterval(this.policyWatch); this.policyWatch = null; await this.changing.catch(() => undefined); await this.phone.close(); for (const p of this.pending.values()) p.resolve(false); this.pending.clear(); this.fileGrants.clear(); }
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
