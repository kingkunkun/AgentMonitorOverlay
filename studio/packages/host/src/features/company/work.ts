import { inTurn, type CompanyAgent, type CompanyWork, type CompanyWorkAttachment, type CompanyWorkPriority, type CompanyWorkReport, type Id } from "@amo-studio/protocol";
import { Feature, type FeatureHost } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";
import { newId } from "../../store/store.js";
import { CompanyRepository } from "./repository.js";
import type { CompanyFeature } from "./service.js";

const now = () => new Date().toISOString();
const fail = (message: string): never => { throw new HostError("bad_request", message); };
const str = (v: unknown, label: string, max: number, empty = false): string => typeof v === "string" && (empty || !!v.trim()) && v.length <= max ? v.trim() : fail(`${label}格式无效，最多 ${max} 字符`);
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail("请求必须是对象");
const rank: Record<CompanyWorkPriority, number> = { high: 0, medium: 1, low: 2 };
const MODES = ["agent", "new"] as const;
function workAttachments(v: unknown): CompanyWorkAttachment[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) fail("附件最多 20 个");
  return v.map((raw) => {
    const a = obj(raw);
    return {
      id: str(a.id, "附件编号", 200),
      name: str(a.name, "附件名称", 200),
      mime: str(a.mime ?? "application/octet-stream", "附件类型", 200, true) || "application/octet-stream",
      size: typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? Math.floor(a.size) : 0,
      path: str(a.path, "附件路径", 600),
    };
  });
}
function workMode(v: unknown): "agent" | "new" | undefined {
  if (v === undefined) return undefined;
  if (!MODES.includes(v as "agent" | "new")) fail("执行位置只能是原对话或新聊天");
  return v as "agent" | "new";
}
export const sortCompanyWork = (work: readonly CompanyWork[]) => [...work].sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt));

