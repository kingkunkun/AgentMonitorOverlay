import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { Store } from "../../store/store.js";
import { CodexRuntime } from "./codex-runtime.js";
import { FakeServers } from "./fake-servers.test-support.js";
import type { CodexRpcClient } from "./rpc-client.js";

const profiles: ModelProfile[] = [{ id: "profile", label: "Mock", runtime: "codex", provider: null, model: null }];
let store: Store, servers: FakeServers, runtime: CodexRuntime;
beforeEach(() => { store = new Store(":memory:"); servers = new FakeServers(profiles); runtime = new CodexRuntime({ store, servers, profiles }); });
afterEach(async () => { await servers.close(); store.close(); });

async function setup(ready: boolean) {
  const workspace = store.addWorkspace({ path: "C:/sandbox/ws", name: "Mock" });
  const task = store.createTask({ title: "Mock", workspaceId: workspace.id });
  const session = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "profile", workspace });
  const handle = await servers.ensure("profile"), request = handle.client.request.bind(handle.client), calls: string[] = [];
  handle.client.request = ((method, params, options) => {
    calls.push(method);
    if (method === "mcpServerStatus/list") return Promise.resolve({ data: [{ name: "amo", runtimeStatus: "connected", toolsError: null, tools: ready ? { company_group_read: { name: "company_group_read" }, company_message_send: { name: "company_message_send" } } : {} }], nextCursor: null });
    if (method === "config/mcpServer/reload") { ready = true; return Promise.resolve({}); }
    return request(method, params, options);
  }) as CodexRpcClient["request"];
  const append = (method: string) => store.appendItem({ id: "held-" + calls.length, sessionId: session.id, type: "user", text: "Check the assigned build", delivery: "held", createdAt: new Date().toISOString(), raw: { runtime: "codex", method } });
  return { session, calls, append, task, workspace };
}

describe("company inbox preparation in CodexRuntime", () => {
  it("does not inspect or refresh MCP for an ordinary held chat message", async () => {
    const { session, calls, append } = await setup(false);
    await runtime.resend(session.id, append("user/inbox").id);
    expect(calls).not.toContain("mcpServerStatus/list");
    expect(calls).not.toContain("config/mcpServer/reload");
    expect(calls.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("refreshes an existing thread before sending the explicit company job", async () => {
    const { session, calls, append } = await setup(false);
    await runtime.resend(session.id, append("user/company-inbox").id);
    expect(calls.slice(0, 3)).toEqual(["mcpServerStatus/list", "config/mcpServer/reload", "mcpServerStatus/list"]);
    expect(calls.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(calls).not.toContain("turn/interrupt");
    expect(calls).not.toContain("thread/resume");
  });

  it("leaves the input unsent and does not refresh another running task on the same profile", async () => {
    const { session, calls, append, task, workspace } = await setup(false);
    store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "profile", workspaceId: workspace.id, title: "other task", status: "running", writer: "workbench", runtimeRef: "other-native-thread" });
    const item = append("user/company-inbox");
    await expect(runtime.resend(session.id, item.id)).rejects.toMatchObject({ deliveryNotAttempted: true });
    expect(store.getItem(item.id)).toMatchObject({ delivery: "held" });
    expect(calls).toEqual(["mcpServerStatus/list"]);
  });

  it("does not steer a company job into a person's turn that has started without a notification yet", async () => {
    const { session, calls, append } = await setup(true);
    const handle = await servers.ensure("profile"), request = handle.client.request.bind(handle.client);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let starting = false;
    handle.client.request = ((method, params, options) => {
      if (method === "turn/start") { starting = true; return blocked.then(() => request(method, params, options)); }
      return request(method, params, options);
    }) as CodexRpcClient["request"];
    const person = runtime.sendMessage(session.id, "Continue my existing work");
    while (!starting) await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      const item = append("user/company-inbox");
      await expect(runtime.resend(session.id, item.id)).rejects.toMatchObject({ deliveryNotAttempted: true });
      expect(store.getItem(item.id)).toMatchObject({ delivery: "held" });
      expect(calls).not.toContain("mcpServerStatus/list");
      expect(calls).not.toContain("turn/steer");
    } finally { release!(); await person; }
  });
});
