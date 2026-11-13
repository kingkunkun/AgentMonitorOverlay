import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CompanyAgent, CompanyMessage, CompanyRoom } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { readStoredJson, writeStoredJson } from "../lib/stored.js";
import { AgentAvatar, AgentStatus } from "./AgentPanel.js";
import { errorText, useCompanyMessages } from "./data.js";
import { AGENT_STATUS, mentionAt, recipients, type CompanyDraft } from "./logic.js";

const freshDraft = (): CompanyDraft => ({ text: "", mentions: [], replyTo: null, clientMessageId: crypto.randomUUID() });
function readDraft(roomId: string): CompanyDraft {
  const value = readStoredJson(`amo.company.draft.${roomId}`) as Partial<CompanyDraft> | null;
  return value && typeof value.text === "string" ? { text: value.text, mentions: Array.isArray(value.mentions) ? value.mentions.filter((m) => m && typeof m.id === "string" && typeof m.name === "string") : [], clientMessageId: typeof value.clientMessageId === "string" ? value.clientMessageId : crypto.randomUUID(), replyTo: typeof value.replyTo === "string" ? value.replyTo : null } : freshDraft();
}
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const DELIVERY_LABEL = { pending: "待投递", queued: "排队中", sending: "正在确认送达", delivered: "已交给 Agent", failed: "投递失败", unknown: "结果待核查" } as const;

