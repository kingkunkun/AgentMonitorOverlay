import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { boundedChatContext, composeChatContext, splitChatContext, splitRoleUpdate, type ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of clean.splice(0)) await run(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "amo-continuation-")); mkdirSync(join(root, "project"));
  const profiles: ModelProfile[] = [{ id: "first", label: "第一个渠道", runtime: "codex", provider: "one", model: null }, { id: "second", label: "另一个渠道", runtime: "codex", provider: "two", model: null }];
  const store = new Store(join(root, "studio.db")); const servers = new FakeServers(profiles);
  const runtime = new CodexRuntime({ store, servers, profiles }); const host = new HostService(store, runtime, profiles);
  clean.push(async () => { await host.buildJob.stop(); await servers.close(); store.close(); removeTempDir(root); });
  const workspace = store.addWorkspace({ name: "项目", path: join(root, "project") });
  const { task, session } = await host.tasks.createTask({ title: "同一个聊天", workspaceId: workspace.id, firstSession: { profileId: "first" } });
  return { host, store, runtime, task, source: session! };
}

it("creates a same-task continuation without a turn and carries only this chat's user/assistant text once", async () => {
  const { host, store, runtime, task, source } = await setup();
  store.appendItem({ id: "old-u", sessionId: source.id, type: "user", text: "请记住橙色机器人", createdAt: new Date().toISOString() });
  store.appendItem({ id: "old-a", sessionId: source.id, type: "agent", markdown: "已经记住", streaming: false, createdAt: new Date().toISOString() });
  store.appendItem({ id: "old-tool", sessionId: source.id, type: "notice", message: "PRIVATE_TOOL_OUTPUT", level: "info", createdAt: new Date().toISOString() });
  const original = store.listItems(source.id);
  const send = vi.spyOn(runtime, "sendMessage").mockResolvedValue({ mode: "start" });
  const next = await host.sessions.continueWithModel(source.id, "second");
  expect(next).toMatchObject({ taskId: task.id, profileId: "second", workspaceId: source.workspaceId });
  expect(send).not.toHaveBeenCalled();
  expect(store.listItems(source.id)).toEqual(original);
  await host.sessions.sendMessage(next.id, "接着说");
  const first = splitChatContext(splitRoleUpdate(send.mock.calls[0]![1]).text);
  expect(first.text).toBe("接着说");
  expect(first.context?.messages).toEqual([{ role: "user", text: "请记住橙色机器人" }, { role: "assistant", text: "已经记住" }]);
  expect(send.mock.calls[0]![1]).not.toContain("PRIVATE_TOOL_OUTPUT");
  await host.sessions.sendMessage(next.id, "再继续");
  expect(splitChatContext(splitRoleUpdate(send.mock.calls[1]![1]).text).context).toBeNull();
});

it("refuses running or imported-native chats and retries context after a failed initial send", async () => {
  const { host, store, runtime, source } = await setup();
  store.updateSession(source.id, { status: "running" });
  await expect(host.sessions.continueWithModel(source.id, "second")).rejects.toThrow("等待");
  expect(store.listSessions()).toHaveLength(1);
  store.updateSession(source.id, { status: "idle" });
  await expect(host.sessions.continueWithModel(source.id, "second", "not-an-offered-model")).rejects.toThrow("型号");
  const privacy = vi.spyOn(host.cooperation, "taskAllowed").mockReturnValue(false);
  await expect(host.sessions.continueWithModel(source.id, "second")).rejects.toThrow("原生"); privacy.mockRestore();
  const next = await host.sessions.continueWithModel(source.id, "second");
  const send = vi.spyOn(runtime, "sendMessage").mockRejectedValueOnce(new Error("not accepted")).mockResolvedValue({ mode: "start" });
  await expect(host.sessions.sendMessage(next.id, "hello")).rejects.toThrow("not accepted");
  await host.sessions.sendMessage(next.id, "hello again");
  expect(splitChatContext(splitRoleUpdate(send.mock.calls[1]![1]).text).context).not.toBeNull();
});

it("bounds long histories and safely round-trips code, newlines and delimiter-like content", () => {
  const context = boundedChatContext("s", "旧聊天", [{ role: "user", text: "x".repeat(70000) }, { role: "assistant", text: "<script>\n一句话\n</script>" }]);
  expect(context.truncated).toBe(true); expect(context.messages.reduce((n, m) => n + m.text.length, 0)).toBe(60000);
  expect(splitChatContext(composeChatContext("新的要求", context))).toEqual({ text: "新的要求", context });
});

it("keeps a team message pending when it arrives while the previous context send is in flight", async () => {
  const { host, runtime, task, source } = await setup();
  await host.sessions.receiveTeamInbox(task.id, "第一封来信", "同事");
  let finish!: (value: { mode: "start" }) => void;
  const send = vi.spyOn(runtime, "sendMessage").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ mode: "start" });
  const pending = host.sessions.sendMessage(source.id, "回复第一封");
  await host.sessions.receiveTeamInbox(task.id, "第二封来信", "同事");
  finish({ mode: "start" }); await pending;
  await host.sessions.sendMessage(source.id, "继续回复");
  expect(send.mock.calls[1]![1]).toContain("第二封来信");
});
