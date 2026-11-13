import { inTurn, type CompanyAgent, type CompanyAgentInput, type CompanyDelivery, type CompanyEvolution, type CompanyMessage, type CompanyMessagePage, type CompanyRoom, type CompanySnapshot, type Id, type Session } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { HostError, isRemoteCopy } from "../../core/shared.js";
import { newId } from "../../store/store.js";
import { companyDefaults, CEO_ID } from "./defaults.js";
import { CompanyRepository } from "./repository.js";
import { readCompanyBootstrap, validateCompanyArchive } from "./bootstrap.js";
import { CompanyWorkManager } from "./work.js";

const now = () => new Date().toISOString();
function bad(text: string): never { throw new HostError("bad_request", text); }
const text = (v: unknown, name: string, max: number, empty = false): string => typeof v === "string" && (empty || !!v.trim()) && v.length <= max ? v.trim() : bad(`${name}必须是${empty ? "" : "非空"}文字，最多 ${max} 字符`);
const nullableId = (v: unknown, name: string): string | null => v === null || v === "" ? null : text(v, name, 200);
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : bad("请求必须是对象");

/** Local organization and group work. No native-history enumeration, remote forwarding, or arbitrary machine execution. */
export class CompanyFeature extends Feature<"sessions" | "tasks"> {
  private initialized = false;
  private recovered = false;
  private bootstrapSeen = "";
  private bootstrapWarnings: string[] = [];
  private queues = new Map<Id, Promise<unknown>>();
  readonly work = new CompanyWorkManager(this.host, this);
  private get repo(): CompanyRepository { return new CompanyRepository(this.store); }

  private ensure(): void {
    this.recover();
    if (!this.initialized) {
      this.store.transaction(() => {
        if (!this.repo.agents().length) {
          const defaults = companyDefaults(now());
          defaults.agents.forEach((a) => this.repo.putAgent(a));
          defaults.rooms.forEach((r) => this.repo.putRoom(r));
        }
        if (!this.store.getKv("company.platform-agent.v1")) {
          const platform = companyDefaults(now()).agents.find((a) => a.id === "company-platform")!;
          if (!this.repo.agent(platform.id)) this.repo.putAgent(platform);
          const room = this.repo.room("company-room-all");
          if (room && !room.memberIds.includes(platform.id)) this.repo.putRoom({ ...room, memberIds: [...room.memberIds, platform.id] });
          this.store.setKv("company.platform-agent.v1", now());
        }
      });
      this.initialized = true;
    }
    this.bootstrap();
  }

