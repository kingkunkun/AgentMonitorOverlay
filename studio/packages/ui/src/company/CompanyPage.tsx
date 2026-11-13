import { useState } from "react";
import type { CompanyAgent, CompanyRoom } from "@amo-studio/protocol";
import type { View, ViewContext } from "../shell/views.js";
import { upsertById } from "../host/live.js";
import { AgentDirectory, AgentEditor, Organization } from "./AgentPanel.js";
import { CompanyChat, RoomEditor } from "./CompanyChat.js";
import { CompanyIcon } from "./CompanyIcon.js";
import { useCompany } from "./data.js";
import "./company.css";

const TABS = [{ id: "rooms", label: "工作群" }, { id: "agents", label: "Agent 管理" }, { id: "org", label: "组织架构" }] as const;
export function CompanyPage({ link, state, view, setView }: ViewContext & { view: Extract<View, { kind: "company" }> }) {
  const { snapshot, setSnapshot, error, reload } = useCompany(link);
  const [editingAgent, setEditingAgent] = useState<CompanyAgent | "new" | null>(null);
  const [editingRoom, setEditingRoom] = useState<CompanyRoom | "new" | null>(null);
  const [search, setSearch] = useState("");
  const go = (tab: typeof view.tab, fields: { roomId?: string; agentId?: string } = {}) => setView({ kind: "company", tab, ...fields });
  const onOpen = (taskId: string, sessionId?: string) => setView({ kind: "task", taskId, sessionId, back: view, nav: Date.now() });
  if (!snapshot) return <div className="company-page"><div className="company-loading"><CompanyIcon kind="agents" /><h2>{error ? "公司工作台暂时无法读取" : "正在载入公司工作台…"}</h2>{error && <><p role="alert">{error}</p><button className="btn-primary" onClick={reload}>重试</button></>}</div></div>;
  const { agents, rooms } = snapshot;
  const room = rooms.find((r) => r.id === view.roomId) ?? rooms[0];
  const running = agents.filter((a) => a.status === "running").length;
  return <div className="company-page" data-testid="company-page"><header className="company-header"><div className="company-brand"><span className="company-brand-symbol"><CompanyIcon kind="org" /></span><div><strong>公司工作台</strong><small>{agents.filter((a) => a.kind === "agent").length} 位 Agent{running ? ` · ${running} 位运行中` : " · 分工与协作"}</small></div></div><nav className="company-tabs" aria-label="公司工作台视图">{TABS.map((tab) => <button key={tab.id} aria-current={view.tab === tab.id ? "page" : undefined} onClick={() => go(tab.id)}><CompanyIcon kind={tab.id} />{tab.label}</button>)}</nav><button className="btn-primary company-create" onClick={() => view.tab === "rooms" ? setEditingRoom("new") : setEditingAgent("new")}>＋ {view.tab === "rooms" ? "创建群" : "添加 Agent"}</button></header>
    {error && <p className="company-inline-error" role="alert">{error}<button onClick={reload}>重新连接</button></p>}
    {!!snapshot.bootstrapWarnings?.length && <details className="company-bootstrap-warning"><summary>有 {snapshot.bootstrapWarnings.length} 项历史资料或会话绑定需要处理</summary>{snapshot.bootstrapWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
    {view.tab === "rooms" ? <div className="company-rooms"><aside className="company-room-list" aria-label="工作群列表"><div className="company-room-search"><input className="field" aria-label="搜索工作群" placeholder="搜索工作群" value={search} onChange={(e) => setSearch(e.target.value)} /></div>{rooms.filter((r) => r.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((r) => <button className="company-room-row" key={r.id} aria-current={room?.id === r.id ? "page" : undefined} onClick={() => go("rooms", { roomId: r.id })}><span className="company-room-symbol">#</span><div><strong>{r.name}</strong><small>{r.description || `${r.memberIds.length} 位成员`}</small></div></button>)}<div className="company-room-list-foot"><CompanyIcon kind="org" /><span>一个团队，清楚地协作。</span></div></aside>{room ? <CompanyChat key={room.id} link={link} room={room} agents={agents} onEditRoom={() => setEditingRoom(room)} onAgent={(id) => go("agents", { agentId: id })} onOpen={onOpen} /> : <div className="company-empty"><h2>创建第一个工作群</h2><p>把参与同一项工作的成员放在一起。</p><button className="btn-primary" onClick={() => setEditingRoom("new")}>创建工作群</button></div>}</div> : view.tab === "agents" ? <AgentDirectory agents={agents} selectedId={view.agentId} state={state} onSelect={(id) => go("agents", { agentId: id })} onEdit={setEditingAgent} onOpen={onOpen} /> : <Organization agents={agents} onSelect={(id) => go("agents", { agentId: id })} />}
    {editingAgent && <AgentEditor key={editingAgent === "new" ? "new" : editingAgent.id} link={link} agent={editingAgent === "new" ? null : editingAgent} agents={agents} state={state} onClose={() => setEditingAgent(null)} onSaved={(agent) => { setSnapshot((old) => old && { ...old, agents: upsertById(old.agents, agent) }); go("agents", { agentId: agent.id }); }} />}
    {editingRoom && <RoomEditor key={editingRoom === "new" ? "new" : editingRoom.id} link={link} room={editingRoom === "new" ? null : editingRoom} agents={agents} onClose={() => setEditingRoom(null)} onSaved={(saved) => { setSnapshot((old) => old && { ...old, rooms: upsertById(old.rooms, saved) }); go("rooms", { roomId: saved.id }); }} />}
  </div>;
}
