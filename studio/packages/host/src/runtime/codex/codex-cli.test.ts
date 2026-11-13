import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, SessionItem, Workspace } from "@amo-studio/protocol";
import { Store } from "../../store/store.js";
import { CodexRuntime, codexRetry, describeTool, reviewTarget } from "./codex-runtime.js";
import { FakeServers } from "./fake-servers.test-support.js";

// Stage 12, S12-E: Codex CLI features against the fake app-server, which replays what the real Codex 0.162 sent with
// the mock model (spikes/s12-e-codex-cli.mjs): compaction, review mode (with its turn ids), skills, retries, notices,
// tool progress and the remaining item types.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let store: Store;
let servers: FakeServers;
let runtime: CodexRuntime;
let workspace: Workspace;
let taskId: string;

beforeEach(() => {
  store = new Store(":memory:");
  servers = new FakeServers(PROFILES);
  runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  workspace = store.addWorkspace({ path: "C:/sandbox/ws", name: "ws" });
  taskId = store.createTask({ title: "t", workspaceId: workspace.id }).id;
});

afterEach(async () => {
  await servers.close();
  store.close();
});

const until = async (pred: () => boolean, label = "condition", timeoutMs = 4000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const items = (id: string) => store.listItems(id);
const ofType = <T extends SessionItem["type"]>(id: string, type: T) => items(id).filter((i): i is Extract<SessionItem, { type: T }> => i.type === type);
const idle = (id: string) => store.getSession(id)!.status === "idle";
const replied = (id: string, text: string) => ofType(id, "agent").some((a) => a.markdown === text && !a.streaming) && idle(id);
const start = (text?: string) => runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, ...(text ? { text } : {}) });