  /** Run before the inbox's startup drain. A persisted native request without an acknowledgement is never replayed. */
  private recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    this.store.transaction(() => {
      for (const m of this.repo.unsettled()) {
        m.deliveries = m.deliveries.map((d) => {
          if (!["pending", "queued", "sending"].includes(d.status)) return d;
          const item = d.inboxItemId ? this.store.getItem(d.inboxItemId) : undefined;
          if (d.status === "queued" && item?.type === "user" && item.delivery === "held") return d;
          if (item?.type === "user") {
            if (item.delivery === "held" || item.delivery === "waiting") this.store.replaceItem({ ...item, delivery: "unsent" });
            return { ...d, status: "unknown", error: "上次请求没有确认结果，可能已经送达。请先检查工作会话，再明确决定是否重新投递。" };
          }
          return { ...d, status: "failed", error: "上次投递在进入工作会话前中断，请检查配置后重试。" };
        });
        this.repo.putMessage(m);
      }
    });
  }

  private bootstrap(): void {
    try {
      const handoff = readCompanyBootstrap(this.store.path);
      if (!handoff || this.bootstrapSeen === handoff.digest) return;
      this.bootstrapSeen = handoff.digest;
      this.bootstrapWarnings = [];
      for (const entry of handoff.input.agents) {
        const key = `company.bootstrap:${handoff.digest}:${String(entry.id)}`;
        if (this.store.getKv(key)) continue;
        try {
          const before = this.repo.agent(entry.id);
          if (!before || before.kind !== "agent") bad("初始化只能关联已存在的 Agent");
          const archives = (entry.archives ?? []).map((a) => validateCompanyArchive(handoff.root, a));
          const first = !this.store.getKv(`company.bootstrap-agent:${entry.id}`);
          const patch: CompanyAgentInput = { ...(entry.name && first ? { name: entry.name } : {}), ...(entry.model && first ? { model: entry.model } : {}), ...(entry.profileId && !before.profileId && first ? { profileId: entry.profileId } : {}), ...(entry.workspaceId && !before.workspaceId && first ? { workspaceId: entry.workspaceId } : {}), ...(entry.matchTaskId && first ? { taskId: entry.matchTaskId } : {}), ...(entry.matchSessionId && first ? { sessionId: entry.matchSessionId } : {}) };
          const agent = this.checkedAgent(before, patch);
          agent.archives = [...before.archives.filter((a) => !archives.some((b) => a.id === b.id)), ...archives];
          this.store.transaction(() => { this.repo.putAgent(agent); this.store.setKv(key, now()); this.store.setKv(`company.bootstrap-agent:${entry.id}`, now()); });
        } catch (err) { const warning = `公司初始化未应用 ${String(entry.id)}：${String(err)}`; this.bootstrapWarnings.push(warning); this.log(warning); }
      }
    } catch (err) { const warning = `公司初始化未读取：${String(err)}`; if (!this.bootstrapWarnings.includes(warning)) { this.bootstrapWarnings.push(warning); this.log(warning); } }
  }

  snapshot(): CompanySnapshot {
    this.ensure();
    return { agents: this.repo.agents().map((a) => this.withStatus(a)), rooms: this.repo.rooms(), ...(this.bootstrapWarnings.length ? { bootstrapWarnings: [...this.bootstrapWarnings] } : {}) };
  }

  createAgent(input: unknown): CompanyAgent {
    this.ensure();
    const at = now();
    const base: CompanyAgent = { id: newId("agent"), name: "新Agent", role: "执行", kind: "agent", managerId: CEO_ID, description: "", instructions: "", instructionsVersion: 0, model: null, autonomous: true, allowEvolution: true, profileId: null, workspaceId: null, taskId: null, sessionId: null, machine: null, concurrency: 1, enabled: true, archives: [], status: "unconfigured", createdAt: at, updatedAt: at };
    const agent = this.checkedAgent(base, object(input));
    this.repo.putAgent(agent); this.changed();
    return this.withStatus(agent);
  }

  updateAgent(id: Id, input: unknown): CompanyAgent {
    this.ensure();
    const patch = object(input), before = this.agent(id);
    if (this.queues.has(id)) throw new HostError("conflict", "Agent 正在接收分工，请稍后保存设置");
    const bound = before.sessionId ? this.store.getSession(before.sessionId) : undefined;
    if (["sessionId", "profileId", "workspaceId", "taskId", "model", "enabled"].some((key) => patch[key] !== undefined && patch[key] !== (key === "model" ? before.model ?? null : before[key as keyof CompanyAgent])) && (this.repo.hasOutstanding(id) || (bound && inTurn(bound.status)) || (bound && this.f.sessions.inbox.companyBusy(bound.id)))) throw new HostError("conflict", "Agent 还有运行或排队中的群任务，结束后才能修改模型、工作绑定或停用");
    const agent = this.checkedAgent(before, patch);
    this.store.transaction(() => {
      if (agent.instructions !== before.instructions) this.recordRevision(before, agent, "人工调整工作规范", CEO_ID, null);
      this.repo.putAgent(agent);
    }); this.changed();
    return this.withStatus(agent);
  }

  private checkedAgent(before: CompanyAgent, input: CompanyAgentInput | Record<string, unknown>): CompanyAgent {
    const p = input as Record<string, unknown>;
    const allowed = new Set(["name", "role", "managerId", "description", "instructions", "profileId", "workspaceId", "taskId", "sessionId", "machine", "enabled", "model", "autonomous", "allowEvolution", "expectedInstructionsVersion"]);
    if (Object.keys(p).some((k) => !allowed.has(k))) bad("Agent 设置包含不支持的字段");
    const a: CompanyAgent = { ...before, updatedAt: now() };
    if (p.expectedInstructionsVersion !== undefined && p.expectedInstructionsVersion !== (before.instructionsVersion ?? 0)) throw new HostError("conflict", "工作规范已有新版本，请刷新后再保存");
    if (p.model !== undefined) a.model = nullableId(p.model, "模型");
    for (const k of ["autonomous", "allowEvolution"] as const) if (p[k] !== undefined) { if (typeof p[k] !== "boolean") bad(`${k}必须是布尔值`); a[k] = p[k] as boolean; }
    for (const k of ["name", "role", "description", "instructions"] as const) if (p[k] !== undefined) a[k] = text(p[k], k, k === "instructions" ? 20_000 : k === "description" ? 4000 : 100, k === "description" || k === "instructions");
    for (const k of ["managerId", "profileId", "workspaceId", "taskId", "sessionId"] as const) if (p[k] !== undefined) a[k] = nullableId(p[k], k);
    if (p.enabled !== undefined) { if (typeof p.enabled !== "boolean") bad("enabled必须是布尔值"); a.enabled = p.enabled; }
    if (p.machine !== undefined) {
      if (p.machine === null) a.machine = null;
      else { const m = object(p.machine); if (!["high", "low", "other"].includes(String(m.capacity))) bad("机器规格无效"); a.machine = { label: text(m.label, "机器名称", 100), address: text(m.address, "机器地址", 300, true), capacity: m.capacity as "high" | "low" | "other" }; }
    }
    if (a.kind === "human" && (!a.enabled || a.sessionId || a.profileId || a.workspaceId || a.taskId || a.managerId || a.machine || a.model)) bad("CEO 是人，只编辑姓名、职责与说明");
    const seen = new Set([a.id]); let managerId = a.managerId;
    while (managerId) { if (seen.has(managerId)) bad("汇报关系不能形成循环"); seen.add(managerId); const manager = this.repo.agent(managerId); if (!manager) bad("汇报对象不存在"); managerId = manager.managerId; }
    if (a.sessionId) {
      const s = this.localSession(a.sessionId);
      if (p.sessionId !== undefined) {
        if (p.profileId === undefined) a.profileId = s.profileId;
        if (p.workspaceId === undefined) a.workspaceId = s.workspaceId;
        if (p.taskId === undefined) a.taskId = s.taskId;
      }
      if (s.profileId !== a.profileId || s.workspaceId !== a.workspaceId || s.taskId !== a.taskId) bad("绑定会话与所选模型、项目或任务不一致；请先解除会话绑定");
      if (this.repo.agents().some((other) => other.id !== a.id && other.sessionId === s.id)) bad("这个工作会话已被另一位 Agent 绑定");
    }
    if (a.taskId) {
      const task = this.requireTask(a.taskId);
      if (task.archivedAt || task.remote || !this.host.cooperation.taskAllowed(task.id)) throw new HostError("read_only", "只能关联 WorkStudio 本机自建且未归档的任务");
      if (p.taskId !== undefined && p.workspaceId === undefined && !a.sessionId) a.workspaceId = task.workspaceId;
      if (task.workspaceId !== a.workspaceId) bad("绑定任务与所选项目不一致");
    }
    if (a.profileId) { const profile = this.requireProfile(a.profileId); if (profile.runtime === "remote" || profile.hidden || profile.unavailable) bad("Agent 只能使用当前可用的本机模型渠道"); }
    if (a.workspaceId) this.requireLiveWorkspace(a.workspaceId);
    return a;
  }

  createRoom(input: unknown): CompanyRoom {
    this.ensure(); const at = now();
    const r = this.checkedRoom({ id: newId("company-room"), name: "新协作群", description: "", memberIds: [CEO_ID], createdAt: at, updatedAt: at }, object(input));
    this.repo.putRoom(r); this.changed(); return r;
  }
  updateRoom(id: Id, input: unknown): CompanyRoom {
    this.ensure(); const r = this.checkedRoom(this.room(id), object(input)); this.repo.putRoom(r); this.changed(); return r;
  }
  private checkedRoom(before: CompanyRoom, p: Record<string, unknown>): CompanyRoom {
    if (Object.keys(p).some((k) => !["name", "description", "memberIds"].includes(k))) bad("群设置包含不支持的字段");
    const r = { ...before, updatedAt: now() };
    if (p.name !== undefined) r.name = text(p.name, "群名称", 100);
    if (p.description !== undefined) r.description = text(p.description, "群说明", 4000, true);
    if (p.memberIds !== undefined) {
      if (!Array.isArray(p.memberIds) || p.memberIds.length > 100 || p.memberIds.some((id) => typeof id !== "string" || !this.repo.agent(id))) bad("群成员无效");
      r.memberIds = [...new Set([CEO_ID, ...p.memberIds as string[]])];
      if (before.memberIds.some((id) => { const agent = this.repo.agent(id); return !r.memberIds.includes(id) && (this.repo.hasOutstanding(id) || !!agent?.sessionId && this.f.sessions.inbox.companyBusy(agent.sessionId)); })) throw new HostError("conflict", "成员还有排队中的群任务或尚未结束的执行，完成后才能移出群");
    }
    return r;
  }

  messages(roomId: Id, before?: string, limit: unknown = 50, callerSessionId?: Id): CompanyMessagePage {
    this.ensure(); const r = this.room(roomId);
    if (callerSessionId) this.member(r, this.caller(callerSessionId).id);
    const count = Number(limit);
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) bad("每页消息数量必须在 1 到 100 之间");
    if (before && this.repo.message(before)?.roomId !== roomId) bad("分页位置不属于这个群");
    return this.repo.page(roomId, before, count);
  }

  /** The caller learns only their own identity and member-visible group roster, never profiles/prompts/archive paths. */
  groupsFor(callerSessionId: Id) {
    this.ensure(); const own = this.caller(callerSessionId);
    const rooms = this.repo.rooms().filter((r) => r.memberIds.includes(own.id));
    const visible = new Set(rooms.flatMap((r) => r.memberIds));
    return { self: { id: own.id, name: own.name, role: own.role }, rooms, members: this.repo.agents().filter((a) => visible.has(a.id)).map((a) => ({ id: a.id, name: a.name, role: a.role, kind: a.kind, status: this.withStatus(a).status })) };
  }

  async send(roomId: Id, input: unknown, callerSessionId?: Id): Promise<CompanyMessage> {
    this.ensure(); const r = this.room(roomId), p = object(input);
    if (Object.keys(p).some((k) => !["text", "mentions", "replyTo", "clientMessageId"].includes(k))) bad("消息包含不支持的字段；发送者由当前身份确定");
    const sender = callerSessionId ? this.caller(callerSessionId) : this.agent(CEO_ID);
    this.member(r, sender.id);
    const clientMessageId = text(p.clientMessageId, "clientMessageId", 200);
    const duplicate = this.repo.duplicate(roomId, sender.id, clientMessageId);
    if (duplicate) return duplicate;
    const body = text(p.text, "消息", 20_000);
    const mentions = p.mentions === undefined ? [] : p.mentions;
    if (!Array.isArray(mentions) || mentions.length > 30 || mentions.some((id) => typeof id !== "string" || !r.memberIds.includes(id))) bad("只能 @ 这个群里的成员");
    const ids = [...new Set(mentions as string[])];
    const replyTo = p.replyTo === undefined || p.replyTo === null ? null : text(p.replyTo, "replyTo", 200);
    const parent = replyTo ? this.repo.message(replyTo) : undefined;
    if (replyTo && parent?.roomId !== roomId) bad("回复目标不属于这个群");
    let hop = 0;
    if (sender.kind === "agent") {
      if (!parent || !parent.mentions.includes(sender.id)) bad("Agent 发消息必须 replyTo 一条明确 @ 自己的群消息");
      hop = parent.hop + 1;
      if (hop > 4 && ids.some((id) => this.agent(id).kind === "agent")) bad("这条分工链已达到 4 次自动转交上限，请向 CEO 汇报并等待新的指令");
      if (ids.includes(sender.id)) bad("Agent 不能通过 @ 自己反复启动任务");
      if (ids.some((id) => this.agent(id).kind === "agent") && this.repo.replies(parent.id, sender.id).some((reply) => reply.mentions.some((id) => this.agent(id).kind === "agent"))) bad("这条群任务已转交过一次；继续说明请发普通汇报，新的分工等待新消息");
    }
    const m: CompanyMessage = { id: newId("company-message"), roomId, senderId: sender.id, text: body, mentions: ids, replyTo, clientMessageId, createdAt: now(), hop, deliveries: ids.filter((id) => this.agent(id).kind === "agent").map((agentId) => ({ agentId, status: "pending", sessionId: null, taskId: null })) };
    this.repo.add(m); this.changed();
    await Promise.all(m.deliveries.map((d) => this.dispatch(m.id, d.agentId)));
    return this.repo.message(m.id)!;
  }

  async retry(roomId: Id, messageId: Id, agentId: unknown, confirmUnknown = false): Promise<CompanyMessage> {
    this.ensure(); const m = this.repo.message(messageId);
    if (!m || m.roomId !== roomId) throw new HostError("not_found", "群消息不存在");
    const d = m.deliveries.find((item) => item.agentId === agentId);
    if (!d || (d.status !== "failed" && d.status !== "unknown")) bad("只有投递失败或结果待核查的消息可重试");
    if (d.status === "unknown" && !confirmUnknown) throw new HostError("conflict", "上次可能已经送达，请先检查工作会话并明确确认重新投递");
    this.member(this.room(roomId), d.agentId);
    if (d.inboxItemId) this.f.sessions.inbox.releaseCompany(d.inboxItemId);
    this.updateDelivery(messageId, d.agentId, { status: "pending", error: undefined });
    await this.dispatch(messageId, d.agentId);
    return this.repo.message(messageId)!;
  }

  private dispatch(messageId: Id, agentId: Id): Promise<void> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.deliver(messageId, agentId));
    this.queues.set(agentId, next);
    void next.finally(() => { if (this.queues.get(agentId) === next) this.queues.delete(agentId); });
    return next;
  }
  private async deliver(messageId: Id, agentId: Id): Promise<void> {
    try {
      const m = this.repo.message(messageId)!;
      this.member(this.room(m.roomId), agentId);
      let a = this.agent(agentId);
      if (!a.enabled) throw new HostError("read_only", "Agent 已停用，消息未启动任务");
      if (!a.profileId || !a.workspaceId) bad("请先为 Agent 配置模型渠道和工作项目");
      const profile = this.requireProfile(a.profileId);
      if (profile.hidden || profile.unavailable) bad("Agent 的模型渠道当前不可用");
      this.requireLiveWorkspace(a.workspaceId);
      if (!a.sessionId) {
        if (!a.taskId) {
          const made = await this.f.tasks.createTask({ title: `${a.name} · 工作会话`, workspaceId: a.workspaceId, column: "todo" });
          a = { ...a, taskId: made.task.id, updatedAt: now() }; this.repo.putAgent(a);
        }
        if (a.model) await this.checkModel(a);
        const s = await this.f.tasks.addSession(a.taskId!, { profileId: a.profileId!, options: a.model ? { model: a.model } : {} });
        a = this.checkedAgent(a, { sessionId: s.id });
        this.repo.putAgent(a); this.changed();
      }
      const s = this.localSession(a.sessionId!);
      if (s.taskId !== a.taskId || s.profileId !== a.profileId || s.workspaceId !== a.workspaceId) bad("Agent 绑定已变化，请重新配置工作会话");
      this.updateDelivery(messageId, agentId, { taskId: s.taskId, sessionId: s.id });
      const sender = this.agent(m.senderId), room = this.room(m.roomId);
      const instruction = [
        `【公司协作群任务】你是 ${a.name}（agentId: ${a.id}），职责：${a.role}。`,
        a.description, a.instructions,
        a.managerId ? `汇报对象：${this.agent(a.managerId).name}（agentId: ${a.managerId}）。` : "",
        a.machine ? `机器说明：${a.machine.label}；地址：${a.machine.address || "尚未配置"}。这是人工配置的说明，不代表已验证连通性或可用资源。` : "",
        `群：${room.name}（roomId: ${room.id}）；发送者：${sender.name}；消息ID：${m.id}。`,
        "这是一条明确 @ 你的群消息。请在当前工作会话内完成分工；不会打断之前的一轮任务。机器地址仅为说明，操作仍须遵守项目授权与构建规则。",
        "使用 company_group_read 获取当前群成员 agentId。完成或需要交接时使用 company_message_send 回复本群，replyTo 填本消息ID；mentions 只填需要接手的群成员 agentId。普通汇报可 mentions: []。不要用重复 @ 形成循环；最多自动转交4次。",
        "有工作列表编号时，用 company_work_report 更新进度、完成验收或转交同事；成功交付后可用 company_self_improve 保存有依据的工作规范改进，带上 workId 和当前版本号。自主执行限于已分配目标和项目约定，不自行扩大权限或重复未知结果的操作。",
        `工作规范版本：${a.instructionsVersion ?? 0}；允许自我改进：${a.allowEvolution !== false ? "是" : "否"}。`,
        "历史归档仅供本机人查看，未自动送入上下文；不得自行向其他会话或设备复制归档内容。", "", m.text,
      ].filter(Boolean).join("\n");
      await this.f.sessions.inbox.put(s.id, instruction, { separateTurn: true, onQueued: (inboxItemId) => this.updateDelivery(messageId, agentId, { status: "queued", inboxItemId }) });
    } catch (err) {
      const previous = this.repo.message(messageId)?.deliveries.find((d) => d.agentId === agentId);
      this.updateDelivery(messageId, agentId, { status: previous?.status === "sending" ? "unknown" : "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Recover assigned work; only an explicit queued objective may start model work after the session is free. */
  watch(): void {
    this.recover();
    this.f.sessions.inbox.prepareCompany = async (sessionId) => {
      const a = this.repo.agents().find((a) => a.sessionId === sessionId);
      if (!a?.model) return;
      const s = this.localSession(sessionId);
      if (inTurn(s.status)) throw new HostError("conflict", "Agent 忙碌，模型设置等待下一项任务");
      const model = await this.checkModel(a);
      const current = this.localSession(sessionId);
      if (inTurn(current.status)) throw new HostError("conflict", "当前会话已开始另一项工作，等待空闲后再派发");
      if (current.options.model !== a.model) await this.runtime.setOptions(s.id, { ...current.options, model: a.model, effort: model.efforts.includes(current.options.effort ?? "") ? current.options.effort : model.defaultEffort });
    };
    this.f.sessions.inbox.onDelivery((delivery) => {
      for (const m of this.repo.forInboxItem(delivery.itemId)) for (const d of m.deliveries.filter((d) => d.inboxItemId === delivery.itemId)) {
        this.updateDelivery(m.id, d.agentId, { status: delivery.state, error: delivery.state === "unknown" ? `请求未确认，可能已送达，请先检查工作会话：${delivery.error ?? "连接中断"}` : delivery.error });
      }
    });
    this.host.on("event", (event) => {
      if (!this.initialized) return;
      if (event.type === "session.upserted" && this.repo.agents().some((a) => a.sessionId === event.session.id)) this.changed();
    });
    this.work.watch();
  }
  private async checkModel(a: CompanyAgent) {
    const choices = await this.runtime.choices(a.profileId!);
    const model = choices.models.find((m) => m.id === a.model);
    if (!model) bad("Agent 选择的模型当前不可用，请在 Agent 管理中重新选择");
    return model;
  }
  identity(sessionId: Id): CompanyAgent { this.ensure(); return this.caller(sessionId); }
  availableForWork(id: Id): boolean {
    const a = this.agent(id);
    return !this.queues.has(id) && !this.repo.hasOutstanding(id) && this.withStatus(a).status === "ready" && (!a.sessionId || !this.f.sessions.inbox.companyBusy(a.sessionId));
  }
  revisions(id: Id): CompanyEvolution[] { this.ensure(); this.agent(id); return this.repo.revisions(id); }
  private recordRevision(before: CompanyAgent, after: CompanyAgent, reason: string, actorId: Id, workId: Id | null): void {
    after.instructionsVersion = (before.instructionsVersion ?? 0) + 1;
    this.repo.addRevision({ id: newId("evolution"), agentId: before.id, before: before.instructions, after: after.instructions, version: after.instructionsVersion, reason, actorId, workId, createdAt: now() });
  }
  evolve(sessionId: Id, input: unknown): CompanyAgent {
    const a = this.identity(sessionId), p = object(input);
    if (Object.keys(p).some((k) => !["workId", "instructions", "reason", "expectedVersion"].includes(k))) bad("只能改进自己的工作规范，不能修改身份或权限");
    if (a.allowEvolution === false) throw new HostError("read_only", "这个 Agent 已关闭自我改进");
    const w = this.repo.work(text(p.workId, "workId", 200));
    if (!w || w.agentId !== a.id || w.status !== "done") bad("改进必须引用自己已完成的工作");
    if (p.expectedVersion !== (a.instructionsVersion ?? 0)) throw new HostError("conflict", "工作规范已有新版本，请先读取自己的最新版本");
    const next = { ...a, instructions: text(p.instructions, "工作规范", 20_000), updatedAt: now() };
    if (next.instructions === a.instructions) return a;
    const reason = text(p.reason, "改进依据", 4000);
    this.store.transaction(() => { this.recordRevision(a, next, reason, a.id, w.id); this.repo.putAgent(next); }); this.changed(); return next;
  }
  rollback(id: Id, revisionId: Id, expectedVersion: unknown): CompanyAgent {
    this.ensure(); const a = this.agent(id), revision = this.repo.revision(revisionId);
    if (!revision || revision.agentId !== id) bad("改进版本不属于这个 Agent");
    if (expectedVersion !== (a.instructionsVersion ?? 0)) throw new HostError("conflict", "版本已变化，请刷新后再撤回");
    const next = { ...a, instructions: revision.before, updatedAt: now() };
    this.store.transaction(() => { this.recordRevision(a, next, `撤回第 ${revision.version} 次改进`, CEO_ID, revision.workId); this.repo.putAgent(next); }); this.changed(); return next;
  }
  private updateDelivery(messageId: Id, agentId: Id, patch: Partial<CompanyDelivery>): void {
    const m = this.repo.message(messageId); if (!m) return;
    m.deliveries = m.deliveries.map((d) => d.agentId === agentId ? { ...d, ...patch } : d);
    this.repo.putMessage(m); this.changed();
  }
  private agent(id: Id): CompanyAgent { const a = this.repo.agent(id); if (!a) throw new HostError("not_found", "Agent 不存在"); return a; }
  private room(id: Id): CompanyRoom { const r = this.repo.room(id); if (!r) throw new HostError("not_found", "群不存在"); return r; }
  private member(room: CompanyRoom, id: Id): void { if (!room.memberIds.includes(id)) throw new HostError("read_only", "该身份不是这个群的成员"); }
  private caller(sessionId: Id): CompanyAgent {
    const session = this.localSession(sessionId);
    const a = this.repo.agents().find((a) => a.sessionId === sessionId && a.kind === "agent" && a.enabled);
    if (!a) throw new HostError("read_only", "当前会话没有已启用的公司 Agent 身份");
    if (session.profileId !== a.profileId || session.workspaceId !== a.workspaceId || session.taskId !== a.taskId) throw new HostError("read_only", "当前会话与 Agent 工作绑定不一致");
    return a;
  }
  private localSession(id: Id): Session {
    const s = this.requireSession(id), task = s.taskId ? this.requireTask(s.taskId) : undefined;
    if (!task || task.archivedAt || task.remote || s.archivedAt || s.kind === "sub" || isRemoteCopy(s) || s.writer === "archived" || !this.host.cooperation.taskAllowed(task.id)) throw new HostError("read_only", "只能绑定 WorkStudio 本机自建、未归档的主会话或分支");
    return s;
  }
  private withStatus(a: CompanyAgent): CompanyAgent {
    if (a.kind === "human") return { ...a, status: "human" };
    if (!a.enabled) return { ...a, status: "disabled" };
    if (!a.profileId || !a.workspaceId) return { ...a, status: "unconfigured" };
    const profile = this.profiles.find((p) => p.id === a.profileId);
    const workspace = this.store.getWorkspace(a.workspaceId);
    if (!profile || profile.hidden || profile.unavailable || !workspace || workspace.archivedAt) return { ...a, status: "error" };
    if (!a.sessionId) return { ...a, status: "ready" };
    try {
      const s = this.localSession(a.sessionId);
      return { ...a, status: s.status === "running" ? "running" : s.status.startsWith("awaiting-") || s.writer === "terminal-handoff" ? "waiting" : s.status === "error" || s.status === "interrupted" ? "error" : "ready" };
    } catch { return { ...a, status: "error" }; }
  }
  private changed(): void { this.publish({ type: "company.changed" }); }
}
