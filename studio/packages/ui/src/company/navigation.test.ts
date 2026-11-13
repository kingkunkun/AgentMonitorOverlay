import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backTo, withOrigin } from "../shell/views.js";
import { readPlace, savePlace } from "../shell/lastPlace.js";

const store = new Map<string, string>();
describe("company navigation preserves existing project work", () => {
  beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }; });
  afterEach(() => { store.clear(); delete (globalThis as { localStorage?: unknown }).localStorage; });
  it("returns from an agent session to the exact group and retains project scope after reload", () => {
    const origin = { kind: "company", tab: "rooms", roomId: "build" } as const;
    const task = withOrigin({ kind: "task", taskId: "task-build", sessionId: "session-build" }, origin);
    expect(backTo(task.kind === "task" ? task.back : undefined)).toEqual({ view: origin, label: "Agent 工作台" });
    savePlace(task, { kind: "workspace", id: "existing-project" });
    expect(readPlace()).toMatchObject({ view: { kind: "task", taskId: "task-build", back: origin }, scope: { kind: "workspace", id: "existing-project" } });
  });
  it("restores the chosen member and rejects an invalid stored company tab", () => {
    savePlace({ kind: "company", tab: "agents", agentId: "high" }, { kind: "all" });
    expect(readPlace().view).toEqual({ kind: "company", tab: "agents", agentId: "high" });
    store.set("amo.lastPlace", JSON.stringify({ view: { kind: "company", tab: "invalid" } }));
    expect(readPlace().view).toEqual({ kind: "board" });
  });
});