describe("Codex CLI features", () => {
  it("compacts the context as a turn of its own and shows the warning after it", async () => {
    const s = await start("hello");
    await until(() => replied(s.id, "FAKE: hello"), "first reply");
    // The fake's first turn reports no usage; give the session a context to compact.
    const firstTurn = ofType(s.id, "turn")[0]!;
    store.replaceItem({ ...firstTurn, usage: { input: 5000, cachedInput: 0, output: 200, reasoning: 0, context: 5200 } });

    expect(await runtime.runCommand(s.id, "compact", "")).toEqual({ mode: "start" });
    await until(() => ofType(s.id, "compaction").some((c) => c.state === "completed") && idle(s.id), "compaction");
    expect(ofType(s.id, "compaction")).toMatchObject([{ state: "completed", beforeTokens: 5200 }]);
    // The command opens the turn; the turn's context is what the compaction left.
    expect(ofType(s.id, "user").map((u) => u.text)).toEqual(["hello", "/compact"]);
    const turns = ofType(s.id, "turn");
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ state: "completed", usage: { context: 1781 } });
    expect(ofType(s.id, "notice").map((n) => n.message)).toEqual(["Heads up: Long threads and multiple compactions can cause the model to be less accurate."]);
    expect(servers.fakes.get("p-ds")!.calls.some((c) => c.method === "thread/compact/start")).toBe(true);
  });

  it("refuses to compact while a turn runs", async () => {
    const s = await start("[[slow]]");
    await until(() => store.getSession(s.id)!.status === "running", "running");
    await expect(runtime.runCommand(s.id, "compact", "")).rejects.toThrow(/这一轮结束后/);
  });

  it("runs a review: one turn, the review as the answer, Codex's own prompt and raw findings left out", async () => {
    const s = await start("hello");
    await until(() => replied(s.id, "FAKE: hello"), "first reply");
    await runtime.runCommand(s.id, "code-review", "");
    await until(() => replied(s.id, "FAKE-REVIEW: current changes"), "review");
    const turns = ofType(s.id, "turn");
    expect(turns).toHaveLength(2);
    expect(turns.every((t) => t.state === "completed")).toBe(true);
    expect(ofType(s.id, "user").map((u) => u.text)).toEqual(["hello", "/code-review"]);
    expect(ofType(s.id, "notice").map((n) => n.message)).toEqual(["Codex 开始审查：当前未提交的改动"]);
    expect(ofType(s.id, "agent").map((a) => a.markdown)).toEqual(["FAKE: hello", "FAKE-REVIEW: current changes"]);
    expect(ofType(s.id, "agent").every((a) => !a.streaming)).toBe(true);
    const call = servers.fakes.get("p-ds")!.calls.find((c) => c.method === "review/start")!;
    expect(call.params).toMatchObject({ target: { type: "uncommittedChanges" }, delivery: "inline" });
    // The session is free again: the next message starts a turn instead of steering a finished one.
    await runtime.sendMessage(s.id, "after");
    await until(() => replied(s.id, "FAKE: after"), "next reply");
  });

  it("lists review mode and the enabled skills, and runs a skill with the skill input", async () => {
    const s = await start();
    const { commands } = await runtime.listCommands(s.id);
    expect(commands).toEqual([
      expect.objectContaining({ name: "plan", group: "runtime" }),
      expect.objectContaining({ name: "code-review", group: "runtime" }),
      { name: "release-notes", description: "写发布说明", group: "skill" },
    ]);
    await runtime.runCommand(s.id, "release-notes", "v1.2");
    await until(() => replied(s.id, "FAKE: $release-notes v1.2"), "skill reply");
    const turn = servers.fakes.get("p-ds")!.calls.find((c) => c.method === "turn/start")!;
    expect((turn.params as { input: unknown[] }).input).toEqual([
      { type: "text", text: "$release-notes v1.2", text_elements: [] },
      { type: "skill", name: "release-notes", path: "C:/sandbox/ws\\.agents\\skills\\release-notes\\SKILL.md" },
    ]);
    await expect(runtime.runCommand(s.id, "nope", "")).rejects.toThrow(/没有 \/nope/);
  });

  it("applies native plan mode on turns and explicitly resets it when switched off", async () => {
    const s = await start();
    await runtime.runCommand(s.id, "plan", "on");
    await runtime.sendMessage(s.id, "make a plan");
    await until(() => replied(s.id, "FAKE: make a plan"));
    const fake = servers.fakes.get("p-ds")!;
    expect(fake.calls.filter((c) => c.method === "turn/start").at(-1)?.params).toMatchObject({ collaborationMode: { mode: "plan", settings: { developer_instructions: null } } });
    await runtime.runCommand(s.id, "plan", "off");
    await runtime.sendMessage(s.id, "implement it");
    await until(() => replied(s.id, "FAKE: implement it"));
    expect(fake.calls.filter((c) => c.method === "turn/start").at(-1)?.params).toMatchObject({ collaborationMode: { mode: "default" } });
    await expect(runtime.runCommand(s.id, "plan", "wrong")).rejects.toThrow(/on 或 off/);
  });

  it("starts a new conversation in plan mode and preserves it in stored session options", async () => {
    const s = await runtime.startSession({ taskId, topicId: null, profileId: "p-ds", workspace, text: "first plan", options: { plan: true } });
    await until(() => replied(s.id, "FAKE: first plan"));
    expect(store.getSession(s.id)?.options.plan).toBe(true);
    expect(servers.fakes.get("p-ds")!.calls.find((c) => c.method === "turn/start")?.params).toMatchObject({ collaborationMode: { mode: "plan", settings: { model: "ds-model" } } });
  });

  it("uses native goal requests, validates budgets and never invents an objective", async () => {
    const s = await start();
    const client = servers.handles.get("p-ds")!.client;
    const request = client.request.bind(client);
    const spy = vi.spyOn(client, "request").mockImplementation((method, params, options) => {
      if (method === "thread/goal/set" || method === "thread/goal/clear") return Promise.resolve({}) as never;
      return request(method, params, options) as never;
    });
    await runtime.runCommand(s.id, "goal-set", JSON.stringify({ objective: "finish the user's task", tokenBudget: 12000 }));
    expect(spy).toHaveBeenCalledWith("thread/goal/set", { threadId: s.runtimeRef, origin: "user", objective: "finish the user's task", status: "active", tokenBudget: 12000 });
    await runtime.runCommand(s.id, "goal-pause", "");
    expect(spy).toHaveBeenLastCalledWith("thread/goal/set", { threadId: s.runtimeRef, origin: "user", status: "paused" });
    await runtime.runCommand(s.id, "goal-clear", "");
    expect(spy).toHaveBeenLastCalledWith("thread/goal/clear", { threadId: s.runtimeRef });
    const count = spy.mock.calls.length;
    await expect(runtime.runCommand(s.id, "goal", "")).rejects.toThrow(/目标/);
    await expect(runtime.runCommand(s.id, "goal-set", '{"objective":"x","tokenBudget":-1}')).rejects.toThrow(/正整数/);
    expect(spy.mock.calls).toHaveLength(count);
  });

  it("does not change a live turn's mode or goal", async () => {
    const s = await start("[[slow]]");
    await until(() => store.getSession(s.id)!.status === "running");
    await expect(runtime.runCommand(s.id, "plan", "on")).rejects.toThrow(/当前回复/);
    await expect(runtime.runCommand(s.id, "goal", "finish this")).rejects.toThrow(/当前回复/);
    expect(servers.fakes.get("p-ds")!.calls.some((c) => c.method === "thread/goal/set")).toBe(false);
  });

  it("only attaches callable apps and sends a native mention", async () => {
    const s = await start();
    const client = servers.handles.get("p-ds")!.client;
    const request = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation((method, params, options) => {
      if (method === "app/installed") return Promise.resolve({ apps: [{ id: "test-app", runtimeName: "Test App", enabled: true, callable: true }, { id: "blocked", enabled: false, callable: false }] }) as never;
      if (method === "thread/goal/get") return Promise.resolve({ goal: null }) as never;
      return request(method, params, options) as never;
    });
    expect((await runtime.listCommands(s.id)).codex).toMatchObject({ goal: null, apps: [{ id: "test-app", name: "Test App" }] });
    await expect(runtime.runCommand(s.id, "app", JSON.stringify({ id: "blocked", text: "hello" }))).rejects.toThrow(/不可用/);
    await runtime.runCommand(s.id, "app", JSON.stringify({ id: "test-app", text: "use this app" }));
    await until(() => replied(s.id, "FAKE: use this app"));
    expect(servers.fakes.get("p-ds")!.calls.find((c) => c.method === "turn/start")?.params).toMatchObject({ input: [{ type: "text", text: "use this app" }, { type: "mention", name: "Test App", path: "app://test-app" }] });
  });

  it("shows retries on the turn, not as rows, and clears them once the model answers", async () => {
    const seen: unknown[] = [];
    runtime.on("event", (e) => {
      if (e.type === "item.updated" && e.item.type === "turn" && e.item.retry) seen.push(e.item.retry);
    });
    const s = await start("[[retry]]");
    await until(() => replied(s.id, "FAKE-RETRIED"), "reply");
    expect(seen).toEqual([
      { attempt: 1, max: 5, reason: "连接中断" },
      { attempt: 2, max: 5, reason: "连接中断" },
    ]);
    expect(ofType(s.id, "turn")[0]!.retry).toBeUndefined();
    expect(ofType(s.id, "error")).toHaveLength(0);
  });

  it("turns warnings into notices, repeats collapsed, hooks only when they block or fail", async () => {
    const s = await start("[[notices]]");
    await until(() => replied(s.id, "FAKE-NOTICED"), "reply");
    expect(ofType(s.id, "notice").map((n) => [n.level, n.message, n.count ?? 1])).toEqual([
      ["warning", "这一轮改用了 gpt-5.5-mini，不是 gpt-5.5（涉及高风险网络安全内容）。", 1],
      ["info", "Heads up: long threads can be less accurate.", 2],
      ["warning", "The guardian blocked a risky command.", 1],
      ["warning", "MCP 服务 docs 没能启动：spawn docs-mcp ENOENT", 1],
      ["warning", "Hook guard.ps1（preToolUse）拦截了这一步：rm is not allowed", 1],
    ]);
  });

  it("gives the remaining item types a row", async () => {
    const s = await start("[[items]]");
    await until(() => replied(s.id, "FAKE-ITEMS"), "reply");
    expect(ofType(s.id, "tool").map((t) => [t.name, t.kind, t.summary, t.status])).toEqual([
      ["view_image", "read", "C:\\work\\shot.png", "completed"],
      ["image_generation", "other", "a red cube", "completed"],
      ["hook_prompt", "other", "Hook 补充了提示", "completed"],
      ["collab.wait", "subagent", "2 个子 agent", "completed"],
      ["sleep", "other", "等待 3 秒", "completed"],
      ["tools.lookup", "other", "", "completed"],
    ]);
    const [view, generated] = ofType(s.id, "tool");
    expect(view!.images).toEqual([{ id: null, path: "C:\\work\\shot.png" }]);
    expect(generated!.images).toEqual([{ id: null, path: "C:\\work\\cube.png" }]);
    expect(ofType(s.id, "tool")[5]!.detail).toBe("42");
  });

  it("shows an MCP call's progress and what the agent typed into a command", async () => {
    const s = await start("[[progress]]");
    await until(() => replied(s.id, "FAKE-PROGRESS"), "reply");
    const [mcp, command] = ofType(s.id, "tool");
    expect(mcp).toMatchObject({ name: "docs.index", progress: "indexed 40 of 120 files" });
    // The empty write (reading the output) leaves the progress as it was.
    expect(command).toMatchObject({ name: "shell", progress: "已向命令输入：y" });
  });
});

