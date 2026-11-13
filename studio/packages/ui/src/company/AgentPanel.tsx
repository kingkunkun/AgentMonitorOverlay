import { useState, type ReactNode } from "react";
import type { CompanyAgent, CompanyAgentInput, StateSnapshot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useProfileChoices } from "../lib/choices.js";
import { AgentEvolution } from "./AgentEvolution.js";
import { Modal } from "../lib/Modal.js";
import { openViewer } from "../viewer/open.js";
import { RunIndicator } from "../lib/RunIndicator.js";
import { AGENT_STATUS, organizationRoots } from "./logic.js";
import { errorText } from "./data.js";

export function AgentAvatar({ agent, small = false }: { agent: CompanyAgent; small?: boolean }) {
  const mark = agent.kind === "human" ? "我" : agent.machine?.capacity === "high" ? "高" : agent.machine?.capacity === "low" ? "低" : agent.name.slice(0, 1);
  return <span className={`company-avatar${small ? " small" : ""}`} data-tone={agent.kind === "human" ? "ceo" : agent.machine?.capacity ?? "agent"} aria-hidden="true">{mark}</span>;
}

export function AgentStatus({ agent }: { agent: CompanyAgent }) {
  return <span className="company-agent-status" data-status={agent.status}>{agent.status === "running" ? <RunIndicator status="running" /> : <i aria-hidden="true" />}{AGENT_STATUS[agent.status]}</span>;
}

export function AgentDetail({ link, agent, agents, state, onEdit, onOpen }: { link: HostLink; agent: CompanyAgent; agents: readonly CompanyAgent[]; state: StateSnapshot; onEdit(): void; onOpen(taskId: string, sessionId?: string): void }) {
  const manager = agents.find((a) => a.id === agent.managerId);
  const profile = state.profiles.find((p) => p.id === agent.profileId);
  const session = state.sessions.find((s) => s.id === agent.sessionId);
  const workspace = state.workspaces.find((w) => w.id === agent.workspaceId);
  const task = state.tasks.find((t) => t.id === agent.taskId);
  return <aside className="company-agent-detail" aria-label={`${agent.name}详情`}>
    <div className="company-detail-heading"><AgentAvatar agent={agent} /><div><h2>{agent.name}</h2><span>{agent.role}</span></div><button className="btn-ghost" onClick={onEdit} aria-label={`编辑${agent.name}`}>编辑</button></div>
    <AgentStatus agent={agent} />
    <p className="company-detail-description">{agent.description || "填写这个角色负责的工作，便于在群里分工。"}</p>
    <dl className="company-facts"><div><dt>汇报给</dt><dd>{manager?.name ?? "公司负责人"}</dd></div><div><dt>直接成员</dt><dd>{agents.filter((a) => a.managerId === agent.id).map((a) => a.name).join("、") || "—"}</dd></div>
      {agent.kind === "agent" && <><div><dt>模型</dt><dd>{profile ? `${profile.label}${agent.model || session?.options.model || profile.model ? ` · ${agent.model || session?.options.model || profile.model}` : " · 默认型号"}` : "待配置"}</dd></div><div><dt>项目</dt><dd>{workspace?.name ?? "待配置"}</dd></div><div><dt>并发任务</dt><dd>1 个 · 新任务按顺序排队</dd></div></>}
      {agent.machine && <><div><dt>工作机器</dt><dd>{agent.machine.label || agent.name}</dd></div><div><dt>地址</dt><dd><code>{agent.machine.address || "待填写"}</code></dd></div></>}
    </dl>
    {agent.kind === "agent" && <section className="company-detail-section"><h3>工作会话</h3>{task ? <button className="company-session-link" onClick={() => onOpen(task.id, session?.id)}><span>{task.title || agent.name}</span><small>{session?.title || "打开任务"} →</small></button> : <p className="company-subtle">配置模型和项目后，首次收到 @任务时建立独立工作会话。</p>}</section>}
    <section className="company-detail-section"><h3>工作规范 <span>v{agent.instructionsVersion ?? 0}</span></h3><p className="company-instructions">{agent.instructions || "尚未填写"}</p>{agent.kind === "agent" && <p className="company-subtle">{agent.autonomous === false ? "手动接活" : "自主接活"} · {agent.allowEvolution === false ? "自我改进已关闭" : "允许基于已完成工作改进规范"}</p>}</section>
    {agent.kind === "agent" && <AgentEvolution link={link} agent={agent} />}
    <section className="company-detail-section"><h3>历史资料 <span>{agent.archives.length}</span></h3>{agent.archives.length ? <><p className="company-subtle">本机完整归档，保留来源和校验信息。</p>{agent.archives.map((archive) => <div className="company-archive" key={archive.id}><button onClick={() => openViewer({ path: archive.transcriptPath })}><span>▤</span><div><strong>{archive.title}</strong><small>{archive.source === "codex" ? "Codex" : "WorkStudio"} · {archive.messageCount.toLocaleString()} 条记录 · 仅本机</small></div><span>↗</span></button><button className="company-archive-manifest" title="查看来源、计数与 SHA-256 校验" onClick={() => openViewer({ path: archive.manifestPath })}>查看归档清单</button></div>)}</> : <p className="company-subtle">还没有归档资料。</p>}</section>
  </aside>;
}