export function CompanyChat({ link, room, agents, onEditRoom, onAgent, onOpen }: { link: HostLink; room: CompanyRoom; agents: readonly CompanyAgent[]; onEditRoom(): void; onAgent(id: string): void; onOpen(taskId: string, sessionId?: string): void }) {
  const feed = useCompanyMessages(link, room.id);
  const [draft, setDraft] = useState(() => readDraft(room.id));
  const [caret, setCaret] = useState(0);
  const [suggestion, setSuggestion] = useState(0);
  const [suggestionsHidden, setSuggestionsHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState("");
  const [unknownRetry, setUnknownRetry] = useState<{ message: CompanyMessage; agentId: string } | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [below, setBelow] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const previousHeight = useRef<number | null>(null);
  const members = room.memberIds.flatMap((id) => { const a = agents.find((a) => a.id === id); return a ? [a] : []; });
  const query = !suggestionsHidden ? mentionAt(draft.text, caret) : null;
  const candidates = query ? members.filter((a) => a.enabled && `${a.name} ${a.role}`.toLocaleLowerCase().includes(query.query.toLocaleLowerCase())).slice(0, 8) : [];
  const mentions = recipients(draft.text, draft.mentions, members);
  const reply = feed.messages.find((m) => m.id === draft.replyTo);
  const scrollDown = () => { if (scroll.current) { scroll.current.scrollTop = scroll.current.scrollHeight; bottom.current = true; setBelow(false); } };
  useEffect(() => { writeStoredJson(`amo.company.draft.${room.id}`, draft); }, [draft, room.id]);
  useEffect(() => { setSuggestion(0); }, [query?.query]);
  useLayoutEffect(() => {
    const area = scroll.current;
    if (!area) return;
    if (previousHeight.current !== null) { area.scrollTop += area.scrollHeight - previousHeight.current; previousHeight.current = null; }
    else if (bottom.current) scrollDown();
    else setBelow(true);
  }, [feed.messages.length]);
  const editDraft = (text: string) => { setDraft((old) => ({ ...old, text, clientMessageId: crypto.randomUUID() })); setSuggestionsHidden(false); setError(""); };
  const choose = (agent: CompanyAgent) => {
    if (!query) return;
    const added = `@${agent.name} `;
    const text = draft.text.slice(0, query.start) + added + draft.text.slice(caret);
    const nextCaret = query.start + added.length;
    setDraft((old) => ({ ...old, text, mentions: [...old.mentions.filter((m) => m.id !== agent.id), { id: agent.id, name: agent.name }], clientMessageId: crypto.randomUUID() }));
    setCaret(nextCaret); setSuggestionsHidden(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(nextCaret, nextCaret); });
  };
  const send = async () => {
    if (busy || !draft.text.trim()) return;
    setBusy(true); setError("");
    try {
      const message = await call(link, "POST /api/company/rooms/:id/messages", { id: room.id }, { text: draft.text.trim(), mentions, replyTo: draft.replyTo, clientMessageId: draft.clientMessageId });
      const cleared = freshDraft(); writeStoredJson(`amo.company.draft.${room.id}`, cleared);
      bottom.current = true; feed.add(message); setDraft(cleared); setCaret(0); setSuggestionsHidden(true);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); requestAnimationFrame(() => input.current?.focus()); }
  };
  const retry = async (message: CompanyMessage, agentId: string, confirmUnknown = false) => {
    if (retrying) return;
    setRetrying(`${message.id}:${agentId}`); setError("");
    try { feed.add(await call(link, "POST /api/company/rooms/:id/messages/:messageId/retry", { id: room.id, messageId: message.id }, { agentId, ...(confirmUnknown ? { confirmUnknown: true } : {}) })); setUnknownRetry(null); }
    catch (e) { setError(errorText(e)); } finally { setRetrying(""); }
  };
  return <><section className="company-chat" aria-label={room.name}>
    <header className="company-chat-header"><div><h2>{room.name}</h2><span>{members.length} 位成员 · {room.description || "围绕工作沟通与分工"}</span></div><button className="btn-ghost company-members-toggle" onClick={() => setShowMembers((v) => !v)} aria-expanded={showMembers}>成员</button><button className="btn-ghost" onClick={onEditRoom} title="编辑群名称和成员" aria-label="群设置">···</button></header>
    <div className="company-chat-scroll" ref={scroll} role="log" aria-label="工作群消息" onScroll={() => { const el = scroll.current; if (el) { bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (bottom.current) setBelow(false); } }}>
      {feed.hasMore && <button className="company-older" disabled={feed.loadingMore} onClick={() => { previousHeight.current = scroll.current?.scrollHeight ?? null; void feed.loadOlder().finally(() => requestAnimationFrame(() => { previousHeight.current = null; })); }}>{feed.loadingMore ? "加载中…" : "查看更早消息"}</button>}
      {feed.error && <p className="company-inline-error" role="alert">{feed.error}<button onClick={feed.reload}>重新加载</button></p>}
      {!feed.loaded && <p className="company-empty">正在加载群消息…</p>}
      {feed.loaded && !feed.messages.length && !feed.error && <div className="company-chat-empty"><span className="company-room-symbol">#</span><h3>工作从一次沟通开始</h3><p>发布需求、讨论方案，或 @具体成员分配任务。</p><div>{members.slice(0, 5).map((a) => <AgentAvatar key={a.id} agent={a} small />)}</div></div>}
      {feed.messages.map((message) => {
        const sender = agents.find((a) => a.id === message.senderId);
        const own = sender?.kind === "human";
        const quoted = message.replyTo ? feed.messages.find((m) => m.id === message.replyTo) : null;
        return <article key={message.id} className={`company-message${own ? " own" : ""}`} data-message-id={message.id}>{sender ? <button className="company-avatar-button" onClick={() => onAgent(sender.id)} aria-label={`查看${sender.name}`}><AgentAvatar agent={sender} small /></button> : <span className="company-avatar small">?</span>}<div className="company-message-content"><header><strong>{sender?.name ?? "已移除成员"}</strong><time dateTime={message.createdAt}>{time(message.createdAt)}</time><button className="company-reply" onClick={() => { setDraft((d) => ({ ...d, replyTo: message.id, clientMessageId: crypto.randomUUID() })); input.current?.focus(); }}>回复</button></header>{message.replyTo && <div className="company-quoted">{quoted ? `${agents.find((a) => a.id === quoted.senderId)?.name ?? "成员"}：${quoted.text.slice(0, 140)}` : "引用了更早的消息"}</div>}<div className="company-message-bubble">{message.text}</div>
          {!!message.deliveries.length && <div className="company-deliveries">{message.deliveries.map((delivery) => <div key={delivery.agentId} data-status={delivery.status}>
            <span>{agents.find((a) => a.id === delivery.agentId)?.name ?? "成员"} · {DELIVERY_LABEL[delivery.status]}</span>{delivery.status === "queued" && <small>等待当前任务完成</small>}{delivery.error && <small className="company-delivery-error">{delivery.error}</small>}
            {delivery.taskId && <button onClick={() => onOpen(delivery.taskId!, delivery.sessionId ?? undefined)}>查看工作 ↗</button>}
            {delivery.status === "failed" && <button disabled={!!retrying} onClick={() => void retry(message, delivery.agentId)}>{retrying === `${message.id}:${delivery.agentId}` ? "重试中…" : "重试投递"}</button>}
            {delivery.status === "unknown" && <button disabled={!!retrying} onClick={() => setUnknownRetry({ message, agentId: delivery.agentId })}>核查后重试…</button>}
          </div>)}</div>}
        </div></article>;
      })}
    </div>
    {below && <button className="company-new-messages" onClick={scrollDown}>回到最新消息 ↓</button>}
    <form className="company-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {!!candidates.length && <div className="company-mentions" role="listbox" id={`company-mentions-${room.id}`} aria-label="选择要 @的成员">{candidates.map((a, i) => <button key={a.id} id={`company-mention-${a.id}`} type="button" role="option" aria-selected={suggestion === i} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(a)}><AgentAvatar agent={a} small /><div><strong>{a.name}</strong><small>{a.role}</small></div><span>{AGENT_STATUS[a.status]}</span></button>)}</div>}
      {draft.replyTo && <div className="company-replying"><span>回复 {reply ? `${agents.find((a) => a.id === reply.senderId)?.name ?? "成员"}：${reply.text.slice(0, 90)}` : "先前消息"}</span><button type="button" aria-label="取消回复" onClick={() => setDraft((d) => ({ ...d, replyTo: null, clientMessageId: crypto.randomUUID() }))}>×</button></div>}
      <textarea ref={input} value={draft.text} maxLength={20000} rows={3} disabled={busy} aria-label="群消息" aria-controls={candidates.length ? `company-mentions-${room.id}` : undefined} aria-activedescendant={candidates[suggestion] ? `company-mention-${candidates[suggestion]!.id}` : undefined} placeholder="输入消息，@成员分配任务…" onChange={(e) => { editDraft(e.target.value); setCaret(e.target.selectionStart); }} onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (candidates.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setSuggestion((n) => (n + (e.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length); return; }
        if (candidates.length && e.key === "Escape") { e.preventDefault(); setSuggestionsHidden(true); return; }
        if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && candidates[suggestion]) { e.preventDefault(); choose(candidates[suggestion]!); return; }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
      }} />
      {!!mentions.length && <div className="company-recipient-list"><span>接收成员</span>{mentions.map((id) => <span className="company-recipient" key={id}>@{agents.find((a) => a.id === id)?.name}</span>)}</div>}
      {error && <p role="alert" className="company-inline-error">{error} · 草稿已保留</p>}
      <footer><button type="button" className="company-at-button" aria-label="选择成员" disabled={busy} onClick={() => { const el = input.current; const at = el?.selectionStart ?? draft.text.length; const prefix = at > 0 && !/\s$/.test(draft.text.slice(0, at)) ? " @" : "@"; editDraft(draft.text.slice(0, at) + prefix + draft.text.slice(at)); const next = at + prefix.length; setCaret(next); requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(next, next); }); }}>@</button><small>Enter 发送 · Shift + Enter 换行</small><button type="submit" className="btn-primary" disabled={busy || !draft.text.trim()}>{busy ? "发送中…" : error ? "再次发送" : "发送"}<span aria-hidden="true"> ↑</span></button></footer>
    </form>
    {unknownRetry && <ConfirmDialog title="核查后重新投递？" action="已核查，重新投递" busy={!!retrying} onCancel={() => setUnknownRetry(null)} onConfirm={() => void retry(unknownRetry.message, unknownRetry.agentId, true)}><p>上次请求可能已经送达。请先检查工作会话，确认仍需重新投递；重复投递会再次安排同一任务。</p></ConfirmDialog>}
  </section><aside className={`company-room-info${showMembers ? " expanded" : ""}`}><div className="company-room-info-head"><h3>群成员 <span>{members.length}</span></h3><button className="btn-ghost" onClick={onEditRoom}>管理</button></div>{members.map((a) => <button key={a.id} className="company-room-member" onClick={() => onAgent(a.id)}><AgentAvatar agent={a} small /><div><strong>{a.name}</strong><small>{a.role}</small><AgentStatus agent={a} /></div></button>)}<div className="company-room-guide"><h3>在群里分工</h3><p>@负责的成员，说明目标和验收条件。运行中的 Agent 会按顺序处理新任务。</p><p>普通消息保留在群里，便于沟通；@成员才会投递工作。</p></div></aside></>;
}

