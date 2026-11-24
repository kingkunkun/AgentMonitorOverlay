import { useState } from "react";
import { TASK_COLUMNS, type RemoteState, type Session, type Task, type TaskColumn, type Topic, type Workspace } from "@amo-studio/protocol";
import { useTopicsVisible } from "../lib/topicsVisible.js";
import type { HostLink } from "../host/client.js";
import { copyStatus, grantsOf, useRemote, type CopyStatus } from "../remote/remote.js";
import { takenText, teamTaken, teamWaits, useSeenTaken, useTeamThreads } from "../teamrelay/TeamRelay.js";
import { COLUMN_NAMES, relativeTime, SESSION_LOOK, taskStatus } from "../lib/status.js";
import { unseenSessions, useSessionSeen, withGrants } from "../lib/sessionSeen.js";
import { ArchiveIcon } from "../task/Archived.js";
import { ArchivedTasks } from "./ArchivedTasks.js";
import { KindIcon } from "./KindIcon.js";
import { setBoardFilter, setBoardFolder, setBoardMode, setGroupByTopic, useBoardFilter, useBoardFolder, useBoardMode, useGroupByTopic, type BoardMode } from "./prefs.js";
import { activityAt, byActivity, DAY_GROUP_NAMES, folderCounts, folderOf, groupByDay, matchesFilter, QUICK_FILTER_NAMES, QUICK_FILTERS, type FolderCount, type QuickFilter, type RowFacts } from "./timeline.js";
import { dutyOfTask, useDuty } from "../duty/duty.js";
import { RunIndicator } from "../lib/RunIndicator.js";

/** What the board shows: everything, one topic's tasks, or one project's. Archived tasks are never on the board. */
export type Scope = { kind: "all" } | { kind: "topic"; id: string } | { kind: "workspace"; id: string };

export function inScope(task: Task, scope: Scope): boolean {
  if (task.archivedAt) return false;
  if (scope.kind === "all") return true;
  if (scope.kind === "topic") return task.topicId === scope.id;
  return task.workspaceId === scope.id;
}

/** A column's cards under their topics (2026-10-19, 按专题分组): topics in the order their newest card comes, none last. */
export function topicGroups(cards: readonly Task[], topics: readonly Topic[]): Array<{ topic: Topic | null; tasks: Task[] }> {
  const groups = new Map<string, { topic: Topic | null; tasks: Task[] }>();
  const none: Task[] = [];
  for (const task of cards) {
    const topic = task.topicId ? topics.find((t) => t.id === task.topicId) : undefined;
    if (!topic) {
      none.push(task);
      continue;
    }
    const g = groups.get(topic.id);
    if (g) g.tasks.push(task);
    else groups.set(topic.id, { topic, tasks: [task] });
  }
  return [...groups.values(), ...(none.length ? [{ topic: null, tasks: none }] : [])];
}

interface BoardProps {
  tasks: readonly Task[];
  sessions: readonly Session[];
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  scope: Scope;
  onOpen(task: Task): void;
  /** A card dropped on another column (the person moves cards; agents never do). */
  onMove?(task: Task, column: TaskColumn): void;
  /** Unread mail and open decisions per task id. */
  mail?: ReadonlyMap<string, number>;
  decisions?: ReadonlyMap<string, number>;
  /** Checklist progress per task id (tasks made from a pack template). */
  checklist?: ReadonlyMap<string, { done: number; total: number }>;
  /** 归档已完成: 归档 at the right of the 完成 column's head archives its cards, the one on a topic group's head that group's (2026-10-28; a right-click menu before). */
  onArchive?(tasks: readonly Task[]): void;
  /** 远程 (step 2): where copies of remote tasks run and whether they can be reached; what this computer granted. */
  link?: HostLink;
}

const ALL: Scope = { kind: "all" };

const EMPTY: Record<QuickFilter, string> = { all: "这里还没有任务", attention: "没有要你处理的任务", running: "没有进行中的任务", unseen: "新完成的任务都看过了" };

/**
 * 看板 (2026-11-23, plans/board-timeline.md): every folder's tasks, newest activity first. 时间线 (the default) lists
 * them by day with quick filters; 分列 keeps the four columns, where the person moves cards (drag a card onto another
 * column) and agents never do. Cards carry no buttons; a 待审阅 row in the timeline has 完成 beside it.
 */