export function AgentDirectory({ link, agents, selectedId, state, onSelect, onEdit, onOpen }: { link: HostLink; agents: readonly CompanyAgent[]; selectedId?: string; state: StateSnapshot; onSelect(id: string): void; onEdit(agent: CompanyAgent): void; onOpen(taskId: string, sessionId?: string): void }) {
  const [search, setSearch] = useState("");
  const selected = agents.find((a) => a.id === selectedId) ?? agents.find((a) => a.kind === "agent") ?? agents[0];
  const shown = agents.filter((a) => `${a.name} ${a.role} ${a.machine?.address ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="company-directory"><section className="company-agent-list"><div className="company-list-toolbar"><h2>公司成员 <small>{agents.length}</small></h2><input className="field" aria-label="搜索 Agent" placeholder="搜索角色、名称、机器…" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="company-agent-grid">{shown.map((a) => <button key={a.id} className="company-agent-card" aria-pressed={selected?.id === a.id} onClick={() => onSelect(a.id)}><div className="company-card-top"><AgentAvatar agent={a} /><AgentStatus agent={a} /></div><h3>{a.name}</h3><span className="company-role">{a.role}</span><p>{a.description || "等待配置职责"}</p><footer><span>{a.machine?.address || (a.kind === "human" ? "公司负责人" : state.workspaces.find((w) => w.id === a.workspaceId)?.name || "待分配项目")}</span><span>↗</span></footer></button>)}</div>{!shown.length && <p className="company-empty">没有匹配的成员。</p>}</section>{selected && <AgentDetail key={selected.id} link={link} agent={selected} agents={agents} state={state} onEdit={() => onEdit(selected)} onOpen={onOpen} />}</div>;
}

export function Organization({ agents, onSelect }: { agents: readonly CompanyAgent[]; onSelect(id: string): void }) {
  const branch = (agent: CompanyAgent, parents: ReadonlySet<string>): ReactNode => {
    if (parents.has(agent.id)) return null;
    const next = new Set([...parents, agent.id]);
    const children = agents.filter((a) => a.managerId === agent.id && !next.has(a.id));
    return <li key={agent.id}><button className="company-org-card" onClick={() => onSelect(agent.id)}><AgentAvatar agent={agent} /><div><strong>{agent.name}</strong><span>{agent.role}</span><AgentStatus agent={agent} /></div></button>{children.length > 0 && <ul>{children.map((a) => branch(a, next))}</ul>}</li>;
  };
  return <section className="company-organization"><div className="company-org-intro"><span className="company-eyebrow">TEAM STRUCTURE</span><h2>明确职责，让协作有归属。</h2><p>CEO 决定方向与优先级，产品梳理需求，CTO 统筹实现，打包 Agent 负责各自的机器与交付。</p></div><div className="company-org-scroll"><ul className="company-org-tree">{organizationRoots(agents).map((a) => branch(a, new Set()))}</ul></div><div className="company-org-notes"><div><strong>01 · 分工</strong><span>在工作群 @负责的成员，带上目标、交付物与验收条件。</span></div><div><strong>02 · 执行</strong><span>Agent 使用独立会话。正在运行的工作完成后，继续处理排队任务。</span></div><div><strong>03 · 汇报</strong><span>在群中同步结果，关联工作会话；负责人集中处理需要拍板的问题。</span></div></div></section>;
}

export function AgentEditor({ link, agent, agents, state, onSaved, onClose }: { link: HostLink; agent: CompanyAgent | null; agents: readonly CompanyAgent[]; state: StateSnapshot; onSaved(agent: CompanyAgent): void; onClose(): void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [managerId, setManager] = useState(agent ? agent.managerId ?? "" : "company-cto");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [profileId, setProfile] = useState(agent?.profileId ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [autonomous, setAutonomous] = useState(agent?.autonomous !== false);
  const [allowEvolution, setAllowEvolution] = useState(agent?.allowEvolution !== false);
  const { choices, error: choicesError } = useProfileChoices(link, profileId);
  const [workspaceId, setWorkspace] = useState(agent?.workspaceId ?? "");
  const [taskId, setTask] = useState(agent?.taskId ?? "");
  const [sessionId, setSession] = useState(agent?.sessionId ?? "");
  const [machine, setMachine] = useState(agent?.machine ?? { label: "", address: "", capacity: "other" as const });
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const human = agent?.kind === "human";
  const tasks = state.tasks.filter((t) => !t.archivedAt && !t.remote && (!workspaceId || t.workspaceId === workspaceId));
  const sessions = state.sessions.filter((s) => !s.archivedAt && s.writer !== "archived" && s.kind !== "sub" && s.runtime !== "remote" && s.taskId && (!taskId || s.taskId === taskId) && (!workspaceId || s.workspaceId === workspaceId));
  const bindSession = (id: string) => { setSession(id); const s = state.sessions.find((s) => s.id === id); if (s) { setTask(s.taskId ?? ""); setWorkspace(s.workspaceId); setProfile(s.profileId); setModel(s.options.model ?? ""); } };
  const save = async () => {
    if (busy || !name.trim() || !role.trim()) return;
    setBusy(true); setError("");
    const body: CompanyAgentInput = { name: name.trim(), role: role.trim(), managerId: human ? null : managerId || null, description: description.trim(), instructions: instructions.trim(), expectedInstructionsVersion: agent?.instructionsVersion ?? 0, ...(human ? {} : { profileId: profileId || null, model: model || null, autonomous, allowEvolution, workspaceId: workspaceId || null, taskId: taskId || null, sessionId: sessionId || null, enabled, machine: machine.label.trim() || machine.address.trim() ? { ...machine, label: machine.label.trim() || name.trim(), address: machine.address.trim() } : null }) };
    try { const saved = agent ? await call(link, "PUT /api/company/agents/:id", { id: agent.id }, body) : await call(link, "POST /api/company/agents", {}, body); onSaved(saved); onClose(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <Modal label={agent ? `编辑${agent.name}` : "添加 Agent"} className="company-editor" busy={busy} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <header className="company-modal-head"><div><span className="company-eyebrow">AGENT PROFILE</span><h2>{agent ? "编辑成员" : "添加 Agent"}</h2></div><button className="btn-ghost" type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button></header>
    <div className="company-form-scroll"><div className="company-form-grid"><label>名称<input className="field" required autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label><label>职位 / 角色<input className="field" required maxLength={100} value={role} onChange={(e) => setRole(e.target.value)} /></label></div>
      {!human && <label>汇报给<select className="field" value={managerId} onChange={(e) => setManager(e.target.value)}><option value="">公司负责人</option>{agents.filter((a) => a.id !== agent?.id).map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label>}
      <label>负责什么<textarea className="field" rows={2} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="职责范围、接收的任务、负责的交付物" /></label>
      <label>工作规范<textarea className="field" rows={4} maxLength={20000} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="执行顺序、验收方式、需要向谁汇报" /></label>
      {!human && <><h3>运行配置</h3><div className="company-form-grid">
        <label>模型配置<select className="field" value={profileId} onChange={(e) => { setProfile(e.target.value); setModel(""); setTask(""); setSession(""); }}><option value="">稍后配置</option>{state.profiles.filter((p) => p.runtime !== "remote" && (!p.hidden || p.id === profileId)).map((p) => <option key={p.id} value={p.id} disabled={!!p.unavailable || !!p.hidden}>{p.label}{p.model ? ` · ${p.model}` : ""}{p.unavailable || p.hidden ? "（不可用）" : ""}</option>)}</select></label>
        <label>工作项目<select className="field" value={workspaceId} onChange={(e) => { setWorkspace(e.target.value); setTask(""); setSession(""); }}><option value="">稍后配置</option>{state.workspaces.filter((w) => !w.archivedAt).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label>绑定任务<select className="field" value={taskId} onChange={(e) => { setTask(e.target.value); setSession(""); const task = state.tasks.find((t) => t.id === e.target.value); if (task) setWorkspace(task.workspaceId); }}><option value="">收到任务时建立</option>{tasks.map((t) => <option key={t.id} value={t.id}>{t.title || "未命名任务"}</option>)}</select></label>
        <label>绑定工作会话<select className="field" value={sessionId} onChange={(e) => bindSession(e.target.value)}><option value="">收到任务时建立</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.title || state.tasks.find((t) => t.id === s.taskId)?.title || s.id} · {s.runtime}</option>)}</select></label></div>
        <label>使用模型<select className="field" value={model} disabled={!profileId} onChange={(e) => setModel(e.target.value)}><option value="">使用渠道默认模型</option>{model && !choices?.models.some((m) => m.id === model) && <option value={model}>{model}（等待核对）</option>}{choices?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>{profileId && <p className="company-subtle">{choicesError || (!choices ? "正在读取可用模型…" : "模型来自当前渠道提供的真实列表。")}</p>}
        <div className="company-autonomy-options"><label className="company-enabled"><input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />自主接收工作列表中的任务</label><label className="company-enabled"><input type="checkbox" checked={allowEvolution} onChange={(e) => setAllowEvolution(e.target.checked)} />完成任务后允许改进自己的工作规范</label></div>
        <p className="company-subtle">自主执行已分配目标，完成或受阻时向群里汇报。规范改进保留版本，可在成员详情撤回。模型从下一次群任务开始使用。</p><h3>工作机器</h3><div className="company-form-grid">
          <label>机器名称<input className="field" value={machine.label} maxLength={100} onChange={(e) => setMachine({ ...machine, label: e.target.value })} placeholder="如：高配打包机" /></label><label>机器地址<input className="field" value={machine.address} maxLength={200} onChange={(e) => setMachine({ ...machine, address: e.target.value })} placeholder="如：172.16.8.85" /></label><label>机器分工<select className="field" value={machine.capacity} onChange={(e) => setMachine({ ...machine, capacity: e.target.value as "high" | "low" | "other" })}><option value="high">高配打包</option><option value="low">低配打包</option><option value="other">其他</option></select></label><label className="company-enabled"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />允许接收新任务</label></div></>}
    </div>{error && <p className="form-error" role="alert">{error}</p>}<footer className="company-modal-actions"><button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>取消</button><button className="btn-primary" type="submit" disabled={busy || !name.trim() || !role.trim()}>{busy ? "保存中…" : "保存成员"}</button></footer>
  </Modal>;
}
