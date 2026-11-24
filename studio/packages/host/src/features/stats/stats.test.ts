import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { localDate } from "./service.js";
import { reconcileCodex } from "./ledger.js";

// 设置 → 统计 (2026-10-27): tokens per day and model, from the turns.

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "p-claude", label: "Claude", runtime: "claude", provider: "anthropic", model: null },
];

let root: string;
let servers: FakeServers;
let store: Store;
let host: HostService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-stats-"));
  mkdirSync(join(root, "alpha"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  host = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
});

afterEach(async () => {
  store?.close();
  await servers?.close();
  removeTempDir(root);
});

let n = 0;
function session(taskId: string, workspaceId: string, profileId: string, kind: Session["kind"] = "main", parentId: string | null = null): Session {
  return store.createSession({ taskId, topicId: null, parentId, kind, runtime: profileId === "p-ds" ? "codex" : "claude", profileId, workspaceId, title: profileId, status: "idle", writer: "workbench", runtimeRef: null });
}
function turn(sessionId: string, startedAt: string, usage?: { input: number; cachedInput: number; output: number }): void {
  n += 1;
  store.appendItem({ id: `t${n}`, sessionId, type: "turn", turnId: `turn-${n}`, state: "completed", startedAt, createdAt: startedAt, ...(usage ? { usage: { ...usage, reasoning: 0 } } : {}) } as never);
}