export function Board({ tasks, sessions, workspaces, topics, scope, onOpen, onMove, mail, decisions, checklist, onArchive, link }: BoardProps) {
  const remote = useRemote(link ?? null);
  const teamThreads = useTeamThreads(link ?? null);
  const { seen: seenTaken } = useSeenTaken(teamThreads);
  const seenData = useSessionSeen();
  const topicsOn = useTopicsVisible();
  const mode = useBoardMode();
  const folderPick = useBoardFolder();
  const filter = useBoardFilter();
  const groupOn = useGroupByTopic();
  const [dragging, setDragging] = useState<Task | null>(null);
  const [over, setOver] = useState<TaskColumn | null>(null);

  // The board holds every folder's tasks (2026-11-23). Picking a project on the left, or opening a chat in one, used to
  // narrow it to that project, so a task run in another folder seemed gone; the folder bar on top narrows it now. A
  // topic's board still holds that topic's tasks.
  const boardScope: Scope = scope.kind === "topic" ? scope : ALL;
  const byTask = sessionsByTask(sessions);
  const sessionsOf = (task: Task): Session[] => byTask.get(task.id) ?? [];
  const at = new Map(tasks.map((t) => [t.id, activityAt(t, sessionsOf(t))]));
  const atOf = (task: Task): string => at.get(task.id) ?? task.updatedAt;
  const inBoard = tasks.filter((t) => inScope(t, boardScope));
  const folders = folderCounts(inBoard, workspaces, atOf);
  const folder = folderPick !== "all" && folders.some((f) => f.key === folderPick) ? folderPick : "all";
  const inFolder = (t: Task) => folder === "all" || folderOf(t, workspaces).key === folder;
  const visible = inBoard.filter(inFolder).sort((a, b) => byActivity({ at: atOf(a), id: a.id }, { at: atOf(b), id: b.id }));
  // 新完成: a reply of the task ended (or failed) since the person last looked at it, as Focus counts it.
  const unseen = new Set(unseenSessions(sessions, withGrants(seenData, tasks, sessions)).flatMap((s) => (s.taskId ? [s.taskId] : [])));
  const factsOf = new Map<string, RowFacts>(
    visible.map((t) => {
      const own = sessionsOf(t);
      return [t.id, { status: taskStatus(own), running: own.some((s) => !s.archivedAt && s.status === "running"), unseen: unseen.has(t.id), decisions: decisions?.get(t.id) ?? 0 }];
    }),
  );
  const filterCount = (f: QuickFilter) => visible.filter((t) => matchesFilter(f, factsOf.get(t.id)!)).length;
  const archive = (list: readonly Task[]) => {
    if (list.length) onArchive?.(list);
  };
  // 按专题分组: wherever the board holds more than one topic's tasks (not in a topic's own board).
  const canGroup = topicsOn && boardScope.kind !== "topic";
  const grouped = canGroup && groupOn;
  const waitingOf = (task: Task): string[] => {
    const own = sessionsOf(task);
    return [...teamWaits(teamThreads, own), ...teamTaken(teamThreads, own, Date.now(), seenTaken).map(takenText)];
  };
  const archivedHere = <ArchivedTasks tasks={tasks.filter(inFolder)} workspaces={workspaces} topics={topics} scope={boardScope} onOpen={onOpen} />;

  const head = (
    <div className="board-head">
      <ModeSwitch mode={mode} />
      <FolderBar folders={folders} total={inBoard.length} value={folder} />
      <div className="board-tools">
        {mode === "timeline" && (
          <div className="board-filters" role="group" aria-label="快速筛选">
            {QUICK_FILTERS.map((f) => {
              const n = f === "all" ? visible.length : filterCount(f);
              const attn = f === "attention" && n > 0;
              return (
                <button key={f} type="button" className={["board-chip", filter === f ? "on" : "", attn ? "attn" : ""].filter(Boolean).join(" ")} aria-pressed={filter === f} onClick={() => setBoardFilter(f)} data-testid="board-filter" data-filter={f}>
                  {QUICK_FILTER_NAMES[f]}
                  <span className="board-chip-count">{n}</span>
                </button>
              );
            })}
          </div>
        )}
        <span className="board-tools-gap" />
        {mode === "columns" && canGroup && (
          <label className="board-toggle" title="每一列里，任务按专题分组排列；没归专题的排在最后">
            <input type="checkbox" checked={groupOn} onChange={(e) => setGroupByTopic(e.target.checked)} data-testid="board-group-topics" />
            按专题分组
          </label>
        )}
      </div>
    </div>
  );

  if (mode === "timeline") {
    const rows = visible.filter((t) => matchesFilter(filter, factsOf.get(t.id)!));
    return (
      <section className="board-tl" aria-label="看板" data-testid="board-timeline">
        {head}
        <div className="tl-list">
          {groupByDay(rows, atOf).map((g) => (
            <div className="tl-group" key={g.group} data-testid="timeline-group" data-group={g.group}>
              <div className="tl-group-head">
                <span className="tl-group-name">{DAY_GROUP_NAMES[g.group]}</span>
                <span className="tl-group-count">{g.rows.length}</span>
              </div>
              {g.rows.map((task) => (
                <TimelineRow
                  key={task.id}
                  task={task}
                  at={atOf(task)}
                  sessions={sessionsOf(task)}
                  facts={factsOf.get(task.id)!}
                  workspaces={workspaces}
                  topics={topics}
                  topicsOn={topicsOn && boardScope.kind !== "topic"}
                  remote={remote}
                  onOpen={onOpen}
                  // 待审阅 piles up (Studio moves a card there when its sessions stop and never on): 完成 takes it off.
                  {...(onMove && !task.remote && task.column === "review" ? { onDone: () => onMove(task, "done") } : {})}
                  mail={mail?.get(task.id) ?? 0}
                  teamWaiting={waitingOf(task)}
                  {...(checklist?.get(task.id) ? { checklist: checklist.get(task.id)! } : {})}
                />
              ))}
            </div>
          ))}
          {rows.length === 0 && <div className="empty-col">{EMPTY[filter]}</div>}
          <div className="tl-archived">{archivedHere}</div>
        </div>
      </section>
    );
  }

  const card = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      sessions={sessionsOf(task)}
      teamWaiting={waitingOf(task)}
      scope={boardScope}
      grouped={grouped}
      topicsOn={topicsOn}
      unseen={unseen.has(task.id)}
      workspaces={workspaces}
      topics={topics}
      onOpen={onOpen}
      remote={remote}
      // A copy of a remote task has the column its own computer gives it.
      draggable={!!onMove && !task.remote}
      onDragStart={() => setDragging(task)}
      onDragEnd={() => {
        setDragging(null);
        setOver(null);
      }}
      mail={mail?.get(task.id) ?? 0}
      decisions={decisions?.get(task.id) ?? 0}
      {...(checklist?.get(task.id) ? { checklist: checklist.get(task.id)! } : {})}
    />
  );

  return (
    <section className="board with-tools" aria-label="看板">
      {head}
      {TASK_COLUMNS.map((col) => {
        const cards = visible.filter((t) => t.column === col);
        const archivable = col === "done" && !!onArchive;
        return (
          <div
            className={over === col && dragging && dragging.column !== col ? "column drop" : "column"}
            key={col}
            data-testid={`column-${col}`}
            onDragOver={(e) => {
              if (!dragging || !onMove) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (over !== col) setOver(col);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === col ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging && onMove && dragging.column !== col) onMove(dragging, col);
              setDragging(null);
              setOver(null);
            }}
          >
            <div className="column-head">
              <span className="column-name">{COLUMN_NAMES[col]}</span>
              <span className="column-count">{cards.length}</span>
              {archivable && cards.length > 0 && (
                <button type="button" className="bar-btn labeled soft-danger column-archive" title={`归档全部已完成（${cards.length}）：任务和它们的会话一起归档；在「已归档」里能打开、恢复`} onClick={() => archive(cards)} data-testid="archive-done-all">
                  <ArchiveIcon size={14} />
                  全部归档
                </button>
              )}
            </div>
            {grouped
              ? topicGroups(cards, topics).map((g, i) => (
                  <div className="topic-group" key={g.topic?.id ?? ""} data-testid="topic-group" data-topic={g.topic?.title ?? ""} data-group-index={i}>
                    <div className={g.topic ? "topic-group-head" : "topic-group-head none"}>
                      <KindIcon kind="topic" />
                      <span className="topic-group-name">{g.topic?.title ?? "未归专题"}</span>
                      <span className="topic-group-count">{g.tasks.length}</span>
                      <span className="topic-group-rule" />
                      {archivable && (
                        <button type="button" className="bar-btn soft-danger group-archive" aria-label={`归档「${g.topic?.title ?? "未归专题"}」这一组`} title={`归档「${g.topic?.title ?? "未归专题"}」这一组（${g.tasks.length}）：任务和它们的会话一起归档`} onClick={() => archive(g.tasks)} data-testid="archive-done-group">
                          <ArchiveIcon size={13} />
                        </button>
                      )}
                    </div>
                    {g.tasks.map(card)}
                  </div>
                ))
              : cards.map(card)}
            {cards.length === 0 && <div className="empty-col">空</div>}
            {/* Archived tasks leave the board; the last column offers them. */}
            {col === TASK_COLUMNS[TASK_COLUMNS.length - 1] && archivedHere}
          </div>
        );
      })}
    </section>
  );
}

