import { useState } from "react";
import type { CompanyAgent, CompanyEvolution } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { errorText } from "./data.js";

export function AgentEvolution({ link, agent }: { link: HostLink; agent: CompanyAgent }) {
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [revisions, , reload] = useLiveResource<CompanyEvolution[]>({ initial: [], load: () => call(link, "GET /api/company/agents/:id/evolution", { id: agent.id }), reloadOn: (e) => e.type === "company.changed", reloadDelay: 150, onError: (e) => setError(errorText(e)), reset: true }, [link.url, link.token, agent.id]);
  const rollback = async (r: CompanyEvolution) => {
    if (busy) return; setBusy(true); setError("");
    try { await call(link, "POST /api/company/agents/:id/evolution/:revisionId/rollback", { id: agent.id, revisionId: r.id }, { expectedVersion: agent.instructionsVersion ?? 0 }); reload(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <section className="company-detail-section company-evolution"><h3>自我改进 <span>{revisions.length}</span></h3><p className="company-subtle">根据已完成任务积累工作经验，保留每次规范变更。</p>{error && <p className="form-error" role="alert">{error}</p>}{revisions.map((r) => <details key={r.id}><summary><strong>v{r.version}</strong> · {r.reason}</summary><small>{new Date(r.createdAt).toLocaleString()} · {r.actorId === agent.id ? "Agent 自我改进" : "人工调整"}{r.workId ? ` · ${r.workId}` : ""}</small><h4>改进前</h4><p>{r.before || "未填写"}</p><h4>改进后</h4><p>{r.after}</p>{r.version === (agent.instructionsVersion ?? 0) && <button className="btn-ghost" disabled={busy} onClick={() => void rollback(r)}>撤回这次改进</button>}</details>)}{!revisions.length && <p className="company-subtle">完成工作后，在这里查看改进依据与版本。</p>}</section>;
}
