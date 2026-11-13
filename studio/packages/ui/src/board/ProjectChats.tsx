import { useState, type MouseEvent } from "react";
import type { Task, Session } from "@amo-studio/protocol";
import { taskStatus } from "../lib/status.js";
import { RunIndicator } from "../lib/RunIndicator.js";
import { call, type HostLink } from "../host/client.js";
import { useStoredIds } from "../lib/storedIds.js";
import { ContextMenu } from "../lib/ContextMenu.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { Modal } from "../lib/Modal.js";
import { showToast } from "../lib/toast.js";

export function ProjectChats({ link, tasks, sessions = [], current, onOpen, pinnedOnly = false }: { link: HostLink; tasks: readonly Task[]; sessions?: readonly Session[]; current?: string; onOpen?(id: string): void; pinnedOnly?: boolean }) {
  const pins = useStoredIds("amo.chatPins");
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Task | null>(null);
  const [name, setName] = useState("");
  const [archive, setArchive] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const sorted = tasks.filter((t) => !t.archivedAt && (!pinnedOnly || pins.has(t.id))).sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.updatedAt.localeCompare(a.updatedAt));
  const shown = all || pinnedOnly ? sorted : sorted.slice(0, 5);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch (e) { showToast({ text: String(e), error: true }); } finally { setBusy(false); } };
  const openMenu = (e: MouseEvent, task: Task) => { e.preventDefault(); e.stopPropagation(); const ids = selected.has(task.id) ? [...selected] : [task.id]; setSelected(new Set(ids)); setMenu({ ids, x: e.clientX, y: e.clientY }); };
  if (pinnedOnly && !sorted.length) return null;
  return <div className={pinnedOnly ? "nav-pinned-chats" : "nav-project-chats"}>
    {pinnedOnly && <div className="nav-chat-heading">已置顶</div>}
    {shown.map((t) => {
      const own = sessions.filter((s) => s.taskId === t.id && !s.archivedAt);
      const status = taskStatus(own);
      const running = own.some((s) => s.status === "running");
      return <div key={t.id} className="nav-chat-item" data-chat-id={t.id}>
      <button type="button" className="nav-chat-row" data-testid="nav-chat" aria-current={current === t.id ? "page" : undefined} aria-selected={selected.has(t.id)} title={t.title} onContextMenu={(e) => openMenu(e, t)} onDoubleClick={() => { setRenaming(t); setName(t.title); }} onClick={(e) => { if (e.ctrlKey || e.metaKey) setSelected((old) => { const next = new Set(old); if (next.has(t.id)) next.delete(t.id); else next.add(t.id); return next; }); else { setSelected(new Set([t.id])); onOpen?.(t.id); } }}>
        {running && <RunIndicator status="running" />}{status !== "running" && <RunIndicator status={status} />}{pins.has(t.id) && <span className="nav-chat-pin" aria-label="已置顶">⌖</span>}<span>{t.title || "新聊天"}</span>
      </button><button className="nav-chat-more" aria-label={`聊天操作：${t.title}`} title="聊天操作" onClick={(e) => openMenu(e, t)}>···</button>
    </div>; })}
    {!pinnedOnly && sorted.length > 5 && <button type="button" className="nav-chat-show" onClick={() => setAll((v) => !v)}>{all ? "收起聊天" : `展开显示 · ${sorted.length - 5}`}</button>}
    {!pinnedOnly && !sorted.length && <div className="nav-chat-empty">还没有聊天</div>}
    {menu && <ContextMenu at={menu} label="聊天" onClose={() => setMenu(null)}>
      <button role="menuitem" onClick={() => { const on = !menu.ids.every((id) => pins.has(id)); for (const id of menu.ids) if (pins.has(id) !== on) pins.toggle(id); setMenu(null); }}>{menu.ids.every((id) => pins.has(id)) ? "取消置顶聊天" : "置顶聊天"}{menu.ids.length > 1 ? `（${menu.ids.length}）` : ""}</button>
      <button role="menuitem" disabled={menu.ids.length !== 1} onClick={() => { const t = tasks.find((t) => t.id === menu.ids[0]); if (t) { setRenaming(t); setName(t.title); } setMenu(null); }}>重命名聊天</button>
      <button role="menuitem" className="menu-danger" onClick={() => { setArchive(menu.ids); setMenu(null); }}>归档聊天{menu.ids.length > 1 ? `（${menu.ids.length}）` : ""}</button>
    </ContextMenu>}
    {renaming && <Modal label="重命名聊天" className="confirm-modal" onClose={() => setRenaming(null)} busy={busy}><h3>重命名聊天</h3><input className="field" aria-label="聊天名称" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void run(async () => { await call(link, "PATCH /api/tasks/:id", { id: renaming.id }, { title: name.trim() }); setRenaming(null); }); }} /><div className="settings-row end"><button className="btn-ghost" onClick={() => setRenaming(null)}>取消</button><button className="btn-primary" disabled={busy || !name.trim()} onClick={() => void run(async () => { await call(link, "PATCH /api/tasks/:id", { id: renaming.id }, { title: name.trim() }); setRenaming(null); })}>保存名称</button></div></Modal>}
    {archive && <ConfirmDialog title={`归档 ${archive.length} 个聊天？`} action="归档聊天" busy={busy} onCancel={() => setArchive(null)} onConfirm={() => void run(async () => { for (const id of archive) await call(link, "POST /api/tasks/:id/archive", { id }); setArchive(null); setSelected(new Set()); })}><p>聊天记录保留，可在设置的数据管理中恢复。正在执行的会话会停止。</p></ConfirmDialog>}
  </div>;
}
