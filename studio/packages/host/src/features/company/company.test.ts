import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyArchive, CompanyMessage, ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import type { SessionRuntimeApi } from "../../runtime/runtime.js";
import { toolContext } from "../../mcp/tool-kit.js";
import { companyTools } from "./mcp.js";
import { CompanyRepository } from "./repository.js";
import { CompanyFeature } from "./service.js";

const HIGH = "company-build-high", LOW = "company-build-low", CTO = "company-cto", ALL = "company-room-all", BUILD = "company-room-build";
const profiles: ModelProfile[] = [{ id: "p", runtime: "codex", label: "本机模型", provider: null, model: "test" }];
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "amo-company-"));
  cleanup.push(() => removeTempDir(root));
  const store = new Store(join(root, "studio.db"));
  const events = new EventEmitter();
  let service: HostService;
  const emitSession = (s: Session) => service.publish({ type: "session.upserted", session: s });
  const start = vi.fn(async (input: Parameters<SessionRuntimeApi["startSession"]>[0]) => {
    const s = store.createSession({ taskId: input.taskId, topicId: input.topicId, parentId: null, kind: "main", runtime: "codex", profileId: input.profileId, workspaceId: input.workspace.id, title: "新工作会话", status: "idle", writer: "workbench", runtimeRef: randomUUID(), options: input.options });
    emitSession(s); return s;
  });
  const resend = vi.fn(async (id: string, itemId: string) => {
    const item = store.getItem(itemId)!;
    if (item.type !== "user") throw new Error("expected a user item");
    const { delivery: _delivery, ...sent } = item;
    service.publish({ type: "item.updated", item: store.replaceItem(sent) });
    emitSession(store.updateSession(id, { status: "running" }));
    return { mode: "start" as const };
  });
  const setOptions = vi.fn(async (id: string, options: Session["options"]) => { const s = store.updateSession(id, { options }); emitSession(s); return s; });
  const runtime = Object.assign(events, { startSession: start, resend, sendMessage: vi.fn(), setOptions, choices: vi.fn(async () => ({ profileId: "p", models: [{ id: "test", label: "Test", efforts: ["high"], defaultEffort: "high" }, { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["high"], defaultEffort: "high" }], permissions: [] })) }) as unknown as SessionRuntimeApi;
  service = new HostService(store, runtime, profiles, { commonDir: join(root, "common") });
  cleanup.push(() => { service.removeAllListeners(); service.duty.stop(); store.close(); });
  const workspace = store.addWorkspace({ name: "测试工程", path: root });
  const makeSession = (patch: Partial<Session> = {}) => {
    const task = store.createTask({ title: "原有任务", workspaceId: workspace.id });
    return store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: workspace.id, title: "原有会话", status: "running", writer: "workbench", runtimeRef: randomUUID(), ...patch });
  };
  const bind = (agentId: string, s = makeSession()) => { service.company.updateAgent(agentId, { sessionId: s.id }); return s; };
  const send = (text: string, mentions: string[] = [], extra = {}) => service.company.send(ALL, { text, mentions, clientMessageId: `${text}-${Math.random()}`, ...extra });
  return { service, company: service.company, store, root, workspace, makeSession, bind, start, resend, send, emitSession, runtime, setOptions };
}

function archive(root: string): CompanyArchive {
  const dir = join(root, "company-archives", "high"); mkdirSync(dir, { recursive: true });
  const transcriptPath = join(dir, "transcript.txt"), contents = "用户：保存本机历史\n助手：已保存\n";
  writeFileSync(transcriptPath, contents, "utf8");
  const a: CompanyArchive = { id: "history-high", title: "高配完整记录", source: "workstudio", manifestPath: join(dir, "company-archive.json"), transcriptPath, messageCount: 2, sha256: createHash("sha256").update(contents).digest("hex"), localOnly: true };
  writeFileSync(a.manifestPath, JSON.stringify({ ...a, kind: "workstudio-company-archive", version: 1 }), "utf8");
  return a;
}