/** Assigned objectives are durable; the scheduler never invents new work or replays an uncertain native request. */
export class CompanyWorkManager extends Feature<"sessions" | "tasks"> {
  private pending = false;
  private pumping = false;
  private rerun = false;
  private get repo() { return new CompanyRepository(this.store); }
  constructor(host: FeatureHost<"sessions" | "tasks">, private readonly company: CompanyFeature) { super(host); }
  list(sessionId?: Id): CompanyWork[] {
    this.company.snapshot();
    const own = sessionId ? this.company.identity(sessionId) : null;
    return sortCompanyWork(this.repo.works().filter((w) => !own || w.agentId === own.id));
  }
  readSelf(sessionId: Id) {
    const a = this.company.identity(sessionId);
    const own = this.list(sessionId), active = own.filter((w) => !["done", "cancelled"].includes(w.status)), history = own.filter((w) => ["done", "cancelled"].includes(w.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { agentId: a.id, instructions: a.instructions, instructionsVersion: a.instructionsVersion ?? 0, allowEvolution: a.allowEvolution !== false, work: [...active, ...history].slice(0, 200) };
  }
  private require(id: Id): CompanyWork { const w = this.repo.work(id); if (!w) throw new HostError("not_found", "工作不存在"); return w; }
  private assignee(agentId: unknown, roomId: unknown) {
    const { agents, rooms } = this.company.snapshot();
    const a = agents.find((a) => a.id === agentId && a.kind === "agent" && a.enabled);
    const r = rooms.find((r) => r.id === roomId);
    if (!a || !r || !r.memberIds.includes(a.id)) throw new HostError("bad_request", "请选择汇报群中已启用的 Agent");
    return a;
  }
  create(input: unknown): CompanyWork {
    const p = obj(input);
    if (Object.keys(p).some((k) => !["title", "description", "acceptance", "priority", "agentId", "roomId", "clientId", "attachments", "sessionMode"].includes(k))) fail("工作包含不支持的字段");
    const clientId = str(p.clientId, "clientId", 200);
    const duplicate = this.repo.workByClient(clientId); if (duplicate) return duplicate;
    this.assignee(p.agentId, p.roomId);
    if (!["high", "medium", "low"].includes(String(p.priority))) fail("优先级必须是低、中或高");
    const at = now();
    const w: CompanyWork = { id: newId("work"), title: str(p.title, "标题", 120), description: str(p.description ?? "", "工作内容", 12_000, true), acceptance: str(p.acceptance ?? "", "验收条件", 4000, true), priority: p.priority as CompanyWorkPriority, agentId: p.agentId as Id, roomId: p.roomId as Id, status: "queued", report: "", messageId: null, attempt: 0, handoffs: 0, createdAt: at, updatedAt: at, clientId, attachments: workAttachments(p.attachments), sessionMode: workMode(p.sessionMode) ?? "agent" };
    this.save(w); return w;
  }
  update(id: Id, input: unknown): CompanyWork {
    const w = this.require(id), p = obj(input);
    if (w.status !== "queued") throw new HostError("conflict", "只有未派发的工作可修改；正在执行的工作通过群聊沟通");
    if (Object.keys(p).some((k) => !["title", "description", "acceptance", "priority", "agentId", "attachments", "sessionMode"].includes(k))) fail("工作包含不支持的字段");
    const next = { ...w };
    if (p.title !== undefined) next.title = str(p.title, "标题", 120);
    if (p.description !== undefined) next.description = str(p.description, "内容", 12_000, true);
    if (p.acceptance !== undefined) next.acceptance = str(p.acceptance, "验收条件", 4000, true);
    if (p.priority !== undefined) { if (!["high", "medium", "low"].includes(String(p.priority))) fail("优先级无效"); next.priority = p.priority as CompanyWorkPriority; }
    if (p.agentId !== undefined) { this.assignee(p.agentId, w.roomId); next.agentId = p.agentId as Id; }
    if (p.attachments !== undefined) next.attachments = workAttachments(p.attachments);
    if (p.sessionMode !== undefined) next.sessionMode = workMode(p.sessionMode) ?? "agent";
    this.save(next); return next;
  }
  async action(id: Id, input: unknown): Promise<CompanyWork> {
    const w = this.require(id), p = obj(input);
    if (Object.keys(p).some((k) => !["action", "confirmUnknown"].includes(k))) fail("工作操作包含不支持的字段");
    if (p.action === "cancel") {
      if (!["queued", "blocked"].includes(w.status)) throw new HostError("conflict", "请先在工作会话中停止执行，再取消跟踪");
      const d = w.messageId ? this.repo.message(w.messageId)?.deliveries.find((d) => d.agentId === w.agentId) : null;
      if (d && ["pending", "queued", "sending", "unknown"].includes(d.status)) throw new HostError("conflict", "请先核查或停止工作会话中的投递，不能只取消列表记录");
      if (d?.sessionId && inTurn(this.requireSession(d.sessionId).status)) throw new HostError("conflict", "工作会话仍在运行，请先在会话中停止或等待结束");
      this.save({ ...w, status: "cancelled" }); return this.require(id);
    }
    if (p.action === "retry") {
      if (w.status !== "blocked") throw new HostError("conflict", "只有受阻工作可以重试");
      const old = w.messageId ? this.repo.message(w.messageId) : null;
      const d = old?.deliveries.find((d) => d.agentId === w.agentId);
      if (d?.status === "unknown" && p.confirmUnknown !== true) throw new HostError("conflict", "上次投递结果未知，请先核查工作会话并明确确认重试");
      if (d?.inboxItemId && ["unknown", "failed"].includes(d.status)) this.f.sessions.inbox.releaseCompany(d.inboxItemId);
      if (d && ["pending", "queued", "sending"].includes(d.status)) throw new HostError("conflict", "原消息还在投递，不能重复启动");
      if (old && d?.status === "unknown") this.repo.putMessage({ ...old, deliveries: old.deliveries.map((entry) => entry === d ? { ...entry, status: "failed", error: `已由人工核查并确认重新派发；原结果：${entry.error ?? "未知"}` } : entry) });
      this.save({ ...w, status: "queued", messageId: null, report: "", manualStart: true, outcomeUnknown: false });
    } else if (p.action === "start" && w.status === "queued") this.save({ ...w, manualStart: true });
    else fail("不支持这个工作操作");
    await this.pump(); return this.require(id);
  }
  private save(w: CompanyWork): void { this.repo.putWork({ ...w, updatedAt: now() }); this.publish({ type: "company.changed" }); this.schedule(); }
  private block(w: CompanyWork, report: string, outcomeUnknown = false): void {
    this.store.transaction(() => {
      const key = `work-failed:${w.id}:${w.attempt}`;
      if (this.repo.room(w.roomId) && !this.repo.duplicate(w.roomId, "company-ceo", key)) this.repo.add({ id: newId("company-message"), workId: w.id, roomId: w.roomId, senderId: "company-ceo", text: `【系统派发受阻】${w.title}\n${report}`, mentions: [], replyTo: w.messageId, clientMessageId: key, createdAt: now(), hop: 0, deliveries: [] });
      this.repo.putWork({ ...w, status: "blocked", report, outcomeUnknown, updatedAt: now() });
    });
    this.publish({ type: "company.changed" }); this.schedule();
  }
  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; if (this.store.db.isOpen) void this.pump().catch((err) => { if (this.store.db.isOpen) this.log(`工作列表调度失败：${String(err)}`); }); });
  }
  watch(): void {
    this.host.on("event", (e) => { if (["company.changed", "session.upserted", "profiles.updated", "workspace.upserted", "task.upserted"].includes(e.type)) this.schedule(); });
    this.schedule();
  }
  /** Public for isolated tests; no timers, model polling or background turns when no assigned work exists. */
  async pump(): Promise<void> {
    if (!this.store.db.isOpen) return;
    if (this.pumping) { this.rerun = true; return; }
    this.pumping = true;
    try {
      this.company.snapshot();
      for (const w of this.repo.works().filter((w) => w.status === "dispatching" || w.status === "running")) await this.reconcile(w);
      for (const candidate of sortCompanyWork(this.repo.works().filter((w) => w.status === "queued"))) {
        const w = this.require(candidate.id);
        if (w.status !== "queued") continue;
        let a = this.company.snapshot().agents.find((a) => a.id === w.agentId);
        if (!a || !a.enabled || (a.autonomous === false && !w.manualStart)) continue;
        if (this.repo.works().some((other) => other.id !== w.id && other.agentId === a.id && ["running", "dispatching"].includes(other.status))) continue;
        if (!this.company.availableForWork(a.id)) continue;
        if (w.sessionMode === "new") a = await this.freshSession(a);
        const attempt = w.attempt + 1;
        this.save({ ...w, attempt, status: "dispatching", report: "", outcomeUnknown: false });
        try {
          const m = await this.company.send(w.roomId, { text: [`【工作列表】${w.title}`, `工作编号：${w.id}；优先级：${w.priority}。`, w.description, this.attachmentsText(w), w.report ? `交接说明：${w.report.slice(0, 2800)}${w.report.length > 2800 ? "\n完整说明见本群工作交接消息。" : ""}` : "", `验收条件：${w.acceptance || "说明交付内容和验证结果"}`, "请自主完成已分配目标。用 company_work_report 汇报进度；验收通过后 action=done，遇阻 action=blocked，交接 action=handoff 并指定 agentId。不要只发文字而不更新工作状态。"].join("\n"), mentions: [w.agentId], clientMessageId: `work:${w.id}:${attempt}` });
          const current = this.require(w.id);
          if (current.status === "dispatching") { this.save({ ...current, messageId: m.id, status: "running" }); await this.reconcile(this.require(w.id)); }
        } catch (err) { const current = this.require(w.id); if (current.status === "dispatching") this.block(current, String(err)); }
      }
    } finally { this.pumping = false; if (this.rerun) { this.rerun = false; this.schedule(); } }
  }
  /** 附件路径随派发一并给出，Agent 可以直接读取本机文件。 */
  private attachmentsText(w: CompanyWork): string {
    if (!w.attachments?.length) return "";
    return ["附件（本机路径，可直接读取）：", ...w.attachments.map((f) => `- ${f.name} → ${f.path}`)].join("\n");
  }
  /** 工作指定“新建聊天任务”时换一个干净会话；Agent 仍只绑定一个会话，所以先切换绑定再派发。 */
  private async freshSession(a: CompanyAgent): Promise<CompanyAgent> {
    if (!a.sessionId || !a.taskId || !a.profileId) return a;
    const s = await this.f.tasks.addSession(a.taskId, { profileId: a.profileId, options: a.model ? { model: a.model } : {} });
    const next: CompanyAgent = { ...a, sessionId: s.id, updatedAt: now() };
    this.repo.putAgent(next); this.publish({ type: "company.changed" });
    return next;
  }
  private async reconcile(w: CompanyWork): Promise<void> {
    const m = w.messageId ? this.repo.message(w.messageId) : this.repo.duplicate(w.roomId, "company-ceo", `work:${w.id}:${w.attempt}`);
    if (!m) { if (w.status === "dispatching") this.block(w, "上次派发在确认前中断，请核查群聊后重试。"); return; }
    const d = m.deliveries.find((d) => d.agentId === w.agentId);
    if (!d) { this.block(w, "派发消息缺少对应 Agent，请核查群成员。"); return; }
    if (w.messageId !== m.id || w.status === "dispatching") { w = { ...w, messageId: m.id, status: "running" }; this.save(w); }
    if (d.status === "failed" || d.status === "unknown") { this.block(w, d.error ?? "投递失败，请检查工作会话", d.status === "unknown"); return; }
    if (d.status !== "delivered" || !d.sessionId || !d.inboxItemId) return;
    const s = this.store.getSession(d.sessionId), item = this.store.getItem(d.inboxItemId);
    if (!s || !item || inTurn(s.status)) return;
    const [turn] = this.store.findItems(s.id, "turn", {}, { newest: true, limit: 1 });
    if (!turn || turn.type !== "turn" || turn.seq <= item.seq || turn.state === "running") return;
    const [answer] = this.store.findItems(s.id, "agent", {}, { newest: true, limit: 1 });
    const report = `本轮已结束，尚未确认完成验收。${answer?.type === "agent" && answer.seq > item.seq && !answer.streaming ? `\n${answer.markdown.slice(0, 12_000)}` : "请检查工作会话。"}`;
    await this.reportInternal(w, { action: "blocked", report, clientMessageId: `work-end:${w.id}:${w.attempt}` }, s.id);
  }
  async report(id: Id, input: unknown, sessionId: Id): Promise<CompanyWork> {
    this.company.snapshot();
    const w = this.require(id), a = this.company.identity(sessionId), p = obj(input);
    const duplicate = typeof p.clientMessageId === "string" ? this.repo.duplicate(w.roomId, a.id, p.clientMessageId) : undefined;
    if (duplicate?.workId === id) return w;
    if (a.id !== w.agentId) throw new HostError("read_only", "只能汇报分配给自己的工作");
    if (Object.keys(p).some((k) => !["action", "report", "agentId", "clientMessageId"].includes(k))) fail("汇报包含不支持的字段");
    return this.reportInternal(w, p as unknown as CompanyWorkReport, sessionId);
  }
  private async reportInternal(w: CompanyWork, p: CompanyWorkReport, sessionId: Id): Promise<CompanyWork> {
    const report = str(p.report, "汇报", 16_000), key = str(p.clientMessageId, "clientMessageId", 200);
    const own = this.company.identity(sessionId);
    const duplicate = this.repo.duplicate(w.roomId, own.id, key);
    if (duplicate) {
      if (duplicate.workId !== w.id) throw new HostError("conflict", "clientMessageId 已被其他汇报使用");
      return this.require(w.id);
    }
    if (!["progress", "done", "blocked", "handoff"].includes(p.action)) fail("汇报操作无效");
    if (!["dispatching", "running", "blocked"].includes(w.status)) throw new HostError("conflict", "工作已结束或尚未派发");
    const source = w.messageId ? this.repo.message(w.messageId) : this.repo.duplicate(w.roomId, "company-ceo", `work:${w.id}:${w.attempt}`);
    if (!source || source.deliveries.find((d) => d.agentId === own.id)?.status !== "delivered") throw new HostError("conflict", "派发尚未确认送达，不能提前完成工作");
    if (!this.company.snapshot().rooms.find((r) => r.id === w.roomId)?.memberIds.includes(own.id)) throw new HostError("read_only", "当前 Agent 已不在汇报群中");
    let next: CompanyWork = { ...w, messageId: source.id, report };
    if (p.action === "handoff") {
      if (w.handoffs >= 4) throw new HostError("conflict", "已达到四次自动交接上限，请向 CEO 汇报后等待安排");
      const target = this.assignee(p.agentId, w.roomId);
      if (target.id === own.id) fail("不能将同一工作反复交给自己");
      next = { ...next, agentId: target.id, status: "queued", messageId: null, handoffs: w.handoffs + 1, manualStart: false };
    } else if (p.action === "done") next.status = "done";
    else if (p.action === "blocked") next.status = "blocked";
    // The group report and its state transition commit together; no second wake-up from report-only messages.
    this.store.transaction(() => {
      this.repo.add({ id: newId("company-message"), workId: w.id, roomId: w.roomId, senderId: own.id, text: `【工作${p.action === "done" ? "完成" : p.action === "handoff" ? "交接" : p.action === "blocked" ? "受阻" : "进度"}】${w.title}\n${report}${p.action === "handoff" ? `\n接手：${this.repo.agent(next.agentId)!.name}` : ""}`, mentions: [], replyTo: source.id, clientMessageId: key, createdAt: now(), hop: source.hop + 1, deliveries: [] });
      this.repo.putWork({ ...next, updatedAt: now() });
    });
    this.publish({ type: "company.changed" }); this.schedule(); return this.require(w.id);
  }
}
