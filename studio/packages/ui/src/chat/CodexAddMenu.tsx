import { useEffect, useState } from "react";
import { inTurn, type Session, type SlashCommandList } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";

function AddIcon({ kind }: { kind: "file" | "app" | "goal" | "plan" | "draw" | "plugin" }) {
  const paths = { file: "M6 8v5a4 4 0 0 0 8 0V6a3 3 0 0 0-6 0v7a1 1 0 0 0 2 0V7", app: "M6 4h8v12H6zM8 13h4M9 6h2", goal: "M16 10a6 6 0 1 1-6-6M13 3v4h4M13 7l-3 3M12 10a2 2 0 1 1-2-2", plan: "M7 13c0-3-2-3-2-6a5 5 0 0 1 10 0c0 3-2 3-2 6zM8 16h4M9 18h2", draw: "M3 15l1-4L13 2l3 3-9 9-4 1M4 18c4-4 7 3 12-2", plugin: "M4 4h5V2h3v2h4v5h2v3h-2v4h-5v2H8v-2H4v-5H2V8h2z" };
  return <svg className={`add-menu-icon ${kind}`} viewBox="0 0 20 20" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

/** Uses the same native command route as /skills; no synthetic prompt-only modes. */
export function CodexAddMenu({ link, session, open, disabled, onClose, onFiles, onSketch, onSkill, children }: {
  link: HostLink; session: Session; open: boolean; disabled: boolean; onClose(): void;
  onFiles?(): void; onSketch?(): void; onSkill?(name: string): void; children?: React.ReactNode;
}) {
  const [data, setData] = useState<SlashCommandList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"goal" | "app" | null>(null);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [app, setApp] = useState<{ id: string; name: string } | null>(null);
  const [request, setRequest] = useState("");
  const [filter, setFilter] = useState("");
  const native = data?.codex;
  const locked = disabled || busy;
  const modeLocked = locked || inTurn(session.status);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true); setError("");
    void call(link, "GET /api/sessions/:id/commands", { id: session.id }).then((next) => { if (live) setData(next); }, (err) => { if (live) setError(String(err)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, session.id, link]);
  useEffect(() => { setData(null); setDialog(null); setError(""); }, [session.id]);
  async function run(name: string, args = "") {
    if (locked) return;
    setBusy(true); setError("");
    try {
      await call(link, "POST /api/sessions/:id/commands", { id: session.id }, { name, args });
      if (name === "app") { setDialog(null); onClose(); return; }
      setDialog(null);
      try { setData(await call(link, "GET /api/sessions/:id/commands", { id: session.id })); }
      catch { setError("操作已提交，状态读取失败。重新打开菜单可刷新状态。"); }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  const skills = data?.commands.filter((c) => c.group === "skill" && `${c.name} ${c.displayName ?? ""} ${c.description}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <>
    {session.options.plan && <span className="composer-mode-badge" title="下一轮使用 Codex 计划模式">计划模式</span>}
    {open && <div className="composer-popover composer-add-menu" role="dialog" aria-label="添加">
      <div className="composer-popover-heading">添加</div>
      <button type="button" disabled={locked || !onFiles} onClick={() => { onClose(); onFiles?.(); }}><AddIcon kind="file" /><strong>文件和文件夹</strong></button>
      {native?.apps.map((a) => <button type="button" key={a.id} disabled={locked} onClick={() => { setApp(a); setRequest(""); setDialog("app"); }}><AddIcon kind="app" /><strong>附加 {a.name}</strong></button>)}
      <button type="button" disabled={modeLocked || loading || native?.goal === undefined} title={inTurn(session.status) ? "当前回复或审批结束后可设置目标" : undefined} onClick={() => { setObjective(native?.goal?.objective ?? ""); setBudget(native?.goal?.tokenBudget?.toString() ?? ""); setDialog("goal"); }}><AddIcon kind="goal" /><strong>目标</strong><small>{native?.goal ? "查看或修改目标" : "设置要持续追求的目标"}</small></button>
      <button type="button" disabled={modeLocked || loading || !native} aria-pressed={native?.plan ?? false} onClick={() => void run("plan", native?.plan ? "off" : "on")}><AddIcon kind="plan" /><strong>计划模式</strong><small>{native?.plan ? "已开启" : "开启计划模式"}</small>{native?.plan && <span>✓</span>}</button>
      <button type="button" disabled={locked || !onSketch} onClick={() => { onClose(); onSketch?.(); }}><AddIcon kind="draw" /><strong>绘图</strong><small>绘制草图</small></button>
      <div className="composer-popover-heading">插件与技能</div>
      {loading && <p className="composer-popover-note" role="status">正在读取 Codex…</p>}
      {(data?.commands.filter((c) => c.group === "skill").length ?? 0) > 8 && <input className="field" aria-label="搜索插件和技能" placeholder="搜索插件和技能" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {skills.map((s) => <button type="button" key={s.name} disabled={locked || !onSkill} title={s.description} onClick={() => { onSkill?.(s.name); onClose(); }}><AddIcon kind="plugin" /><strong>{s.displayName || s.name}</strong><small>{s.description}</small></button>)}
      {!loading && data && !skills.length && <p className="composer-popover-note">{filter ? "没有匹配的插件或技能" : "当前 Codex 没有返回已启用的技能"}</p>}
      {data?.note && <p className="composer-popover-note">{data.note}</p>}
      {native?.unavailable.map((s) => <p key={s} className="composer-popover-note">{s}</p>)}
      {error && <p className="form-error" role="alert">{error}</p>}
      {children}
    </div>}
    {dialog === "goal" && <Modal portal label="目标" className="codex-goal-dialog" onClose={() => setDialog(null)} busy={busy}>
      <h3>设置要持续追求的目标</h3>
      <textarea className="field" aria-label="目标内容" placeholder="希望 Codex 持续完成什么？" autoFocus maxLength={4000} rows={5} value={objective} onChange={(e) => setObjective(e.target.value)} />
      <label>Token 预算（可选）<input className="field" aria-label="Token 预算" type="number" min="1" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
      {native?.goal && <p className="composer-popover-note">当前状态：{({ active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已完成", budgetLimited: "预算已用尽", usageLimited: "用量受限" } as Record<string, string>)[native.goal.status] ?? native.goal.status} · 已用 {native.goal.tokensUsed.toLocaleString()} tokens</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="settings-row end">
        {native?.goal && <><button className="btn-ghost" disabled={modeLocked} onClick={() => void run("goal-clear")}>清除目标</button><button className="btn-ghost" disabled={modeLocked} onClick={() => void run(native.goal?.status === "active" ? "goal-pause" : "goal-resume")}>{native.goal.status === "active" ? "暂停" : "继续"}</button></>}
        <button className="btn-primary" disabled={modeLocked || !objective.trim() || (!!budget && (!Number.isSafeInteger(Number(budget)) || Number(budget) <= 0))} onClick={() => void run("goal-set", JSON.stringify({ objective, ...(budget ? { tokenBudget: Number(budget) } : {}) }))}>设置目标</button>
      </div>
    </Modal>}
    {dialog === "app" && app && <Modal portal label={`使用 ${app.name}`} className="codex-goal-dialog" onClose={() => setDialog(null)} busy={busy}><h3>使用 {app.name}</h3><textarea className="field" aria-label="应用任务" autoFocus rows={4} placeholder="希望这个应用做什么？" value={request} onChange={(e) => setRequest(e.target.value)} />{error && <p className="form-error" role="alert">{error}</p>}<div className="settings-row end"><button className="btn-primary" disabled={locked || !request.trim()} onClick={() => void run("app", JSON.stringify({ id: app.id, text: request }))}>发送</button></div></Modal>}
  </>;
}
