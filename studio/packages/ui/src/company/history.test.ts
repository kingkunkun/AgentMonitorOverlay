import { describe, expect, it, vi } from "vitest";
import type { CompanyMessage, CompanyMessagePage } from "@amo-studio/protocol";
import { companyHistory, emptyHistory, type CompanyHistoryState } from "./history.js";

const message = (id: number) => ({ id: `m${id}`, createdAt: String(id).padStart(4, "0"), deliveries: [] } as unknown as CompanyMessage);
const page = (ids: number[], hasMore = false): CompanyMessagePage => ({ messages: ids.map(message), hasMore });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("company group history requests", () => {
  it("does not apply a late pagination result after leaving a room", async () => {
    const older = deferred<CompanyMessagePage>(), changed = vi.fn();
    const history = companyHistory(async (before) => before ? older.promise : page([3, 4], true), changed);
    await history.refresh();
    const work = history.loadOlder();
    history.stop(); changed.mockClear();
    older.resolve(page([1, 2])); await work;
    expect(changed).not.toHaveBeenCalled();
    const otherRoom = companyHistory(async () => page([10]), changed);
    await otherRoom.refresh(); expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [message(10)] }));
  });
  it("resets to a complete newest page after reconnect, canceling the previous older-page request", async () => {
    const older = deferred<CompanyMessagePage>(); let latest = page([3, 4], true), state: CompanyHistoryState = emptyHistory();
    const history = companyHistory(async (before) => before ? older.promise : latest, (next) => { state = next; });
    await history.refresh(); const work = history.loadOlder();
    latest = page([90, 91], true); await history.refresh(true);
    older.resolve(page([1, 2])); await work;
    expect(state.messages.map((m) => m.id)).toEqual(["m90", "m91"]);
    expect(state.hasMore).toBe(true); expect(state.loadingMore).toBe(false);
  });
  it("detects a gap even without a reconnect event", async () => {
    let latest = page([1, 2]), state = emptyHistory();
    const history = companyHistory(async () => latest, (next) => { state = next; });
    await history.refresh(); latest = page([100, 101], true); await history.refresh();
    expect(state.messages).toEqual(latest.messages); expect(state.hasMore).toBe(true);
  });
  it("preserves loaded older messages when newer pages overlap, and recovers from pagination errors", async () => {
    let latest = page([3, 4], true), fail = true, state = emptyHistory();
    const history = companyHistory(async (before) => { if (before && fail) throw new Error("暂时离线"); return before ? page([1, 2]) : latest; }, (next) => { state = next; });
    await history.refresh(); await history.loadOlder();
    expect(state.error).toBe("暂时离线"); expect(state.messages).toEqual(latest.messages); expect(state.loadingMore).toBe(false);
    fail = false; await history.loadOlder(); latest = page([4, 5], true); await history.refresh();
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]); expect(state.hasMore).toBe(false); expect(state.error).toBe("");
  });
  it("ignores out-of-order newest-page responses", async () => {
    const first = deferred<CompanyMessagePage>(); let count = 0, state = emptyHistory();
    const history = companyHistory(async () => ++count === 1 ? first.promise : page([2, 3]), (next) => { state = next; });
    const stale = history.refresh(); await history.refresh(); first.resolve(page([1])); await stale;
    expect(state.messages.map((m) => m.id)).toEqual(["m2", "m3"]);
  });
});
