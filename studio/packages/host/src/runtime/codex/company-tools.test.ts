import { describe, expect, it, vi } from "vitest";
import { CodexCompanyTools } from "./company-tools.js";
import type { CodexRpcClient } from "./rpc-client.js";

const catalog = (ready: boolean) => ({ data: [{ name: "amo", runtimeStatus: "connected", toolsError: null, tools: ready ? { company_group_read: { name: "company_group_read" }, company_message_send: { name: "company_message_send" } } : {} }], nextCursor: null });
const mockClient = (request: ReturnType<typeof vi.fn>) => ({ request }) as unknown as CodexRpcClient;

describe("Codex company MCP compatibility", () => {
  it("checks only once per connection and thread when both actual tools are present", async () => {
    const request = vi.fn(async () => catalog(true)), client = mockClient(request), tools = new CodexCompanyTools();
    await tools.ensure(client, "thread", () => true, () => true);
    await tools.ensure(client, "thread", () => true, () => true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("mcpServerStatus/list", { threadId: "thread", serverName: "amo", detail: "toolsAndAuthOnly", limit: 100 }, { timeoutMs: 10_000 });
    await tools.ensure(mockClient(request), "thread", () => true, () => true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refreshes an old catalog using the official API, then verifies it without starting or resuming a turn", async () => {
    let reloaded = false, afterReload = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config/mcpServer/reload") { reloaded = true; return {}; }
      if (method === "mcpServerStatus/list") return catalog(reloaded && ++afterReload > 1);
      throw new Error("unexpected mutation");
    });
    await new CodexCompanyTools().ensure(mockClient(request), "old-thread", () => true, () => true);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["mcpServerStatus/list", "config/mcpServer/reload", "mcpServerStatus/list", "mcpServerStatus/list"]);
  });

  it("never refreshes a running profile or inspects a running recipient", async () => {
    let profileIdle = false;
    const request = vi.fn(async (method: string) => method === "mcpServerStatus/list" ? catalog(profileIdle) : {}), client = mockClient(request), tools = new CodexCompanyTools();
    await expect(tools.ensure(client, "busy", () => false, () => true)).rejects.toMatchObject({ deliveryNotAttempted: true });
    expect(request).not.toHaveBeenCalled();
    await expect(tools.ensure(client, "idle", () => true, () => profileIdle)).rejects.toMatchObject({ deliveryNotAttempted: true, message: expect.stringContaining("仍有任务运行") });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["mcpServerStatus/list"]);
    profileIdle = true;
    await tools.ensure(client, "idle", () => true, () => true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares a check for duplicate sends and invalidates only the changed thread", async () => {
    const request = vi.fn(async () => catalog(true)), client = mockClient(request), tools = new CodexCompanyTools();
    await Promise.all([tools.ensure(client, "one", () => true, () => true), tools.ensure(client, "one", () => true, () => true)]);
    await tools.ensure(client, "two", () => true, () => true);
    expect(request).toHaveBeenCalledTimes(2);
    tools.invalidate(client, "one");
    await tools.ensure(client, "two", () => true, () => true);
    await tools.ensure(client, "one", () => true, () => true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("shares a reload across simultaneous old threads on an idle profile", async () => {
    let ready = false;
    const request = vi.fn(async (method: string) => {
      if (method === "config/mcpServer/reload") { await Promise.resolve(); ready = true; return {}; }
      return catalog(ready);
    });
    const client = mockClient(request), tools = new CodexCompanyTools();
    await Promise.all([tools.ensure(client, "one", () => true, () => true), tools.ensure(client, "two", () => true, () => true)]);
    expect(request.mock.calls.filter(([method]) => method === "config/mcpServer/reload")).toHaveLength(1);
  });

  it("labels unsupported discovery as not attempted without exposing raw server diagnostics", async () => {
    const request = vi.fn(async () => { throw new Error("unsupported method; token=private"); });
    await expect(new CodexCompanyTools().ensure(mockClient(request), "thread", () => true, () => true)).rejects.toMatchObject({ deliveryNotAttempted: true, code: "runtime_error", message: expect.not.stringContaining("private") });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses to send if a person starts work while discovery is pending", async () => {
    let idle = true;
    const request = vi.fn(async () => { idle = false; return catalog(true); });
    await expect(new CodexCompanyTools().ensure(mockClient(request), "thread", () => idle, () => idle)).rejects.toMatchObject({ deliveryNotAttempted: true, message: expect.stringContaining("开始了另一项任务") });
  });
});
