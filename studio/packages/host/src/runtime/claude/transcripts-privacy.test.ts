import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../store/store.js";
import { readTranscript, hasTranscript } from "./transcripts.js";
import { listOutsideSessions, previewOutsideSession } from "./outside.js";
import { ClaudeSubagents } from "./subagents.js";
import type { ClaudeCore } from "./core.js";
import type { ClaudeTurns } from "./turns.js";

const { read, list, fsReads } = vi.hoisted(() => ({ read: vi.fn(async () => []), list: vi.fn(async () => []), fsReads: vi.fn(() => false) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ getSessionMessages: read, listSessions: list }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: fsReads }));
const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.clearAllMocks(); });
it("native history enumeration/preview and unknown references never reach SDK or disk", async () => {
  const store = new Store(":memory:"); stores.push(store);
  const home = { dir: "not-a-real-user-directory", login: "local" as const };
  expect(await listOutsideSessions(home, store, [])).toEqual([]);
  expect(await previewOutsideSession(home, "native-private-session")).toBeNull();
  expect(hasTranscript("native-private-session", home, store)).toBe(false);
  expect(() => readTranscript("native-private-session", "fixture", home, store)).toThrow("隐私规则");
  expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(fsReads).not.toHaveBeenCalled();
});
it("only WorkStudio-owned references can resume; old adopted sessions and descendant forks are denied", async () => {
  const store = new Store(":memory:"); stores.push(store);
  const home = { dir: "fixture-home", login: "token" as const };
  const workspace = store.addWorkspace({ name: "fixture", path: "fixture-project" });
  const task = store.createTask({ title: "WorkStudio", workspaceId: workspace.id });
  const owned = store.createSession({ title: "WorkStudio", runtime: "claude", runtimeRef: "own-ref", profileId: "p", status: "idle", writer: "workbench", kind: "main", topicId: null, taskId: task.id, workspaceId: workspace.id, parentId: null });
  await readTranscript("own-ref", "fixture-project", home, store);
  expect(read).toHaveBeenCalledTimes(1); read.mockClear();
  store.setKv("claude-adopted:old", owned.id);
  store.createSession({ ...owned, id: "fork", runtimeRef: "fork-ref", parentId: owned.id });
  for (const ref of ["own-ref", "fork-ref"]) {
    expect(() => readTranscript(ref, "fixture-project", home, store)).toThrow("隐私规则");
    expect(hasTranscript(ref, home, store)).toBe(false);
  }
  expect(read).not.toHaveBeenCalled(); expect(fsReads).not.toHaveBeenCalled();
  const homeOf = vi.fn(() => { throw new Error("native paths must not be inspected"); });
  const subagents = new ClaudeSubagents({ store, homeOf } as unknown as ClaudeCore, {} as ClaudeTurns);
  const child = store.createSession({ ...owned, id: "legacy-sub", kind: "sub", parentId: owned.id, runtimeRef: "own-ref/agent/tool-1" });
  expect(subagents.fillFromLog(child)).toBe(false); expect(homeOf).not.toHaveBeenCalled();
});
