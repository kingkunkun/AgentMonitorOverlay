import { isCommon, type Session, type SessionStatus, type Task, type Workspace } from "@amo-studio/protocol";
import { needsPerson } from "../lib/status.js";

// 看板时间线 (2026-11-23, plans/board-timeline.md): the board lists every folder's tasks newest first, each naming the
// folder it runs in, with a folder filter and quick filters on top. These are the rules, kept apart from the view.

/** A folder the board can filter on: a project, the common space, or another computer a copy runs on. */
export interface Folder {
  key: string;
  /** What the chip and the card say: the project's name, 「公共」, 「远程 · 台式机」. */
  label: string;
  /** The tooltip: the folder's path, or where a copy runs. */
  title: string;
}

export interface FolderCount extends Folder {
  count: number;
  /** The latest activity of its tasks: the chips go newest first. */
  latest: string;
}

/** The folder a task belongs to. A copy of a remote task is filed under the computer it runs on. */
export function folderOf(task: Pick<Task, "workspaceId" | "remote">, workspaces: readonly Workspace[]): Folder {
  const r = task.remote;
  if (r) {
    const where = r.project === undefined ? "" : r.project === null ? "：公共目录" : `：${r.project}`;
    return { key: `remote:${r.account}/${r.device}`, label: `远程 · ${r.name}`, title: `在 ${r.name} 上运行${where}` };
  }
  const ws = workspaces.find((w) => w.id === task.workspaceId);
  if (!ws) return { key: task.workspaceId, label: "未知文件夹", title: "这个任务的文件夹已不在项目列表里" };
  if (isCommon(ws)) return { key: ws.id, label: "公共", title: ws.path ? `公共目录（没选项目时用）：${ws.path}` : "公共目录（没选项目时用）" };
  return { key: ws.id, label: ws.name, title: ws.path || ws.name };
}

/** The folders of these tasks with their counts, the one with the newest activity first. */
export function folderCounts(tasks: readonly Task[], workspaces: readonly Workspace[], activity: (task: Task) => string): FolderCount[] {
  const by = new Map<string, FolderCount>();
  for (const task of tasks) {
    const folder = folderOf(task, workspaces);
    const at = activity(task);
    const known = by.get(folder.key);
    if (known) {
      known.count += 1;
      if (at > known.latest) known.latest = at;
    } else by.set(folder.key, { ...folder, count: 1, latest: at });
  }
  return [...by.values()].sort((a, b) => b.latest.localeCompare(a.latest) || a.label.localeCompare(b.label));
}

/** When the task last moved: itself, or the newest of its live sessions (a reply ending, a message sent). */
export function activityAt(task: Pick<Task, "updatedAt">, sessions: readonly Pick<Session, "updatedAt" | "archivedAt">[]): string {
  let at = task.updatedAt;
  for (const s of sessions) if (!s.archivedAt && s.updatedAt > at) at = s.updatedAt;
  return at;
}

export type DayGroup = "today" | "yesterday" | "week" | "earlier";
export const DAY_GROUP_NAMES: Record<DayGroup, string> = { today: "今天", yesterday: "昨天", week: "近 7 天", earlier: "更早" };
const DAY_GROUPS: readonly DayGroup[] = ["today", "yesterday", "week", "earlier"];

/** Which day heading a time goes under, by this computer's calendar days. */
export function dayGroup(iso: string, now: Date = new Date()): DayGroup {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "earlier";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (t >= today) return "today";
  if (t >= today - day) return "yesterday";
  if (t >= today - 6 * day) return "week";
  return "earlier";
}

/** Rows under their day headings, in the order given (newest first), headings without rows left out. */
export function groupByDay<T>(rows: readonly T[], at: (row: T) => string, now: Date = new Date()): Array<{ group: DayGroup; rows: T[] }> {
  const by = new Map<DayGroup, T[]>();
  for (const row of rows) {
    const g = dayGroup(at(row), now);
    const list = by.get(g);
    if (list) list.push(row);
    else by.set(g, [row]);
  }
  return DAY_GROUPS.filter((g) => by.has(g)).map((group) => ({ group, rows: by.get(group)! }));
}

/** 快速筛选: 全部, 需要我处理 (waits on the person, a decision, or finished unseen), 进行中, 新完成未看. */
export type QuickFilter = "all" | "attention" | "running" | "unseen";
export const QUICK_FILTERS: readonly QuickFilter[] = ["all", "attention", "running", "unseen"];
export const QUICK_FILTER_NAMES: Record<QuickFilter, string> = { all: "全部", attention: "需要我处理", running: "进行中", unseen: "新完成未看" };

export interface RowFacts {
  /** The task's status from its sessions (taskStatus); null with none. */
  status: SessionStatus | null;
  /** One of its sessions is running. */
  running: boolean;
  /** A reply ended (or failed) since the person last looked: 新完成. */
  unseen: boolean;
  decisions: number;
}

export function matchesFilter(filter: QuickFilter, facts: RowFacts): boolean {
  if (filter === "attention") return needsPerson(facts.status) || facts.decisions > 0 || facts.unseen;
  if (filter === "running") return facts.running;
  if (filter === "unseen") return facts.unseen;
  return true;
}

/** Newest activity first; the same time keeps a fixed order. */
export function byActivity(a: { at: string; id: string }, b: { at: string; id: string }): number {
  return b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
}