describe("token stats", () => {
  it("counts each turn once, per local day and model; input leaves out what came from the cache; subagents count under their own model", async () => {
    const ws = host.projects.addWorkspace({ path: join(root, "alpha") });
    const task = (await host.tasks.createTask({ title: "统计", workspaceId: ws.id })).task;
    const ds = session(task.id, ws.id, "p-ds");
    const claude = session(task.id, ws.id, "p-claude");
    const sub = session(task.id, ws.id, "p-ds", "sub", claude.id);
    const gone = session(task.id, ws.id, "ch-deleted");
    const day1 = new Date(2026, 9, 26, 10).toISOString(), day1late = new Date(2026, 9, 26, 23, 50).toISOString(), day2 = new Date(2026, 9, 27, 0, 10).toISOString();
    turn(ds.id, day1, { input: 1000, cachedInput: 600, output: 50 });
    turn(ds.id, day1late, { input: 500, cachedInput: 0, output: 20 });
    turn(ds.id, day2, { input: 300, cachedInput: 300, output: 10 });
    turn(claude.id, day2, { input: 2000, cachedInput: 1500, output: 100 });
    turn(sub.id, day2, { input: 100, cachedInput: 0, output: 5 });
    turn(gone.id, day2, { input: 10, cachedInput: 0, output: 1 });
    turn(claude.id, day2); // no usage (interrupted before any call): not counted
    turn(claude.id, day2, { input: 0, cachedInput: 0, output: 0 });

    const stats = await host.stats.tokens();
    expect(stats.turns).toBe(6);
    expect(stats.days.every(d => d.source === "studio" && d.unclassified === 0)).toBe(true);
    expect(stats.days).toMatchObject([
      { date: "2026-10-26", profileId: "p-ds", input: 900, cached: 600, output: 70, turns: 2 },
      { date: "2026-10-27", profileId: "ch-deleted", input: 10, cached: 0, output: 1, turns: 1 },
      { date: "2026-10-27", profileId: "p-claude", input: 500, cached: 1500, output: 100, turns: 1 },
      { date: "2026-10-27", profileId: "p-ds", input: 100, cached: 300, output: 15, turns: 2 },
    ]);
    expect(stats.models.sort((a, b) => a.profileId.localeCompare(b.profileId))).toEqual([
      { profileId: "ch-deleted", label: "ch-deleted", runtime: null, model: null, removed: true },
      { profileId: "p-claude", label: "Claude", runtime: "claude", model: null, removed: false },
      { profileId: "p-ds", label: "DS", runtime: "codex", model: "ds-model", removed: false },
    ]);
    expect(Date.parse(stats.generatedAt)).not.toBeNaN();

    // 按时间段查 (2026-11-10): to the minute, `to` left out; most used first.
    const range = host.stats.tokensBetween(new Date(2026, 9, 26, 23, 0).toISOString(), new Date(2026, 9, 27, 0, 10).toISOString());
    expect(range.turns).toBe(1);
    expect(range.rows).toEqual([{ profileId: "p-ds", input: 500, cached: 0, output: 20, turns: 1 }]);
    const wide = host.stats.tokensBetween(new Date(2026, 9, 26).toISOString(), new Date(2026, 9, 28).toISOString());
    expect(wide.turns).toBe(6);
    expect(wide.rows.map((r) => r.profileId)).toEqual(["p-claude", "p-ds", "ch-deleted"]);
    expect(wide.models.map((m) => m.profileId).sort()).toEqual(["ch-deleted", "p-claude", "p-ds"]);
    expect(() => host.stats.tokensBetween("x", "y")).toThrow("要写成时间");
    expect(() => host.stats.tokensBetween(day2, day1)).toThrow("早于");
  });

  it("unions local meters with Studio, charges native children once, excludes remote copies and keeps lifetime gaps out of today", async () => {
    host.options.meterPaths = { codex: root, claude: root, claudeConfig: join(root, "test-claude.json") };
    const ws = host.projects.addWorkspace({ path: join(root, "alpha") });
    const task = (await host.tasks.createTask({ title: "用量", workspaceId: ws.id })).task;
    const ds = session(task.id, ws.id, "p-ds"), cs = session(task.id, ws.id, "claude-subscription"), remote = session(task.id, ws.id, "remote-copy");
    const ownClaude = "aaaaaaaa-0000-4000-8000-000000000001", otherClaude = "aaaaaaaa-0000-4000-8000-000000000002";
    store.db.prepare("UPDATE sessions SET runtime_ref=? WHERE id=?").run("studio-thread", ds.id);
    store.db.prepare("UPDATE sessions SET runtime_ref=? WHERE id=?").run(ownClaude, cs.id);
    store.db.prepare("UPDATE sessions SET runtime='remote' WHERE id=?").run(remote.id);
    const when = new Date(2026,8,12,10), date = localDate(when.toISOString())!;
    turn(ds.id, when.toISOString(), { input: 90, cachedInput: 70, output: 10 });
    turn(cs.id, when.toISOString(), { input: 42, cachedInput: 30, output: 8 });
    turn(remote.id, when.toISOString(), { input: 9000, cachedInput: 0, output: 0 });
    const db = new DatabaseSync(join(root, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, tokens_used INTEGER, created_at INTEGER, updated_at INTEGER, originator TEXT, title TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT)");
    const ts = when.getTime()/1000, ins = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?)");
    ins.run("studio-thread", 120, ts, ts, null, "private-transcript-marker");
    ins.run("its-child", 10, ts, ts, null, "private-transcript-marker");
    db.exec("INSERT INTO thread_spawn_edges VALUES ('studio-thread','its-child')");
    ins.run("standalone", 200, ts-86400, ts, null, "private-transcript-marker");
    db.close();
    const receipt = (id: string, input: number) => ({ lastSessionId: id, lastTotalInputTokens: input, lastTotalCacheCreationInputTokens: 2, lastTotalCacheReadInputTokens: 30, lastTotalOutputTokens: 8, lastStartTime: ts*1000, lastDuration: 1000 });
    writeFileSync(host.options.meterPaths.claudeConfig, JSON.stringify({ account: "private-account-marker", projects: { "private-project-marker": receipt(ownClaude, 10), other: receipt(otherClaude, 20) } }));
    writeFileSync(join(root, "stats-cache.json"), JSON.stringify({ lastComputedDate: date, modelUsage: { test: { inputTokens: 45, outputTokens: 55, cacheCreationInputTokens: 10, cacheReadInputTokens: 50 } } }));
    store.db.prepare("INSERT INTO studio_request_usage VALUES(?,?,?,?,?)").run(date, "gpt-6.2-sol", 3, 5, 2);
    const stats = await host.stats.tokens();
    expect(stats.sources.map(s => [s.source,s.total])).toEqual([["studio",190],["codex",200],["claude",60],["claude-shared",50]]);
    expect(stats.total).toBe(500);
    expect(stats.turns).toBe(2);
    expect(stats.days.find(d => d.source === "codex")).toMatchObject({ date: "", unclassified: 200, turns: 0 });
    expect(stats.days.find(d => d.source === "claude")).toMatchObject({ date, input: 22, cached: 30, output: 8 });
    expect((await host.stats.tokens(true)).days).toEqual(stats.days);
    expect(await host.stats.tokens()).toBe(await host.stats.tokens());
    const serialized = JSON.stringify([stats, store.db.prepare("SELECT * FROM device_token_meters").all()]);
    for (const marker of [ownClaude,otherClaude,"private-","studio-thread","its-child"]) expect(serialized).not.toContain(marker);
  });

  it("dates by the local day", () => {
    expect(localDate(new Date(2026, 0, 5, 0, 30).toISOString())).toBe("2026-01-05");
    expect(localDate("not a time")).toBeNull();
  });

  it("keeps cross-midnight balance changes undated and does not replay a reset or a pruned meter", () => {
    const at = (day: number, hour: number, min = 0) => new Date(2026, 8, day, hour, min).getTime();
    const read = (tokens: number, end: number) => reconcileCodex(store.db, [{ key: "synthetic-meter", tokens, start: at(1,10), end, studio: 0 }], new Set(), end);
    read(100, at(1,23,50)); read(110, at(2,0,10)); read(120, at(2,12));
    read(20, at(2,13)); read(120, at(2,14));
    const saved = reconcileCodex(store.db, [], new Set(), at(3,10)).get("synthetic-meter");
    expect(saved).toMatchObject({ tokens: 120, days: { "2026-09-01": 100, "": 10, "2026-09-02": 10 } });
  });
});