describe("Codex CLI helpers", () => {
  it("reads /code-review arguments as a review target", () => {
    expect(reviewTarget("")).toEqual({ type: "uncommittedChanges" });
    expect(reviewTarget("base main")).toEqual({ type: "baseBranch", branch: "main" });
    expect(reviewTarget("commit 1a2b3c4")).toEqual({ type: "commit", sha: "1a2b3c4", title: null });
    expect(reviewTarget("看看并发问题")).toEqual({ type: "custom", instructions: "看看并发问题" });
  });

  it("reads a retry from an error with willRetry", () => {
    expect(codexRetry({ message: "Reconnecting... 3/5", codexErrorInfo: "serverOverloaded" })).toEqual({ attempt: 3, max: 5, reason: "服务繁忙" });
    expect(codexRetry({ message: "Retrying", codexErrorInfo: null, additionalDetails: "timeout\nmore" })).toEqual({ attempt: 1, reason: "timeout" });
  });

  it("completes items without a status of their own once they are done", () => {
    expect(describeTool({ type: "sleep", id: "x", durationMs: 1500 }, undefined, false).status).toBe("running");
    expect(describeTool({ type: "sleep", id: "x", durationMs: 1500 }, undefined, true)).toMatchObject({ status: "completed", summary: "等待 2 秒", durationMs: 1500 });
  });
});