function workFixture() {
  const f = setup();
  const high = f.bind(HIGH, f.makeSession({ status: "idle", options: { model: "test", permission: "full-auto", fast: true } }));
  const low = f.bind(LOW, f.makeSession({ status: "idle" }));
  const create = (title = "检查产物", priority: "low" | "medium" | "high" = "medium", agentId = HIGH) => f.company.work.create({ title, priority, agentId, roomId: ALL, acceptance: "提供验证结果", clientId: title });
  const get = (id: string) => f.company.work.list().find((w) => w.id === id)!;
  const finish = (s: Session) => {
    f.store.appendItem({ id: randomUUID(), sessionId: s.id, createdAt: new Date().toISOString(), type: "turn", turnId: randomUUID(), state: "completed", startedAt: new Date().toISOString() });
    f.emitSession(f.store.updateSession(s.id, { status: "completed" }));
  };
  const running = async (id: string) => vi.waitFor(() => expect(get(id).status).toBe("running"));
  return { ...f, high, low, create, get, finish, running };
}

describe("工作列表、自主接活与规范改进", () => {
  it("persists priority ordering, dispatches only one job, and waits for the real turn to end", async () => {
    const f = workFixture();
    f.emitSession(f.store.updateSession(f.high.id, { status: "running" }));
    const low = f.create("低优先级", "low"), high = f.create("高优先级", "high"), mid = f.create("中优先级");
    await f.company.work.pump(); expect(f.resend).not.toHaveBeenCalled();
    expect(f.company.work.list().map((w) => w.id)).toEqual([high.id, mid.id, low.id]);
    f.finish(f.high); await f.running(high.id);
    expect(f.resend).toHaveBeenCalledTimes(1); expect(f.get(mid.id).status).toBe("queued");
    await f.company.work.report(high.id, { action: "done", report: "验收通过，产物已核对", clientMessageId: "done-1" }, f.high.id);
    await f.company.work.pump(); expect(f.resend).toHaveBeenCalledTimes(1);
    f.finish(f.high); await f.running(mid.id);
    expect(f.resend).toHaveBeenCalledTimes(2); expect(f.get(low.id).status).toBe("queued");
    expect(f.company.messages(ALL).messages.some((m) => m.workId === high.id && m.text.includes("工作完成"))).toBe(true);
  });

  it("creates idempotently and keeps work private to the bound assignee", async () => {
    const f = workFixture(), w = f.create();
    expect(f.create().id).toBe(w.id); await f.running(w.id);
    expect(f.company.work.readSelf(f.low.id).work).toHaveLength(0);
    await expect(f.company.work.report(w.id, { action: "done", report: "伪造", clientMessageId: "other" }, f.low.id)).rejects.toThrow("分配给自己");
    const report = { action: "done", report: "验证通过", clientMessageId: "done" } as const;
    await f.company.work.report(w.id, report, f.high.id); await f.company.work.report(w.id, report, f.high.id);
    expect(f.company.messages(ALL).messages.filter((m) => m.clientMessageId === "done")).toHaveLength(1);
  });

  it("honors manual start and applies the selected real model only before dispatch, preserving permissions", async () => {
    const f = workFixture();
    f.company.updateAgent(HIGH, { autonomous: false, model: "gpt-6.1-sol" });
    const w = f.create(); await f.company.work.pump();
    expect(f.resend).not.toHaveBeenCalled(); expect(f.setOptions).not.toHaveBeenCalled();
    await f.company.work.action(w.id, { action: "start" }); await f.running(w.id);
    expect(f.setOptions).toHaveBeenCalledWith(f.high.id, { model: "gpt-6.1-sol", permission: "full-auto", fast: true, effort: "high" });
    expect(() => f.company.updateAgent(HIGH, { model: "test" })).toThrow("结束后");
  });

  it("rejects an unavailable model before sending any native input", async () => {
    const f = workFixture(); f.company.updateAgent(HIGH, { model: "not-available" });
    const w = f.create(); await vi.waitFor(() => expect(f.get(w.id).status).toBe("blocked"));
    expect(f.resend).not.toHaveBeenCalled(); expect(f.get(w.id).report).toContain("模型当前不可用");
  });

  it("does not send into a human turn that starts during model preparation", async () => {
    const f = workFixture(); f.company.updateAgent(HIGH, { model: "gpt-6.1-sol" });
    vi.spyOn(f.runtime, "choices").mockImplementationOnce(async () => { f.emitSession(f.store.updateSession(f.high.id, { status: "running" })); return { profileId: "p", models: [{ id: "gpt-6.1-sol", label: "Sol", efforts: [] }], permissions: [], defaultPermission: "default", source: "cli" }; });
    const w = f.create(); await vi.waitFor(() => expect(f.get(w.id).status).toBe("blocked"));
    expect(f.resend).not.toHaveBeenCalled(); expect(f.setOptions).not.toHaveBeenCalled();
  });

  it("automatically hands a job to a peer, posts a report once, and rejects a fifth handoff", async () => {
    const f = workFixture(), w = f.create(); await f.running(w.id);
    const report = { action: "handoff", report: "请核对低配产物", agentId: LOW, clientMessageId: "handoff" } as const;
    await f.company.work.report(w.id, report, f.high.id); await f.company.work.report(w.id, report, f.high.id);
    await vi.waitFor(() => expect(f.get(w.id)).toMatchObject({ agentId: LOW, status: "running", handoffs: 1 }));
    expect(f.resend).toHaveBeenCalledTimes(2);
    const repo = new CompanyRepository(f.store); repo.putWork({ ...f.get(w.id), handoffs: 4 });
    await expect(f.company.work.report(w.id, { ...report, agentId: HIGH, clientMessageId: "fifth" }, f.low.id)).rejects.toThrow("四次");
    expect(f.company.messages(ALL).messages.filter((m) => m.clientMessageId === "handoff")).toHaveLength(1);
  });

  it("blocks on an ended turn without a completion receipt and publishes its final response", async () => {
    const f = workFixture(), w = f.create(); await f.running(w.id);
    f.store.appendItem({ id: randomUUID(), sessionId: f.high.id, type: "agent", createdAt: new Date().toISOString(), markdown: "缺少签名文件，需要补齐", streaming: false });
    f.finish(f.high); await vi.waitFor(() => expect(f.get(w.id).status).toBe("blocked"));
    expect(f.get(w.id).report).toContain("缺少签名文件");
    expect(f.company.messages(ALL).messages.at(-1)?.text).toContain("工作受阻");
    await f.company.work.pump(); expect(f.resend).toHaveBeenCalledTimes(1);
  });

  it("does not replay uncertain requests after recovery; explicit confirmation is required", async () => {
    const f = workFixture(); f.resend.mockRejectedValueOnce(new Error("lost acknowledgement"));
    const w = f.create(); await vi.waitFor(() => expect(f.get(w.id).status).toBe("blocked"));
    await expect(f.company.work.action(w.id, { action: "retry" })).rejects.toThrow("明确确认");
    await f.company.work.pump(); expect(f.resend).toHaveBeenCalledTimes(1);
    await f.company.work.action(w.id, { action: "retry", confirmUnknown: true }); await f.running(w.id);
    expect(f.resend).toHaveBeenCalledTimes(2); expect(f.get(w.id).attempt).toBe(2);
  });

  it("recovers an interrupted dispatch conservatively without inventing another model call", async () => {
    const f = workFixture(); f.company.updateAgent(HIGH, { autonomous: false });
    const w = f.create(); new CompanyRepository(f.store).putWork({ ...w, status: "dispatching", attempt: 1 });
    await f.company.work.pump(); expect(f.get(w.id)).toMatchObject({ status: "blocked", report: expect.stringContaining("确认前中断") });
    expect(f.resend).not.toHaveBeenCalled();
  });

  it("keeps queued work editable and cancellable without starting a model", async () => {
    const f = workFixture(); f.company.updateAgent(HIGH, { autonomous: false });
    const w = f.create(); expect(f.company.work.update(w.id, { priority: "high", title: "更新目标" })).toMatchObject({ priority: "high", title: "更新目标" });
    await f.company.work.action(w.id, { action: "cancel" });
    expect(f.get(w.id).status).toBe("cancelled"); expect(f.resend).not.toHaveBeenCalled();
  });
  it("does not dispatch a candidate cancelled while another Agent's acknowledgement was pending", async () => {
    const f = workFixture();
    let ack!: () => void;
    const resend = f.resend.getMockImplementation()!;
    f.resend.mockImplementationOnce(async (...args) => { await new Promise<void>((resolve) => { ack = resolve; }); return resend(...args); });
    const first = f.create("先派发", "high"), cancelled = f.create("后来取消", "low", LOW);
    await vi.waitFor(() => expect(ack).toBeTypeOf("function"));
    await f.company.work.action(cancelled.id, { action: "cancel" }); ack(); await f.running(first.id);
    await f.company.work.pump(); expect(f.get(cancelled.id).status).toBe("cancelled"); expect(f.resend).toHaveBeenCalledTimes(1);
  });

  it("records evidence-based self improvements with CAS and reversible history, without changing authority", async () => {
    const f = workFixture(), w = f.create(); await f.running(w.id);
    const input = { workId: w.id, instructions: "先核对签名，再验证产物和日志", reason: "本次发现签名步骤需要提前核对", expectedVersion: 0 };
    expect(() => f.company.evolve(f.high.id, input)).toThrow("自己已完成");
    await f.company.work.report(w.id, { action: "done", report: "验证通过", clientMessageId: "done" }, f.high.id);
    const before = f.company.snapshot().agents.find((a) => a.id === HIGH)!;
    const evolved = f.company.evolve(f.high.id, input);
    expect(evolved).toMatchObject({ instructions: input.instructions, instructionsVersion: 1, model: before.model, profileId: before.profileId, sessionId: before.sessionId });
    expect(() => f.company.evolve(f.high.id, input)).toThrow("已有新版本");
    expect(() => f.company.evolve(f.low.id, input)).toThrow("自己已完成");
    expect(() => f.company.evolve(f.high.id, { ...input, expectedVersion: 1, permission: "full-auto" })).toThrow("不能修改身份或权限");
    const revision = f.company.revisions(HIGH)[0]!;
    expect(revision).toMatchObject({ workId: w.id, actorId: HIGH, before: before.instructions, after: input.instructions, version: 1 });
    expect(f.company.rollback(HIGH, revision.id, 1)).toMatchObject({ instructions: before.instructions, instructionsVersion: 2 });
    expect(f.company.revisions(HIGH)).toHaveLength(2);
    f.company.updateAgent(HIGH, { allowEvolution: false });
    expect(() => f.company.evolve(f.high.id, { ...input, expectedVersion: 2 })).toThrow("关闭自我改进");
  });
  it("exposes the work tools through session identity without returning local archive paths", async () => {
    const f = workFixture(), w = f.create(); await f.running(w.id);
    const tools = companyTools(toolContext(f.service, { sessionId: f.high.id }));
    const report = await tools.find((t) => t.name === "company_work_report")!.run({ workId: w.id, action: "done", report: "已完成验证", clientMessageId: "mcp-done" });
    expect(report.isError).toBeUndefined(); expect(f.get(w.id).status).toBe("done");
    const evolved = await tools.find((t) => t.name === "company_self_improve")!.run({ workId: w.id, instructions: "按验收条件逐项验证", reason: "本次验收确认有效", expectedVersion: 0 });
    expect(evolved.isError).toBeUndefined(); expect(JSON.stringify(evolved)).not.toMatch(/manifestPath|transcriptPath|runtimeRef/);
    const noCaller = companyTools(toolContext(f.service, null));
    expect((await noCaller.find((t) => t.name === "company_work_read")!.run({})).isError).toBe(true);
  });
});