function sessionsByTask(sessions: readonly Session[]): Map<string, Session[]> {
  const by = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.taskId) continue;
    const list = by.get(s.taskId);
    if (list) list.push(s);
    else by.set(s.taskId, [s]);
  }
  return by;
}

/** 文件夹: 全部, then one chip per folder, the one with the newest activity first; a second click goes back to 全部. */
function FolderBar({ folders, total, value }: { folders: readonly FolderCount[]; total: number; value: string }) {
  return (
    <div className="board-folders" role="toolbar" aria-label="按文件夹筛选" data-testid="board-folders">
      <button type="button" className={value === "all" ? "board-chip on" : "board-chip"} aria-pressed={value === "all"} onClick={() => setBoardFolder("all")} title="所有文件夹的任务" data-testid="board-folder" data-folder-key="all">
        全部
        <span className="board-chip-count">{total}</span>
      </button>
      {folders.map((f) => (
        <button key={f.key} type="button" className={value === f.key ? "board-chip on" : "board-chip"} aria-pressed={value === f.key} onClick={() => setBoardFolder(value === f.key ? "all" : f.key)} title={f.title} data-testid="board-folder" data-folder-key={f.key}>
          <KindIcon kind="workspace" />
          <span className="board-chip-name">{f.label}</span>
          <span className="board-chip-count">{f.count}</span>
        </button>
      ))}
    </div>
  );
}

