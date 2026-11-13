import type { codex } from "@amo-studio/protocol";
import type { CodexRpcClient } from "./rpc-client.js";

const REQUIRED = ["company_group_read", "company_message_send", "company_work_read", "company_work_report", "company_self_improve"] as const;
const RPC_TIMEOUT_MS = 10_000;

/** Preparation failed before any user input reached Codex. The inbox may offer an ordinary retry. */
export function companyToolsUnavailable(message: string): Error & { deliveryNotAttempted: true; code: "runtime_error" } {
  return Object.assign(new Error(message), { deliveryNotAttempted: true as const, code: "runtime_error" as const });
}

interface ConnectionState {
  verified: Set<string>;
  checking: Map<string, Promise<void>>;
  refreshing?: Promise<void>;
}

/**
 * A retained app-server may still have the previous Host's AMO tool catalog. Only explicit company inbox work
 * checks it, once per thread/connection. No process restart, configuration write, or change to normal chat turns.
 * Official app-server reload queues a refresh for loaded threads; we additionally wait for this profile to be idle.
 */
export class CodexCompanyTools {
  private readonly connections = new WeakMap<CodexRpcClient, ConnectionState>();

  invalidate(client: CodexRpcClient, threadId?: string | null): void {
    const state = this.connections.get(client);
    if (threadId) state?.verified.delete(threadId);
    else state?.verified.clear();
  }

  async ensure(client: CodexRpcClient, threadId: string, idle: () => boolean, profileIdle: () => boolean): Promise<void> {
    if (!idle()) throw companyToolsUnavailable("公司群任务等待当前会话空闲后才能发送，请稍后重试；没有打断已有任务。");
    let state = this.connections.get(client);
    if (!state) { state = { verified: new Set(), checking: new Map() }; this.connections.set(client, state); }
    if (state.verified.has(threadId)) return;
    const pending = state.checking.get(threadId);
    if (pending) return pending;
    const check = this.check(client, threadId, state, idle, profileIdle);
    state.checking.set(threadId, check);
    try { await check; }
    finally { state.checking.delete(threadId); }
  }

  private async check(client: CodexRpcClient, threadId: string, state: ConnectionState, idle: () => boolean, profileIdle: () => boolean): Promise<void> {
    try {
      if (state.refreshing) await state.refreshing;
      if (!(await this.available(client, threadId))) {
        if (!idle() || !profileIdle()) throw companyToolsUnavailable("Codex 的公司群工具需要刷新；这个模型渠道仍有任务运行，请等任务空闲后重试。没有刷新或重启运行中的任务。");
        if (!state.refreshing) {
          state.verified.clear();
          state.refreshing = client.request("config/mcpServer/reload", undefined, { timeoutMs: RPC_TIMEOUT_MS }).then(() => undefined);
        }
        const refreshing = state.refreshing;
        try { await refreshing; }
        finally { if (state.refreshing === refreshing) state.refreshing = undefined; }
        // reload queues work in the native thread. Its response need not mean that discovery has finished yet.
        let ready = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (!idle()) throw companyToolsUnavailable("当前会话开始了另一项任务，公司群消息尚未发送，请空闲后重试。");
          if (await this.available(client, threadId)) { ready = true; break; }
          if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!ready) throw companyToolsUnavailable("Codex 尚未提供公司群读取和发送工具，本条群任务没有启动。请检查 AMO MCP 是否启用、Codex 是否支持刷新，再重试。");
      }
      if (!idle()) throw companyToolsUnavailable("当前会话开始了另一项任务，公司群消息尚未发送，请空闲后重试。");
      state.verified.add(threadId);
    } catch (err) {
      if (err && typeof err === "object" && "deliveryNotAttempted" in err) throw err;
      // No input has been sent, including when this old server does not support discovery/reload. Never expose
      // raw server error data here: a provider may put endpoints or credentials in its diagnostic response.
      throw companyToolsUnavailable("无法核对 Codex 的公司群工具，本条群任务没有启动。请检查 Codex 连接与 AMO MCP，待会话空闲后重试。");
    }
  }

  private async available(client: CodexRpcClient, threadId: string): Promise<boolean> {
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result = await client.request("mcpServerStatus/list", { threadId, serverName: "amo", detail: "toolsAndAuthOnly", limit: 100, ...(cursor ? { cursor } : {}) }, { timeoutMs: RPC_TIMEOUT_MS }) as codex.v2.ListMcpServerStatusResponse;
      if (!Array.isArray(result?.data)) return false;
      for (const server of result.data) {
        if (server.name !== "amo" || server.toolsError || ["authenticationRequired", "failed", "cancelled", "disabled"].includes(server.runtimeStatus ?? "")) continue;
        const names = new Set(Object.entries(server.tools ?? {}).flatMap(([key, tool]) => [key, tool?.name ?? ""]));
        if (REQUIRED.every((name) => names.has(name) || names.has(`mcp__amo__${name}`))) return true;
      }
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) return false;
      if (cursor) cursors.add(cursor);
    } while (cursor && cursors.size < 20);
    return false;
  }
}