describe("公司 Agent 与本机协作群", () => {
  it("seeds persistent identities and rooms without changing existing work or starting a turn", () => {
    const { company, store, makeSession, start, resend, service } = setup();
    const s = makeSession(), before = store.getSession(s.id);
    const snapshot = company.snapshot();
    expect(snapshot.agents.map((a) => a.id)).toEqual(["company-ceo", "company-product", CTO, HIGH, LOW, "company-platform"]);
    expect(snapshot.agents.find((a) => a.id === HIGH)?.managerId).toBe(CTO);
    expect(snapshot.rooms).toHaveLength(2);
    expect(new CompanyFeature(service).snapshot()).toEqual(snapshot);
    expect(store.getSession(s.id)).toEqual(before);
    expect(start).not.toHaveBeenCalled(); expect(resend).not.toHaveBeenCalled();
  });

  it("binds a live local session and reflects status, rejecting duplicate bindings and cycles", () => {
    const { company, bind, store, emitSession, service } = setup();
    const s = bind(HIGH);
    expect(company.snapshot().agents.find((a) => a.id === HIGH)).toMatchObject({ sessionId: s.id, taskId: s.taskId, profileId: "p", workspaceId: s.workspaceId, status: "running" });
    expect(() => company.updateAgent(LOW, { sessionId: s.id })).toThrow("已被另一位");
    expect(() => company.updateAgent(CTO, { managerId: HIGH })).toThrow("循环");
    const listener = vi.fn(); service.on("event", listener);
    emitSession(store.updateSession(s.id, { status: "awaiting-approval" }));
    expect(company.snapshot().agents.find((a) => a.id === HIGH)?.status).toBe("waiting");
    expect(listener.mock.calls.some(([e]) => e.type === "company.changed" && Object.keys(e).every((key) => ["type", "seq"].includes(key)))).toBe(true);
  });

  it("rejects subagents, archived, remote and native-import descendants and mismatched settings", () => {
    const { company, store, makeSession, workspace } = setup();
    const sub = makeSession({ kind: "sub" });
    expect(() => company.updateAgent(HIGH, { sessionId: sub.id })).toThrow("主会话或分支");
    const remote = makeSession({ runtime: "remote" });
    expect(() => company.updateAgent(HIGH, { sessionId: remote.id })).toThrow("主会话或分支");
    const archived = makeSession({ writer: "archived" });
    expect(() => company.updateAgent(HIGH, { sessionId: archived.id })).toThrow("主会话或分支");
    const imported = makeSession(); store.setKv("claude-adopted:outside", imported.id);
    const child = makeSession({ taskId: imported.taskId, parentId: imported.id, kind: "fork" });
    expect(() => company.updateAgent(HIGH, { sessionId: child.id })).toThrow("主会话或分支");
    const valid = makeSession();
    expect(() => company.updateAgent(HIGH, { sessionId: valid.id, workspaceId: "other" })).toThrow("不一致");
    expect(() => company.updateAgent(HIGH, { workspaceId: workspace.id, archives: [] })).toThrow("不支持的字段");
    expect(() => company.updateAgent("company-ceo", { sessionId: valid.id })).toThrow("CEO 是人");
  });

  it("stores ordinary messages without starting work and paginates the complete history", async () => {
    const { company, send, start, resend } = setup();
    const sent: CompanyMessage[] = [];
    for (let i = 0; i < 7; i++) sent.push(await send(`第${i}条`));
    const last = company.messages(ALL, undefined, 3);
    expect(last.messages.map((m) => m.id)).toEqual(sent.slice(4).map((m) => m.id)); expect(last.hasMore).toBe(true);
    const middle = company.messages(ALL, last.messages[0]!.id, 3);
    expect(middle.messages.map((m) => m.id)).toEqual(sent.slice(1, 4).map((m) => m.id));
    expect(company.messages(ALL, middle.messages[0]!.id, 3)).toMatchObject({ hasMore: false, messages: [{ id: sent[0]!.id }] });
    expect(() => company.messages(BUILD, sent[0]!.id)).toThrow("不属于");
    expect(start).not.toHaveBeenCalled(); expect(resend).not.toHaveBeenCalled();
  });

  it("queues explicit mentions behind a running turn, tracks delivery and deduplicates client retries", async () => {
    const { company, bind, send, resend, store, emitSession } = setup();
    const s = bind(HIGH);
    const m = await send("检查已有构建", [HIGH], { clientMessageId: "stable-id" });
    expect(m.deliveries[0]).toMatchObject({ status: "queued", sessionId: s.id, taskId: s.taskId, inboxItemId: expect.any(String) });
    expect(resend).not.toHaveBeenCalled();
    expect(await send("检查已有构建", [HIGH], { clientMessageId: "stable-id" })).toEqual(m);
    expect(store.findItems(s.id, "user", { delivery: "held" })).toHaveLength(1);
    await send("下一项构建诊断", [HIGH]);
    expect(store.findItems(s.id, "user", { delivery: "held" })).toHaveLength(2);
    expect(() => company.updateAgent(HIGH, { sessionId: null })).toThrow("排队中的群任务");
    emitSession(store.updateSession(s.id, { status: "idle" }));
    await vi.waitFor(() => expect(company.messages(ALL).messages[0]!.deliveries[0]!.status).toBe("delivered"));
    expect(resend).toHaveBeenCalledTimes(1);
    expect(company.messages(ALL).messages[1]!.deliveries[0]!.status).toBe("queued");
    emitSession(store.updateSession(s.id, { status: "idle" }));
    await vi.waitFor(() => expect(company.messages(ALL).messages[1]!.deliveries[0]!.status).toBe("delivered"));
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it("creates only one new work session after the first mention, with identity configured before sending", async () => {
    const { company, workspace, send, start, store, resend } = setup();
    company.updateAgent(LOW, { profileId: "p", workspaceId: workspace.id });
    expect(start).not.toHaveBeenCalled();
    const m = await send("整理轻量构建排期", [LOW]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0].text).toBeUndefined();
    const assigned = company.snapshot().agents.find((a) => a.id === LOW)!;
    expect(assigned.sessionId).toBe(m.deliveries[0]!.sessionId);
    expect(resend).toHaveBeenCalledTimes(1);
    const item = store.getItem(m.deliveries[0]!.inboxItemId!);
    expect(item?.type === "user" && item.text).toContain("company_message_send");
    expect(item?.type === "user" && item.text).toContain(LOW);
    expect(() => company.updateAgent(LOW, { sessionId: null })).toThrow("群任务");
    expect(() => company.updateRoom(ALL, { memberIds: ["company-ceo"] })).toThrow("尚未结束的执行");
    await send("接着检查日志", [LOW]);
    expect(start).toHaveBeenCalledTimes(1); expect(resend).toHaveBeenCalledTimes(1);
  });

  it("keeps failures visible and only retries after an explicit request", async () => {
    const { company, send, bind, resend, makeSession } = setup();
    const m = await send("检查打包", [HIGH]);
    expect(m.deliveries[0]).toMatchObject({ status: "failed", error: expect.stringContaining("先为") });
    bind(HIGH, makeSession({ status: "idle" }));
    resend.mockRejectedValueOnce(new Error("runtime transport failed"));
    const failed = await company.retry(ALL, m.id, HIGH);
    expect(failed.deliveries[0]!.status).toBe("unknown");
    expect(resend).toHaveBeenCalledTimes(1);
    await expect(company.retry(ALL, m.id, HIGH)).rejects.toThrow("明确确认");
    const success = await company.retry(ALL, m.id, HIGH, true);
    expect(success.deliveries[0]!.status).toBe("delivered");
    expect(resend).toHaveBeenCalledTimes(2);
    await expect(company.retry(ALL, m.id, HIGH)).rejects.toThrow("只有投递失败");
  });

  it("fixes MCP sender identity, restricts group reads and requires a received mention for replies", async () => {
    const { company, bind, send, makeSession, service } = setup();
    const high = bind(HIGH), other = makeSession();
    const privateRoom = company.createRoom({ name: "管理讨论", memberIds: [CTO] });
    expect(() => company.messages(privateRoom.id, undefined, 50, high.id)).toThrow("不是这个群");
    expect(() => company.groupsFor(other.id)).toThrow("没有已启用");
    const tools = companyTools(toolContext(service, { sessionId: high.id }));
    const source = await send("请汇报状态", [HIGH]);
    const response = await tools.find((t) => t.name === "company_message_send")!.run({ roomId: ALL, text: "已收到", replyTo: source.id, clientMessageId: "agent-reply" });
    expect(response.isError).toBeUndefined();
    expect(company.messages(ALL).messages.at(-1)).toMatchObject({ senderId: HIGH, replyTo: source.id, deliveries: [] });
    await expect(company.send(ALL, { text: "冒充", senderId: "company-ceo", clientMessageId: "bad" }, high.id)).rejects.toThrow("发送者");
    await expect(company.send(ALL, { text: "未接到任务", clientMessageId: "no-parent" }, high.id)).rejects.toThrow("replyTo");
    const noCaller = companyTools(toolContext(service, null));
    expect((await noCaller[0]!.run({})).isError).toBe(true);
  });

  it("caps automatic handoffs, prevents repeated fanout, and allows a final report to the CEO", async () => {
    const { company, bind, send } = setup();
    const high = bind(HIGH), low = bind(LOW);
    let parent = await send("逐项核对构建", [HIGH]);
    for (let hop = 1; hop <= 4; hop++) {
      const odd = hop % 2 === 1, session = odd ? high : low;
      const message = { text: `转交 ${hop}`, mentions: [odd ? LOW : HIGH], replyTo: parent.id, clientMessageId: `hop-${hop}` };
      const next = await company.send(ALL, message, session.id);
      expect(next.hop).toBe(hop);
      if (hop === 1) await expect(company.send(ALL, { ...message, clientMessageId: "duplicate-fanout" }, session.id)).rejects.toThrow("已转交过一次");
      parent = next;
    }
    await expect(company.send(ALL, { text: "无限循环", mentions: [LOW], replyTo: parent.id, clientMessageId: "hop5" }, high.id)).rejects.toThrow("上限");
    expect(await company.send(ALL, { text: "需要CEO确认下一步", mentions: ["company-ceo"], replyTo: parent.id, clientMessageId: "report" }, high.id)).toMatchObject({ deliveries: [], senderId: HIGH });
  });

  it("hydrates explicit, verified archives and binding without reading native directories or starting work", () => {
    const { company, root, makeSession, workspace, start, resend } = setup();
    const s = makeSession(), a = archive(root);
    const bootstrap = { version: 1, agents: [{ id: HIGH, matchTaskId: s.taskId, matchSessionId: s.id, archives: [a] }, { id: LOW, profileId: "p", workspaceId: workspace.id }] };
    writeFileSync(join(root, "company-bootstrap.json"), JSON.stringify(bootstrap));
    const snapshot = company.snapshot();
    expect(snapshot.bootstrapWarnings).toBeUndefined();
    expect(snapshot.agents.find((agent) => agent.id === HIGH)).toMatchObject({ sessionId: s.id, archives: [a] });
    expect(snapshot.agents.find((agent) => agent.id === LOW)).toMatchObject({ profileId: "p", workspaceId: workspace.id, sessionId: null, status: "ready" });
    expect(company.snapshot()).toEqual(snapshot);
    expect(start).not.toHaveBeenCalled(); expect(resend).not.toHaveBeenCalled();
  });

  it("rejects escaped or corrupted archives per Agent without partially applying that record", () => {
    const { company, root, makeSession } = setup();
    const s = makeSession(), a = archive(root);
    const outside = { ...a, manifestPath: join(root, "outside.json") }; writeFileSync(outside.manifestPath, JSON.stringify({ ...outside, version: 1, kind: "workstudio-company-archive" }));
    writeFileSync(join(root, "company-bootstrap.json"), JSON.stringify({ version: 1, agents: [{ id: HIGH, matchSessionId: s.id, archives: [outside] }] }));
    expect(company.snapshot()).toMatchObject({ bootstrapWarnings: [expect.stringContaining("越出")] });
    expect(company.snapshot().agents.find((agent) => agent.id === HIGH)).toMatchObject({ sessionId: null, archives: [] });
    writeFileSync(a.transcriptPath, "different contents");
    writeFileSync(join(root, "company-bootstrap.json"), JSON.stringify({ version: 1, agents: [{ id: HIGH, matchSessionId: s.id, archives: [a] }] }));
    expect(company.snapshot().bootstrapWarnings?.[0]).toContain("校验失败");
    expect(company.snapshot().agents.find((agent) => agent.id === HIGH)?.sessionId).toBeNull();
  });

  it("marks interrupted dispatches as failed without replaying and reconciles tracked inbox outcomes", async () => {
    const { company, service, bind, send, store, resend } = setup();
    bind(HIGH);
    const m = await send("检查构建结果", [HIGH]);
    const repo = new CompanyRepository(store);
    repo.putMessage({ ...m, deliveries: [{ ...m.deliveries[0]!, status: "pending", inboxItemId: undefined }] });
    const restart = new CompanyFeature(service); restart.snapshot();
    expect(restart.messages(ALL).messages[0]!.deliveries[0]).toMatchObject({ status: "failed", error: expect.stringContaining("进入工作会话前") });
    expect(resend).not.toHaveBeenCalled();
  });

  it("waits for the actual runtime acknowledgement and the observed turn end before dispatching another job", async () => {
    const { company, bind, makeSession, send, resend, store, service, emitSession } = setup();
    const s = bind(HIGH, makeSession({ status: "idle" }));
    let acknowledge!: () => void;
    resend.mockImplementationOnce(async (_sessionId, itemId) => {
      const item = store.getItem(itemId)!;
      if (item.type !== "user") throw new Error("not a user message");
      const { delivery: _delivery, ...sentBeforeAck } = item;
      service.publish({ type: "item.updated", item: store.replaceItem(sentBeforeAck) });
      await new Promise<void>((resolve) => { acknowledge = resolve; });
      return { mode: "start" };
    });
    const sending = send("第一个独立任务", [HIGH]);
    await vi.waitFor(() => expect(company.messages(ALL).messages[0]!.deliveries[0]!.status).toBe("sending"));
    acknowledge();
    expect((await sending).deliveries[0]!.status).toBe("delivered");
    // The native RPC has returned, but the runtime has not emitted running yet. No second turn may start here.
    const second = await send("第二个独立任务", [HIGH]);
    expect(second.deliveries[0]!.status).toBe("queued"); expect(resend).toHaveBeenCalledTimes(1);
    emitSession(store.updateSession(s.id, { status: "running" }));
    expect(resend).toHaveBeenCalledTimes(1);
    emitSession(store.updateSession(s.id, { status: "completed" }));
    await vi.waitFor(() => expect(resend).toHaveBeenCalledTimes(2));
  });

  it("recovers an unacknowledged request as unknown even when the runtime already cleared delivery", async () => {
    const { company, service, bind, send, store, resend } = setup();
    const s = bind(HIGH);
    const m = await send("崩溃时的任务", [HIGH]);
    const item = store.getItem(m.deliveries[0]!.inboxItemId!)!;
    if (item.type !== "user") throw new Error("not a user message");
    const { delivery: _delivery, ...sentBeforeAck } = item; store.replaceItem(sentBeforeAck);
    new CompanyRepository(store).putMessage({ ...m, deliveries: [{ ...m.deliveries[0]!, status: "sending" }] });
    const restart = new CompanyFeature(service); restart.snapshot();
    expect(restart.messages(ALL).messages[0]!.deliveries[0]).toMatchObject({ status: "unknown", error: expect.stringContaining("可能已经送达") });
    expect(store.findItems(s.id, "user", { delivery: "held" })).toHaveLength(0);
    await expect(restart.retry(ALL, m.id, HIGH)).rejects.toThrow("明确确认");
    expect(resend).not.toHaveBeenCalled();
  });

  it("reports a capability failure before a native request as safely retryable", async () => {
    const { bind, makeSession, send, resend } = setup();
    bind(HIGH, makeSession({ status: "idle" }));
    resend.mockRejectedValueOnce(Object.assign(new Error("请等待旧模型会话空闲后刷新群工具"), { deliveryNotAttempted: true }));
    expect((await send("公司新任务", [HIGH])).deliveries[0]).toMatchObject({ status: "failed", error: expect.stringContaining("群工具") });
  });
});
