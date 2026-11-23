import { describe, expect, it } from "vitest";
import type { Task, Workspace } from "@amo-studio/protocol";
import { activityAt, byActivity, dayGroup, folderCounts, folderOf, groupByDay, matchesFilter } from "./timeline.js";

const ws = (id: string, name: string, path: string, builtin?: "common") => ({ id, name, path, createdAt: "", ...(builtin ? { builtin } : {}) }) as Workspace;
const task = (id: string, workspaceId: string, updatedAt: string, extra: Partial<Task> = {}) => ({ id, workspaceId, updatedAt, topicId: null, column: "review", archivedAt: null, ...extra }) as Task;
const workspaces = [ws("w-common", "common", "C:/studio/common", "common"), ws("w-codex", "Codex", "D:/Codex"), ws("w-mine", "project_mining_2", "D:/project_mining_2")];

describe("看板时间线：文件夹", () => {
  it("names the project, the common space as 公共, a copy by the computer it runs on", () => {
    expect(folderOf(task("a", "w-codex", ""), workspaces)).toEqual({ key: "w-codex", label: "Codex", title: "D:/Codex" });
    expect(folderOf(task("b", "w-common", ""), workspaces).label).toBe("公共");
    expect(folderOf(task("c", "w-gone", ""), workspaces).label).toBe("未知文件夹");
    const copy = task("d", "w-common", "", { remote: { account: "acc", device: "pc", name: "台式机", state: "active", profiles: [], allowed: [], grantedAt: "", project: "游戏" } });
    expect(folderOf(copy, workspaces)).toEqual({ key: "remote:acc/pc", label: "远程 · 台式机", title: "在 台式机 上运行：游戏" });
  });

  it("counts each folder's tasks and puts the folder with the newest activity first", () => {
    const tasks = [task("a", "w-codex", "2026-11-20T10:00:00Z"), task("b", "w-mine", "2026-11-23T09:00:00Z"), task("c", "w-codex", "2026-11-22T08:00:00Z"), task("d", "w-common", "2026-11-21T08:00:00Z")];
    const folders = folderCounts(tasks, workspaces, (t) => t.updatedAt);
    expect(folders.map((f) => [f.label, f.count, f.latest])).toEqual([
      ["project_mining_2", 1, "2026-11-23T09:00:00Z"],
      ["Codex", 2, "2026-11-22T08:00:00Z"],
      ["公共", 1, "2026-11-21T08:00:00Z"],
    ]);
  });
});

describe("看板时间线：时间", () => {
  it("takes the newest of the task and its live sessions", () => {
    const t = task("a", "w-codex", "2026-11-20T10:00:00Z");
    expect(activityAt(t, [{ updatedAt: "2026-11-22T10:00:00Z", archivedAt: null }, { updatedAt: "2026-11-23T10:00:00Z", archivedAt: "2026-11-23T10:00:00Z" }])).toBe("2026-11-22T10:00:00Z");
    expect(activityAt(t, [])).toBe("2026-11-20T10:00:00Z");
  });

  it("files times under 今天, 昨天, 近 7 天 and 更早 by calendar day", () => {
    const now = new Date(2026, 10, 23, 9, 30);
    expect(dayGroup(new Date(2026, 10, 23, 0, 5).toISOString(), now)).toBe("today");
    expect(dayGroup(new Date(2026, 10, 22, 23, 59).toISOString(), now)).toBe("yesterday");
    expect(dayGroup(new Date(2026, 10, 17, 0, 1).toISOString(), now)).toBe("week");
    expect(dayGroup(new Date(2026, 10, 16, 23, 59).toISOString(), now)).toBe("earlier");
    expect(dayGroup("not a time", now)).toBe("earlier");
  });

  it("keeps the given order under each heading and leaves out empty headings", () => {
    const now = new Date(2026, 10, 23, 12, 0);
    const rows = [
      { id: "a", at: new Date(2026, 10, 23, 11, 0).toISOString() },
      { id: "b", at: new Date(2026, 10, 23, 8, 0).toISOString() },
      { id: "c", at: new Date(2026, 10, 1, 8, 0).toISOString() },
    ].sort(byActivity);
    expect(groupByDay(rows, (r) => r.at, now).map((g) => [g.group, g.rows.map((r) => r.id)])).toEqual([
      ["today", ["a", "b"]],
      ["earlier", ["c"]],
    ]);
  });
});

describe("看板时间线：快速筛选", () => {
  const idle = { status: "idle" as const, running: false, unseen: false, decisions: 0 };
  it("需要我处理 takes what waits on the person, open decisions and replies finished unseen", () => {
    expect(matchesFilter("attention", idle)).toBe(false);
    expect(matchesFilter("attention", { ...idle, status: "awaiting-approval" })).toBe(true);
    expect(matchesFilter("attention", { ...idle, decisions: 1 })).toBe(true);
    expect(matchesFilter("attention", { ...idle, unseen: true })).toBe(true);
  });

  it("进行中 takes a running session, 新完成未看 an unseen finish, 全部 everything", () => {
    expect(matchesFilter("running", { ...idle, running: true })).toBe(true);
    expect(matchesFilter("running", idle)).toBe(false);
    expect(matchesFilter("unseen", { ...idle, unseen: true })).toBe(true);
    expect(matchesFilter("all", idle)).toBe(true);
  });
});
