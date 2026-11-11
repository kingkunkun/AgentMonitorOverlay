import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { RelayStore, startRelayServer, type RelayServer, type DeviceRef, type DeviceEvent, type NamedDevice } from "@amo-studio/relay";
import { REMOTE_KINDS, isCommon, type HostEvent, type PhoneAccount, type CooperationState } from "@amo-studio/protocol";
import type { HostService } from "../service.js";
import type { Store } from "../store/store.js";
import { PHONE_REMOTE_PREFIX } from "../store/kv-keys.js";
import { HostError } from "./shared.js";
import { DeviceLink, CommandLog, type RelayFrameIn } from "../features/remote/link.js";
import { RemoteGrants, type RemoteContext, type Answer } from "../features/remote/grants.js";
import { UploadInbox } from "../features/remote/uploads.js";
import { RemoteCreates } from "../features/remote/create.js";
import { TaskRequests } from "../features/remote/requests.js";

type Policy = { enabled: boolean; forwardTeamInbox: boolean };
const PHONE_ACCOUNTS_KEY = "phone.accounts";
const same = (a: DeviceRef, b: DeviceRef) => a.account === b.account && a.device === b.device;

/** Private LAN account domain. Never reads/writes the platform account or team remote metadata. */
export class PhoneRemote {
  private db: RelayStore | null = null;
  private server: RelayServer | null = null;
  private connections = new Map<string, PhoneConnection>();
  private lan = false;
  private error: string | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private watched = false;
  constructor(readonly host: HostService, private readonly port: number) {}
  private openDb(): RelayStore {
    if (!this.db) { const dir = join(dirname(this.host.store.path), "phone-server"); mkdirSync(dir, { recursive: true }); this.db = new RelayStore(join(dir, "relay.db")); }
    return this.db;
  }
  private policies(): Record<string, Policy> { try { return JSON.parse(this.host.store.getKv(PHONE_ACCOUNTS_KEY)?.value ?? "{}"); } catch { return {}; } }
  private save(policies: Record<string, Policy>): void { this.host.store.setKv(PHONE_ACCOUNTS_KEY, JSON.stringify(policies)); }
  active(name: string): boolean { return !!this.server && this.policies()[name]?.enabled === true; }
  private deviceId(): string {
    let id = this.host.store.getKv("phone.device")?.value;
    if (!id) { id = "d_phone_" + randomBytes(12).toString("hex"); this.host.store.setKv("phone.device", id); }
    return id;
  }
  accounts(): PhoneAccount[] {
    // Merely checking team cooperation must not create/open a phone database or hold a Windows file handle.
    if (!this.db && !existsSync(join(dirname(this.host.store.path), "phone-server", "relay.db"))) return [];
    const p = this.policies();
    return this.openDb().adminMembers().map((m) => ({ name: m.name, enabled: p[m.name]?.enabled === true && !m.disabled, forwardTeamInbox: p[m.name]?.forwardTeamInbox === true, devices: this.connections.get(m.name)?.peers().filter((x) => x.online).length ?? 0 }));
  }
  state(): CooperationState["server"] {
    const port = this.server?.port ?? null;
    const addresses = port === null ? [] : [`http://127.0.0.1:${port}`, ...(this.lan ? Object.values(networkInterfaces()).flatMap((all) => (all ?? []).filter((n) => !n.internal && n.family === "IPv4").map((n) => `http://${n.address}:${port}`)) : [])];
    return { running: !!this.server, lan: this.lan, port, addresses, invite: "", error: this.error, accounts: this.accounts() };
  }
  create(name: string, password: string, forwardTeamInbox = false): void {
    if (this.accounts().length >= 20) throw new HostError("bad_request", "最多创建 20 个手机账号");
    this.password(password);
    const db = this.openDb(), joined = db.register(name, password);
    db.logout(joined.key);
    this.save({ ...this.policies(), [joined.name]: { enabled: true, forwardTeamInbox } });
    this.connect(joined.name);
  }
  update(name: string, patch: { enabled?: boolean; password?: string; forwardTeamInbox?: boolean }): void {
    if (!this.accounts().some((a) => a.name === name)) throw new HostError("not_found", "没有这个手机账号");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean" || patch.forwardTeamInbox !== undefined && typeof patch.forwardTeamInbox !== "boolean") throw new HostError("bad_request", "账号开关无效");
    const previous = this.policies()[name] ?? { enabled: false, forwardTeamInbox: false };
    if (patch.password !== undefined) { this.password(patch.password); this.openDb().setPassword(name, patch.password); }
    const next = { enabled: patch.enabled ?? previous.enabled, forwardTeamInbox: patch.forwardTeamInbox ?? previous.forwardTeamInbox };
    this.save({ ...this.policies(), [name]: next });
    this.openDb().setDisabled(name, !next.enabled);
    if (patch.password !== undefined || !next.enabled) this.disconnect(name);
    this.connect(name); this.scheduleSync();
  }
  delete(name: string): void {
    if (!this.accounts().some((a) => a.name === name)) throw new HostError("not_found", "没有这个手机账号");
    const policies = this.policies(); delete policies[name]; this.save(policies);
    this.disconnect(name); this.openDb().deletePhoneMember(name);
    this.host.store.db.prepare("DELETE FROM kv WHERE key LIKE ?").run(this.namespace(name) + "%");
  }
  private password(value: string): void { if (typeof value !== "string" || value.length < 12 || value.length > 128) throw new HostError("bad_request", "手机账号密码需为 12–128 位"); }
  private namespace(name: string): string { return PHONE_REMOTE_PREFIX + createHash("sha256").update(name).digest("hex") + ":"; }
  scopedStore(name: string): Store {
    const prefix = this.namespace(name), store = this.host.store;
    return new Proxy(store, { get(target, prop) {
      if (prop === "getKv") return (key: string) => target.getKv(prefix + key);
      if (prop === "setKv") return (key: string, value: string) => target.setKv(prefix + key, value);
      const value = Reflect.get(target, prop, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  async start(lan: boolean): Promise<void> {
    await this.stop(); this.lan = lan;
    try {
      this.server = await startRelayServer({ store: this.openDb(), localPhoneOnly: true, host: lan ? "0.0.0.0" : "127.0.0.1", port: this.port, name: "WorkStudio 手机远程", minPasswordLength: 12 });
      this.error = null;
      // Older inbox tasks also obey selected-account routing before any phone receives grants.
      try { const mapping = JSON.parse(this.host.store.getKv("cooperation.inbox")?.value ?? "{}"); for (const item of Object.values(mapping) as Array<{ taskId?: string }>) if (item?.taskId) this.markTeamInbox(item.taskId); } catch { /* a malformed legacy map grants nothing extra */ }
      for (const account of this.accounts().filter((a) => a.enabled)) this.connect(account.name);
      this.host.on("event", this.onEvent); this.watched = true;
    } catch (e) { this.error = e instanceof Error ? e.message : String(e); await this.stop(); throw e; }
  }
  private connect(name: string): void {
    if (!this.server || !this.active(name) || this.connections.has(name)) return;
    const key = this.openDb().deviceKey(name);
    const conn = new PhoneConnection(this, this.server, { account: name, device: this.deviceId(), name: (this.host.teamLink.device?.name || "WorkStudio").slice(0, 30) + " · 手机远程" }, key);
    this.connections.set(name, conn); conn.start();
  }
  private disconnect(name: string): void {
    this.connections.get(name)?.stop(); this.connections.delete(name);
    this.server?.devices.dropAccount(name);
  }
  allowedTask(name: string, taskId: string): boolean {
    if (!this.active(name) || !this.host.cooperation.taskAllowed(taskId)) return false;
    const task = this.host.store.getTask(taskId); if (!task || task.remote) return false;
    const inbox = this.host.store.getKv("phone.team-inbox:" + taskId);
    return !inbox || this.policies()[name]?.forwardTeamInbox === true;
  }
  markTeamInbox(taskId: string): void { this.host.store.setKv("phone.team-inbox:" + taskId, "1"); this.scheduleSync(); }
  private onEvent = (event: HostEvent): void => {
    // Wait until inbox routing metadata is committed before granting a newly created task.
    if (event.type === "task.upserted" || event.type === "data.purged" || event.type === "profiles.updated") this.scheduleSync();
    for (const c of this.connections.values()) c.onHostEvent(event);
  };
  scheduleSync(): void {
    if (this.syncTimer || !this.server) return;
    this.syncTimer = setTimeout(() => { this.syncTimer = null; for (const c of this.connections.values()) c.syncGrants(); }, 30); this.syncTimer.unref();
  }
  async stop(lan?: boolean): Promise<void> {
    if (lan !== undefined) this.lan = lan;
    if (this.watched) this.host.off("event", this.onEvent); this.watched = false;
    if (this.syncTimer) clearTimeout(this.syncTimer); this.syncTimer = null;
    for (const name of [...this.connections.keys()]) this.disconnect(name);
    await this.server?.close(); this.server = null;
  }
  async close(): Promise<void> { await this.stop(); this.db?.close(); this.db = null; }
  releaseKey(key: string): void { this.db?.logout(key); }
}

class PhoneConnection {
  private readonly link: DeviceLink;
  private readonly ctx: RemoteContext;
  private readonly grants: RemoteGrants;
  private readonly inbox: UploadInbox;
  private readonly creates: RemoteCreates;
  private readonly requests: TaskRequests;
  private stopped = false;
  private readonly answered = new CommandLog<Answer>();
  private readonly inflight = new Map<string, Promise<Answer>>();
  constructor(private readonly phone: PhoneRemote, private readonly server: RelayServer, private readonly self: NamedDevice, private readonly key: string) {
    this.link = new DeviceLink({ server: server.url, key, device: { id: self.device, name: self.name } });
    this.ctx = {
      host: phone.host, store: phone.scopedStore(self.account), link: () => this.stopped ? null : this.link,
      ownAccount: () => self.account, deviceName: () => self.name, inbox: () => this.inbox,
      trustedOwnDevice: (p) => p.account === self.account && phone.active(p.account), includeArchived: true,
      canAccessTask: (p, taskId) => p.account === self.account && phone.allowedTask(self.account, taskId),
      assertEnabled: () => { if (this.stopped || !phone.active(self.account)) throw new HostError("read_only", "手机远程已关闭或账号已停用"); },
      peer: (ref, role) => { const p = this.peers().find((p) => same(p.peer, ref) && (!role || p.role === role)); return p ? { name: p.peer.name, online: p.online } : null; },
      ownerPeers: () => this.peers().filter((p) => p.role === "owner").map((p) => p.peer), changed: () => undefined,
    };
    this.grants = new RemoteGrants(this.ctx); this.inbox = new UploadInbox(this.ctx);
    this.requests = new TaskRequests(this.ctx, this.grants); this.creates = new RemoteCreates(this.ctx, this.grants, this.requests);
    this.link.on("event", (e) => { void this.event(e).catch((err) => phone.host.log("phone remote: " + (err instanceof Error ? err.message : String(err)))); });
    this.configure();
  }
  private configure(): void {
    this.grants.setAllowed({ profiles: this.phone.host.profiles.filter((p) => !p.hidden && !p.unavailable && p.runtime !== "remote").map((p) => p.id), permission: null });
    this.creates.setAllowedProjects({ workspaceIds: this.phone.host.store.listWorkspaces().filter((w) => !w.archivedAt && !isCommon(w)).map((w) => w.id), common: true });
    this.creates.setSecurity({ sameAccount: "run", otherAccount: "confirm" });
  }
  start(): void { this.link.start(); }
  stop(): void { this.stopped = true; this.link.stop(); this.creates.stop(); this.phone.releaseKey(this.key); }
  peers() { return this.server.devices.pairs(this.self).filter((p) => p.peer.account === this.self.account); }
  syncGrants(): void {
    if (this.stopped || !this.phone.active(this.self.account)) return;
    for (const g of this.grants.list()) if (!this.phone.allowedTask(this.self.account, g.taskId) || !this.peers().some((p) => p.role === "owner" && same(p.peer, g))) this.grants.revoke(g.taskId, g, "手机同步权限已收回");
    for (const peer of this.peers().filter((p) => p.role === "owner")) for (const task of this.phone.host.store.listTasks()) {
      if (this.phone.allowedTask(this.self.account, task.id) && !this.grants.list().some((g) => g.taskId === task.id && same(g, peer.peer))) this.grants.grant(task.id, peer.peer);
    }
  }
  onHostEvent(e: HostEvent): void {
    if (this.stopped) return;
    if (e.type === "profiles.updated") this.configure();
    this.grants.onHostEvent(e); this.creates.onHostEvent(e);
  }
  private async event(e: DeviceEvent): Promise<void> {
    if (this.stopped) return;
    if (e.type === "hello" || e.type === "pair-request") {
      for (const r of this.server.devices.requests(this.self).incoming.filter((r) => r.state === "pending")) this.server.devices.answer(this.self, r.id, r.from.account === this.self.account);
      this.syncGrants();
    } else if (e.type === "pair-answered" || e.type === "presence" || e.type === "unpaired") this.syncGrants();
    else if (e.type === "relay" && !e.re) this.frame(e);
  }
  private frame(f: RelayFrameIn): void {
    const reply = (answer: Answer) => { if (!this.stopped) this.link.send({ type: "relay", to: f.from, id: ("r_" + f.id).slice(0, 64), re: f.id, kind: answer.kind, body: answer.body }); };
    const old = this.answered.get(f.from, f.id); if (old) return reply(old);
    const key = f.from.account + "\n" + f.from.device + "\n" + f.id;
    const before = this.inflight.get(key); if (before) { void before.then(reply); return; }
    const work = this.answer(f).catch((e): Answer => ({ kind: "error", body: { code: e instanceof HostError ? e.code : "runtime_error", message: e instanceof Error ? e.message : String(e) } })).then((a) => { this.answered.remember(f.from, f.id, a); this.inflight.delete(key); return a; });
    this.inflight.set(key, work); void work.then(reply);
  }
  private async answer(f: RelayFrameIn): Promise<Answer> {
    this.ctx.assertEnabled!();
    if (f.from.account !== this.self.account || !this.ctx.peer(f.from, "owner")) throw new HostError("read_only", "这个设备不属于此手机账号");
    this.syncGrants();
    const b = f.body && typeof f.body === "object" ? f.body as Record<string, unknown> : {};
    if (f.kind === "ping") return { kind: "pong", body: { at: Date.now() } };
    if (f.kind === REMOTE_KINDS.catalog) return { kind: REMOTE_KINDS.ok, body: this.creates.serveCatalog(f.from) };
    if (f.kind === REMOTE_KINDS.createTemplates) return { kind: REMOTE_KINDS.ok, body: { templates: this.creates.templates(f.from, b.workspaceId) } };
    if (f.kind === REMOTE_KINDS.create) return { kind: REMOTE_KINDS.ok, body: await this.creates.create(f.from, b) };
    if (f.kind === REMOTE_KINDS.upload) return { kind: REMOTE_KINDS.ok, body: this.inbox.receive(f.from, b) };
    return this.grants.serve(f.from, f.kind, f.body);
  }
}