function ModeSwitch({ mode }: { mode: BoardMode }) {
  const modes: Array<{ id: BoardMode; label: string; title: string }> = [
    { id: "timeline", label: "时间线", title: "所有任务排成一列，最近有动静的在最上面" },
    { id: "columns", label: "分列", title: "按 待办 / 进行中 / 待审阅 / 完成 分四列，可以拖动卡片换列" },
  ];
  return (
    <div className="board-mode" role="group" aria-label="看板显示方式">
      {modes.map((m) => (
        <button key={m.id} type="button" className={mode === m.id ? "on" : ""} aria-pressed={mode === m.id} onClick={() => setBoardMode(m.id)} title={m.title} data-testid={`board-mode-${m.id}`}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

function TaskCard({
  task,
  sessions,
  scope,
  grouped = false,
  workspaces,
  topics,
  onOpen,
  draggable = false,
  onDragStart,
  onDragEnd,
  mail = 0,
  decisions = 0,
  checklist,
  remote = null,
  teamWaiting = [],
  topicsOn = false,
  unseen = false,
}: {
  remote?: RemoteState | null;
  task: Task;
  sessions: Session[];
  scope: Scope;
  /** Under its topic's group head: the card does not name the topic again. */
  grouped?: boolean;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  onOpen(t: Task): void;
  draggable?: boolean;
  onDragStart?(): void;
  onDragEnd?(): void;
  mail?: number;
  decisions?: number;
  checklist?: { done: number; total: number };
  /** 会话里用中转 (2026-10-30): 「等 X 回复（中转）· 已等 …」, one per person its sessions wait on. */
  teamWaiting?: string[];
  /** Topics are shown (界面设置): the card names its topic, or 未归专题. */
  topicsOn?: boolean;
  /** A reply of it ended since the person last looked: 新完成. */
  unseen?: boolean;
}) {
  const status = taskStatus(sessions);
  const look = status ? SESSION_LOOK[status] : null;
  // 值守 (2026-10-31): items on that open sessions in this task.
  const duty = dutyOfTask(useDuty(), task.id);
  // 远程 (step 2): a copy says where it runs and whether that computer can be reached; a task of this computer says
  // which devices it is granted to.
  const copy: CopyStatus | null = copyStatus(task, remote);
  const off = !!copy && (copy.state === "offline" || copy.state === "revoked");
  const granted = grantsOf(remote, task.id);
  const live = sessions.filter((s) => !s.archivedAt);
  const mains = live.filter((s) => s.kind === "main");
  const branches = live.length - mains.length;

  // 归属行 (2026-10-19): 「专题 › 文件夹」 above the title. The folder is always named (2026-11-23: the board holds
  // every folder's tasks), the common space as 公共; the topic only while topics are shown and the scope (or the topic
  // group) does not already say it. In 全部任务 a task in no topic says so.
  const folder = copy ? null : folderOf(task, workspaces);
  const project = folder?.label ?? null;
  const showTopic = topicsOn && scope.kind !== "topic" && !grouped;
  const topic = showTopic && task.topicId ? (topics.find((t) => t.id === task.topicId)?.title ?? null) : null;
  const noTopic = showTopic && !topic && scope.kind === "all";
  const meta = [mains.length ? `${mains.length} 个会话` : task.firstMessage ? "还没有会话 · 第一句话已写好" : "还没有会话", branches ? `${branches} 个分支` : "", checklist ? `清单 ${checklist.done}/${checklist.total}` : ""].filter(Boolean).join(" · ");
  // Collaboration hints are counts in the meta line, not a second status: the dot keeps one status per card.
  const asks = [decisions ? `${decisions} 个待决策` : "", mail ? `${mail} 条留言` : ""].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      className={off ? "card remote-off" : "card"}
      onClick={() => onOpen(task)}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
      data-testid="task-card"
      data-task-id={task.id}
      {...(copy ? { "data-remote": copy.state } : {})}
    >
      {copy && (
        <span className="card-where card-remote" data-testid="card-remote" title={`在 ${copy.name}（${task.remote!.account}）上运行：模型调用和命令都在那台电脑上`}>
          <span className="remote-badge">远程</span>
          <span className="card-remote-where">{off ? copy.label : `在 ${copy.name} 上`}</span>
          {/* Its project on that computer (2026-11-09), when that computer says it. */}
          {task.remote?.project !== undefined && (
            <span className="card-remote-project" title={task.remote.project ? `${copy.name} 上的项目：${task.remote.project}` : `在 ${copy.name} 的公共目录里运行`} data-testid="card-remote-project">
              · {task.remote.project ?? "未指定项目"}
            </span>
          )}
        </span>
      )}
      {(topic || noTopic || project) && !copy && (
        <span className="card-where" data-testid="card-where">
          {topic && (
            <span className="card-topic" title={`专题：${topic}`}>
              <KindIcon kind="topic" />
              {topic}
            </span>
          )}
          {noTopic && <span className="card-topic none">未归专题</span>}
          {(topic || noTopic) && project && (
            <span className="card-where-sep" aria-hidden="true">
              ›
            </span>
          )}
          {project && (
            <span className="card-project" title={folder?.title ?? project}>
              <KindIcon kind="workspace" />
              <span className="card-project-name">{project}</span>
            </span>
          )}
        </span>
      )}
      <span className="card-title">
        {task.lead && (
          <span className="lead-badge" title="主控：协调这个专题（或项目）的任务" data-testid="lead-badge">
            主控
          </span>
        )}
        {duty.length > 0 && (
          <span className="duty-chip" title={`值守开着：${duty.map((i) => i.title).join("、")}。到点（检查到有事）会在这个任务里开会话`} data-testid="card-duty">
            值守
          </span>
        )}
        {unseen && (
          <span className="new-badge" title="有回复结束了，你还没看过" data-testid="card-new">
            新完成
          </span>
        )}
        {task.title || "未命名任务"}
      </span>
      <span className="card-status">
        {look ? (
          <>
            {status === "running" ? <RunIndicator status={status} /> : <span className="dot" style={{ background: look.dot }} />}
            <span style={{ color: look.text }}>{look.label}</span>
          </>
        ) : (
          <>
            <span className="dot" style={{ background: "var(--muted-dot)" }} />
            <span>未开始</span>
          </>
        )}
        <span className="spacer" />
        <span>{relativeTime(task.updatedAt)}</span>
      </span>
      <span className="card-meta">{meta}</span>
      {asks && (
        <span className="card-asks" data-testid="card-asks">
          {asks}
        </span>
      )}
      {teamWaiting.map((w) => (
        <span key={w} className="card-asks card-team" data-testid="card-team-wait">
          {w}
        </span>
      ))}
      {granted.length > 0 && (
        <span className="card-granted" data-testid="card-granted" title="这个任务授权给了你的其他设备远程使用（任务页的 ⋯ 或顶栏的「远程」里可以收回）">
          已授权给 {granted.map((g) => g.name).join("、")}
        </span>
      )}
    </button>
  );
}

/** 时间线的一行: status, title, folder, column, when it last moved; 完成 beside it while it waits in 待审阅. */
function TimelineRow({
  task,
  at,
  sessions,
  facts,
  workspaces,
  topics,
  topicsOn,
  remote,
  onOpen,
  onDone,
  mail,
  teamWaiting,
  checklist,
}: {
  task: Task;
  /** Its latest activity (timeline.activityAt). */
  at: string;
  sessions: Session[];
  facts: RowFacts;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  topicsOn: boolean;
  remote: RemoteState | null;
  onOpen(t: Task): void;
  onDone?(): void;
  mail: number;
  teamWaiting: string[];
  checklist?: { done: number; total: number };
}) {
  const { status, unseen, decisions } = facts;
  const look = status ? SESSION_LOOK[status] : null;
  const duty = dutyOfTask(useDuty(), task.id);
  const copy: CopyStatus | null = copyStatus(task, remote);
  const off = !!copy && (copy.state === "offline" || copy.state === "revoked");
  const granted = grantsOf(remote, task.id);
  const folder = folderOf(task, workspaces);
  const topic = topicsOn && task.topicId ? (topics.find((t) => t.id === task.topicId)?.title ?? null) : null;
  const live = sessions.filter((s) => !s.archivedAt);
  const mains = live.filter((s) => s.kind === "main").length;
  const meta = [mains ? `${mains} 个会话` : task.firstMessage ? "第一句话已写好" : "还没有会话", checklist ? `清单 ${checklist.done}/${checklist.total}` : ""].filter(Boolean).join(" · ");
  const asks = [decisions ? `${decisions} 个待决策` : "", mail ? `${mail} 条留言` : "", ...teamWaiting].filter(Boolean).join(" · ");
  const className = ["tl-row", unseen ? "unseen" : "", off ? "remote-off" : ""].filter(Boolean).join(" ");

  return (
    <div className={className} data-testid="timeline-row" data-task-id={task.id}>
      <button type="button" className="tl-card" onClick={() => onOpen(task)} data-testid="task-card" data-task-id={task.id} {...(copy ? { "data-remote": copy.state } : {})}>
        <span className="tl-status">{facts.running ? <RunIndicator status="running" /> : <span className="dot" style={{ background: look?.dot ?? "var(--muted-dot)" }} />}</span>
        <span className="tl-main">
          <span className="tl-title">
            {unseen && (
              <span className="new-badge" title="有回复结束了，你还没看过" data-testid="card-new">
                新完成
              </span>
            )}
            {task.lead && (
              <span className="lead-badge" title="主控：协调这个专题（或项目）的任务" data-testid="lead-badge">
                主控
              </span>
            )}
            {duty.length > 0 && (
              <span className="duty-chip" title={`值守开着：${duty.map((i) => i.title).join("、")}`} data-testid="card-duty">
                值守
              </span>
            )}
            <span className="tl-title-text">{task.title || "未命名任务"}</span>
          </span>
          <span className="tl-sub">
            <span className="tl-folder" title={copy ? `在 ${copy.name} 上运行` : folder.title} data-testid="card-folder">
              {copy ? <span className="remote-badge">远程</span> : <KindIcon kind="workspace" />}
              <span className="tl-folder-name">{copy ? (off ? copy.label : (task.remote?.project ?? copy.name)) : folder.label}</span>
            </span>
            {topic && (
              <span className="card-topic" title={`专题：${topic}`}>
                <KindIcon kind="topic" />
                {topic}
              </span>
            )}
            <span className="tl-state" style={look ? { color: look.text } : undefined}>
              {look?.label ?? "未开始"}
            </span>
            <span className={`tl-column col-${task.column}`}>{COLUMN_NAMES[task.column]}</span>
            <span className="tl-meta">{meta}</span>
            {asks && (
              <span className="card-asks" data-testid="card-asks">
                {asks}
              </span>
            )}
            {granted.length > 0 && (
              <span className="card-granted" data-testid="card-granted" title="这个任务授权给了你的其他设备远程使用">
                已授权给 {granted.map((g) => g.name).join("、")}
              </span>
            )}
          </span>
        </span>
        <span className="tl-time" title={new Date(at).toLocaleString()}>
          {relativeTime(at)}
        </span>
      </button>
      {onDone && (
        <button type="button" className="bar-btn labeled tl-done" onClick={onDone} title="看过了：移到「完成」，它就不再待审阅" data-testid="timeline-done">
          完成
        </button>
      )}
    </div>
  );
}
