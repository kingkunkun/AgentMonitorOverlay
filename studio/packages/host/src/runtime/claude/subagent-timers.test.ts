import { expect, it, vi } from "vitest";
import { ClaudeSubagents } from "./subagents.js";

it("does not read transcripts after runtime shutdown", () => {
  vi.useFakeTimers();
  try {
    const child = { id: "child", parentId: "parent" };
    const subagents = new ClaudeSubagents({ setStatus: () => undefined, store: { getSession: () => child } } as never, {} as never);
    const read = vi.fn(() => false);
    subagents.fillFromLog = read;
    subagents.end({ subUsage: new Map() } as never, "child", "completed");
    expect(read).toHaveBeenCalledTimes(1);
    subagents.stop();
    vi.advanceTimersByTime(2500);
    expect(read).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
