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
  const runtime = Object.assign(events, { startSession: start, resend, sendMessage: vi.fn(), choices: vi.fn(async () => ({ models: [], permissions: [] })) }) as unknown as SessionRuntimeApi;
  service = new HostService(store, runtime, profiles, { commonDir: join(root, "common") });
  cleanup.push(() => { service.removeAllListeners(); service.duty.stop(); store.close(); });
  const workspace = store.addWorkspace({ name: "测试工程", path: root });
  const makeSession = (patch: Partial<Session> = {}) => {
    const task = store.createTask({ title: "原有任务", workspaceId: workspace.id });
    return store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: workspace.id, title: "原有会话", status: "running", writer: "workbench", runtimeRef: randomUUID(), ...patch });
  };
  const bind = (agentId: string, s = makeSession()) => { service.company.updateAgent(agentId, { sessionId: s.id }); return s; };
  const send = (text: string, mentions: string[] = [], extra = {}) => service.company.send(ALL, { text, mentions, clientMessageId: `${text}-${Math.random()}`, ...extra });
  return { service, company: service.company, store, root, workspace, makeSession, bind, start, resend, send, emitSession };
}

function archive(root: string): CompanyArchive {
  const dir = join(root, "company-archives", "high"); mkdirSync(dir, { recursive: true });
  const transcriptPath = join(dir, "transcript.txt"), contents = "用户：保存本机历史\n助手：已保存\n";
  writeFileSync(transcriptPath, contents, "utf8");
  const a: CompanyArchive = { id: "history-high", title: "高配完整记录", source: "workstudio", manifestPath: join(dir, "company-archive.json"), transcriptPath, messageCount: 2, sha256: createHash("sha256").update(contents).digest("hex"), localOnly: true };
  writeFileSync(a.manifestPath, JSON.stringify({ ...a, kind: "workstudio-company-archive", version: 1 }), "utf8");
  return a;
}

describe("公司 Agent 与本机协作群", () => {
  it("seeds persistent identities and rooms without changing existing work or starting a turn", () => {
    const { company, store, makeSession, start, resend, service } = setup();
    const s = makeSession(), before = store.getSession(s.id);
    const snapshot = company.snapshot();
    expect(snapshot.agents.map((a) => a.id)).toEqual(["company-ceo", "company-product", CTO, HIGH, LOW]);
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