export function RoomEditor({ link, room, agents, onSaved, onClose }: { link: HostLink; room: CompanyRoom | null; agents: readonly CompanyAgent[]; onSaved(room: CompanyRoom): void; onClose(): void }) {
  const [name, setName] = useState(room?.name ?? "");
  const [description, setDescription] = useState(room?.description ?? "");
  const [members, setMembers] = useState(room?.memberIds ?? agents.map((a) => a.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (busy || !name.trim() || !members.length) return;
    setBusy(true); setError("");
    try { const body = { name: name.trim(), description: description.trim(), memberIds: members }; const saved = room ? await call(link, "PATCH /api/company/rooms/:id", { id: room.id }, body) : await call(link, "POST /api/company/rooms", {}, body); onSaved(saved); onClose(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <Modal label={room ? "群设置" : "创建工作群"} className="company-editor company-room-editor" busy={busy} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}><header className="company-modal-head"><h2>{room ? "群设置" : "创建工作群"}</h2><button type="button" className="btn-ghost" onClick={onClose} disabled={busy} aria-label="关闭">×</button></header><div className="company-form-scroll"><label>群名称<input className="field" required autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label><label>群说明<textarea className="field" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></label><h3>群成员</h3><div className="company-member-checks">
    {agents.map((a) => <label key={a.id}><input type="checkbox" checked={a.kind === "human" || members.includes(a.id)} disabled={a.kind === "human"} onChange={(e) => setMembers((old) => e.target.checked ? [...old, a.id] : old.filter((id) => id !== a.id))} /><AgentAvatar agent={a} small /><span><strong>{a.name}</strong><small>{a.role}</small></span></label>)}
    </div></div>{error && <p className="form-error" role="alert">{error}</p>}<footer className="company-modal-actions"><button className="btn-ghost" type="button" onClick={onClose} disabled={busy}>取消</button><button className="btn-primary" disabled={busy || !name.trim() || !members.length}>{busy ? "保存中…" : room ? "保存群设置" : "创建工作群"}</button></footer></Modal>;
}
