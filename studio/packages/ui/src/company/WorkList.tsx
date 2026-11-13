import { useState } from "react";
import { MAX_ATTACHMENT_BYTES, type CompanyAgent, type CompanyRoom, type CompanyWork, type CompanyWorkAction, type CompanyWorkAttachment, type CompanyWorkPriority, type CompanyWorkStatus } from "@amo-studio/protocol";
import { attachmentUrl, uploadAttachment, uploadFile } from "../lib/attachments.js";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Modal } from "../lib/Modal.js";
import { RunIndicator } from "../lib/RunIndicator.js";
import { AgentAvatar } from "./AgentPanel.js";
import { errorText } from "./data.js";

export const PRIORITY: Record<CompanyWorkPriority, string> = { high: "高优先级", medium: "中优先级", low: "低优先级" };
export const WORK_STATUS: Record<CompanyWorkStatus, string> = { queued: "待执行", dispatching: "派发中", running: "进行中", blocked: "受阻", done: "已完成", cancelled: "已取消" };

export function WorkList({ link, agents, rooms, onEdit, onAgent, onRoom, onOpen }: { link: HostLink; agents: CompanyAgent[]; rooms: CompanyRoom[]; onEdit(work: CompanyWork): void; onAgent(id: string): void; onRoom(id: string): void; onOpen(taskId: string, sessionId?: string): void }) {
  const [error, setError] = useState("");
  const [work, , reload] = useLiveResource<CompanyWork[] | null>({ initial: null, load: async () => { const r = await call(link, "GET /api/company/work"); setError(""); return r; }, reloadOn: (e) => e.type === "company.changed", reloadDelay: 150, onError: (e) => setError(errorText(e)), reset: true }, [link.url, link.token]);
  const [status, setStatus] = useState("active");
  const [priority, setPriority] = useState("");
  const [agentId, setAgent] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, select] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<CompanyWork | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const selected = work?.find((w) => w.id === selectedId);
  const selectedAgent = agents.find((a) => a.id === selected?.agentId);
  const act = async (w: CompanyWork, action: CompanyWorkAction["action"], confirmUnknown = false) => {
    if (busy) return; setBusy(true); setError("");
    try { await call(link, "POST /api/company/work/:id/action", { id: w.id }, { action, confirmUnknown }); setRetry(null); reload(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const shown = work?.filter((w) => (status === "all" || status === "active" && !["done", "cancelled"].includes(w.status) || w.status === status || status === "running" && w.status === "dispatching") && (!priority || w.priority === priority) && (!agentId || w.agentId === agentId) && `${w.title} ${w.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  return <section className="company-work">
    <div className="company-work-summary"><div><span className="company-eyebrow">WORK QUEUE</span><h2>把目标交给合适的 Agent</h2><p>按优先级接活，独立执行，在群里汇报。</p></div><div className="company-work-counts">{(["queued", "running", "blocked", "done"] as const).map((s) => <button key={s} onClick={() => setStatus(s)} aria-pressed={status === s}><strong>{work?.filter((w) => w.status === s || s === "running" && w.status === "dispatching").length ?? 0}</strong><span>{WORK_STATUS[s]}</span></button>)}</div></div>
    <div className="company-work-filters"><input className="field" aria-label="搜索工作" placeholder="搜索目标或工作内容…" value={search} onChange={(e) => setSearch(e.target.value)} /><select className="field" aria-label="工作状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">未完成的工作</option><option value="all">全部状态</option>{Object.entries(WORK_STATUS).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select><select className="field" aria-label="工作优先级" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">全部优先级</option>{Object.entries(PRIORITY).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select><select className="field" aria-label="负责 Agent" value={agentId} onChange={(e) => setAgent(e.target.value)}><option value="">全部 Agent</option>{agents.filter((a) => a.kind === "agent").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
    {error && <p className="company-inline-error" role="alert">{error}<button onClick={reload}>重新读取</button></p>}
    <div className="company-work-content"><div className="company-work-table" role="list" aria-label="工作列表"><div className="company-work-columns"><span>工作 / 目标</span><span>优先级</span><span>负责 Agent</span><span>状态</span></div>{shown.map((w) => { const a = agents.find((a) => a.id === w.agentId); return <button role="listitem" key={w.id} className="company-work-row" aria-current={selectedId === w.id ? "true" : undefined} onClick={() => select(w.id)}><div><strong>{w.title}</strong><small>{w.description || w.acceptance || "尚未填写工作说明"}</small></div><span className="company-priority" data-priority={w.priority}>{PRIORITY[w.priority]}</span><span className="company-work-assignee">{a && <AgentAvatar agent={a} small />}<span>{a?.name ?? "Agent 不可用"}<small>{a?.model || "渠道默认模型"}</small></span></span><span className="company-work-status" data-status={w.status}>{["running", "dispatching"].includes(w.status) && <RunIndicator status="running" />}{WORK_STATUS[w.status]}</span></button>; })}{!shown.length && <div className="company-empty"><h3>{work ? "没有符合条件的工作" : "正在读取工作列表…"}</h3><p>点击右上角“添加工作”，填写目标、验收条件和负责 Agent。</p></div>}</div>
      {selected && <aside className="company-work-detail"><div className="company-detail-heading"><h2>{selected.title}</h2><button className="btn-ghost" aria-label="关闭工作详情" onClick={() => select("")}>×</button></div><div className="company-work-tags"><span className="company-priority" data-priority={selected.priority}>{PRIORITY[selected.priority]}</span><span className="company-work-status" data-status={selected.status}>{WORK_STATUS[selected.status]}</span></div><section><h3>工作内容</h3><p>{selected.description || "未填写"}</p></section><section><h3>附件</h3>{selected.attachments?.length ? <ul className="company-work-files">{selected.attachments.map((f) => <li key={f.id}><span>{f.name}</span><small>{f.path}</small></li>)}</ul> : <p>没有附件</p>}</section><section><h3>验收条件</h3><p>{selected.acceptance || "说明交付内容和验证结果"}</p></section><section><h3>负责 Agent</h3><button className="company-session-link" onClick={() => onAgent(selected.agentId)}>{selectedAgent?.name ?? selected.agentId} →</button><p className="company-subtle">{selectedAgent?.model || "使用渠道默认模型"} · {selectedAgent?.autonomous === false ? "手动接活" : "自主接活"}{selectedAgent?.status === "unconfigured" ? " · 等待配置模型渠道和项目" : ""}</p></section><section><h3>最新汇报</h3><p>{selected.report || "执行后，进度与交付会同步到这里和工作群。"}</p><button className="btn-ghost" onClick={() => onRoom(selected.roomId)}>前往 {rooms.find((r) => r.id === selected.roomId)?.name ?? "汇报群"} →</button></section><footer><small>派发 {selected.attempt} 次 · 交接 {selected.handoffs} 次</small><div>{selectedAgent?.taskId && <button className="btn-ghost" onClick={() => onOpen(selectedAgent.taskId!, selectedAgent.sessionId ?? undefined)}>工作会话</button>}{selected.status === "queued" && <><button className="btn-ghost" disabled={busy} onClick={() => onEdit(selected)}>编辑</button>{selectedAgent?.autonomous === false && <button className="btn-primary" disabled={busy} onClick={() => void act(selected, "start")}>启动</button>}</>}{selected.status === "blocked" && <button className="btn-primary" disabled={busy} onClick={() => { if (selected.outcomeUnknown) { setConfirmed(false); setRetry(selected); } else void act(selected, "retry"); }}>重试</button>}{["queued", "blocked"].includes(selected.status) && <button className="btn-ghost" disabled={busy} onClick={() => void act(selected, "cancel")}>取消工作</button>}</div></footer></aside>}
    </div><p className="company-work-footnote">每位 Agent 同时执行一项工作；高优先级先派发。正在进行的任务保持运行，完成后再接下一项。</p>
    {retry && <Modal label="核查后重试工作" busy={busy} onClose={() => setRetry(null)}><h2>重新派发“{retry.title}”</h2><p>若上次投递没有确认结果，先打开工作会话核查是否已执行，避免重复操作。</p>{selectedAgent?.taskId && <button className="btn-ghost" onClick={() => onOpen(selectedAgent.taskId!, selectedAgent.sessionId ?? undefined)}>打开工作会话</button>}<label className="company-enabled"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />已核查，确认需要重新派发</label><div className="company-modal-actions"><button className="btn-ghost" disabled={busy} onClick={() => setRetry(null)}>返回</button><button className="btn-primary" disabled={busy || !confirmed} onClick={() => void act(retry, "retry", true)}>确认重试</button></div></Modal>}
  </section>;
}

export function WorkEditor({ link, work, agents, rooms, onClose }: { link: HostLink; work: CompanyWork | null; agents: CompanyAgent[]; rooms: CompanyRoom[]; onClose(): void }) {
  const available = agents.filter((a) => a.kind === "agent" && a.enabled);
  const [clientId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState(work?.title ?? "");
  const [description, setDescription] = useState(work?.description ?? "");
  const [acceptance, setAcceptance] = useState(work?.acceptance ?? "");
  const [files, setFiles] = useState<CompanyWorkAttachment[]>(work?.attachments ?? []);
  const [mode, setMode] = useState<"agent" | "new">(work?.sessionMode ?? "agent");
  const [priority, setPriority] = useState<CompanyWorkPriority>(work?.priority ?? "medium");
  const [agentId, setAgent] = useState(work?.agentId ?? available.find((a) => a.id === "company-platform")?.id ?? available[0]?.id ?? "");
  const [roomId, setRoom] = useState(work?.roomId ?? rooms.find((r) => r.memberIds.includes(agentId))?.id ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [uploading, setUploading] = useState(false), [dragging, setDragging] = useState(false);
  const a = available.find((a) => a.id === agentId);
  // Pictures go to the image store (inline preview); anything else keeps its own name on disk.
  const add = async (items: File[]) => {
    const picked = items.filter((f) => f.size > 0 && f.size <= MAX_ATTACHMENT_BYTES).slice(0, Math.max(0, 20 - files.length));
    if (!picked.length) return;
    setUploading(true); setError("");
    try {
      const next = [...files];
      for (const file of picked) {
        const saved = file.type.startsWith("image/") ? await uploadAttachment(link, file) : await uploadFile(link, file);
        next.push({ id: saved.id, name: saved.name, mime: saved.mime, size: saved.size, path: saved.path });
      }
      setFiles(next);
    } catch (e) { setError(errorText(e)); } finally { setUploading(false); }
  };
  const save = async () => {
    if (busy || !title.trim() || !a || !roomId) return; setBusy(true); setError("");
    try { const body = { title: title.trim(), description, acceptance, attachments: files, sessionMode: mode, priority, agentId }; if (work) await call(link, "PATCH /api/company/work/:id", { id: work.id }, body); else await call(link, "POST /api/company/work", {}, { ...body, roomId, clientId }); onClose(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <Modal label={work ? "编辑工作" : "添加工作"} className="company-editor" busy={busy} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}><header className="company-modal-head"><div><span className="company-eyebrow">ASSIGN AN OBJECTIVE</span><h2>{work ? "编辑工作" : "添加工作"}</h2></div><button type="button" className="btn-ghost" disabled={busy} onClick={onClose} aria-label="关闭">×</button></header>
    <div className="company-form-scroll">
      <label>目标 / 工作名称<input className="field" autoFocus required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="明确希望交付什么" /></label>
      <div className="company-form-grid"><label>优先级<select className="field" value={priority} onChange={(e) => setPriority(e.target.value as CompanyWorkPriority)}>{Object.entries(PRIORITY).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label><label>负责 Agent<select className="field" required value={agentId} onChange={(e) => { const id = e.target.value; setAgent(id); if (!rooms.find((r) => r.id === roomId)?.memberIds.includes(id)) setRoom(rooms.find((r) => r.memberIds.includes(id))?.id ?? ""); }}>{available.filter((a) => !work || rooms.find((r) => r.id === work.roomId)?.memberIds.includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>
      <p className="company-subtle">{a?.model ? "使用该 Agent 当前模型 " + a.model : "使用渠道默认模型"} · {a?.autonomous === false ? "创建后手动启动" : "空闲时自主接活"}{a?.status === "unconfigured" ? " · 请先在 Agent 管理中配置模型渠道和项目" : ""}</p>
      <label>工作内容<textarea className="field company-work-body" rows={9} maxLength={12000} value={description} onChange={(e) => setDescription(e.target.value)} onPaste={(e) => { const picked = [...e.clipboardData.files]; if (picked.length) { e.preventDefault(); void add(picked); } }} placeholder="背景、范围、资源和需要遵守的约定。可以直接粘贴截图。" /></label>
      <div className="company-attach-drop" data-dragging={dragging || undefined} onDragOver={(e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); void add([...e.dataTransfer.files]); }}>
        <div className="company-attach-head"><span>附件</span><label className="company-attach-pick">上传文件<input type="file" multiple onChange={(e) => { void add([...(e.target.files ?? [])]); e.currentTarget.value = ""; }} /></label></div>
        {files.length > 0 && <div className="company-attach-list">{files.map((f) => <span key={f.id} className="company-attach-chip">{f.mime.startsWith("image/") && <img src={attachmentUrl(link, f.id)} alt="" />}<span className="company-attach-name" title={f.path}>{f.name}</span><small>{Math.max(1, Math.round(f.size / 1024))} KB</small><button type="button" className="company-attach-remove" aria-label={"移除 " + f.name} onClick={() => setFiles(files.filter((x) => x.id !== f.id))}>×</button></span>)}</div>}
        <p className="company-subtle">{uploading ? "正在上传…" : files.length ? "Agent 通过上面的本机路径读取附件。" : "拖进来、粘贴截图或上传文件；最多 20 个。"}</p>
      </div>
      <label>验收条件<textarea className="field" rows={5} maxLength={4000} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="怎样确认任务已完成，交付物放在哪里" /></label>
      <div className="company-form-grid"><label>执行位置<select className="field" value={mode} onChange={(e) => setMode(e.target.value as "agent" | "new")} disabled={!!work && work.status !== "queued"}><option value="agent">原对话（Agent 当前会话）</option><option value="new">新建聊天任务</option></select></label></div>
      <label>汇报到工作群<select className="field" disabled={!!work} required value={roomId} onChange={(e) => setRoom(e.target.value)}><option value="">请选择工作群</option>{rooms.filter((r) => r.memberIds.includes(agentId)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <p className="company-subtle">完成、受阻与交接会自动汇报。Agent 可在群里协作；执行仍遵守项目和机器上的工作约定。</p>
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
    <footer className="company-modal-actions"><button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>取消</button><button className="btn-primary" type="submit" disabled={busy || uploading || !title.trim() || !a || !roomId}>{busy ? "保存中…" : work ? "保存工作" : "创建并排队"}</button></footer>
  </Modal>;
}
