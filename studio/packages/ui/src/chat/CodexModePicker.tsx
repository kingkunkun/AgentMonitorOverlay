import { useEffect, useRef, useState } from "react";
import { inTurn, type CodexModeState, type Session } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

export type ComposerMode = "execute" | "plan" | "goal";
const labels = { execute: "执行模式", plan: "计划模式", goal: "目标模式" };
const hints = { execute: "直接完成你交代的工作", plan: "先讨论方案和步骤", goal: "围绕一个目标持续工作" };
const statuses: Record<string, string> = { active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已完成", budgetLimited: "预算已用尽", usageLimited: "用量受限" };

/** The same visible entry point on a new draft and an existing conversation. */
export function ComposerModePicker({ mode, open, onOpen, onPick, disabled, goalDisabled, choicesLocked, nextTurn, note, children }: {
  mode: ComposerMode; open: boolean; onOpen(open: boolean): void; onPick(mode: ComposerMode): void;
  disabled?: boolean; goalDisabled?: boolean; choicesLocked?: boolean; nextTurn?: boolean; note?: string; children?: React.ReactNode;
}) {
  return <div className="composer-mode-picker">
    <button type="button" className="composer-mode-trigger" data-mode={mode} aria-label={`切换模式：${labels[mode]}`} aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => onOpen(!open)}>{nextTurn ? "下轮：" : ""}{labels[mode]} <span aria-hidden="true">⌄</span></button>
    {open && <div className="composer-popover composer-mode-menu" role="dialog" aria-label="选择对话模式">
      <div className="composer-popover-heading">对话模式</div>
      {(["execute", "plan", "goal"] as const).map(m => <button type="button" key={m} aria-label={labels[m]} aria-pressed={mode === m} disabled={disabled || choicesLocked || (m === "goal" && goalDisabled)} onClick={() => onPick(m)}>
        <span><b>{labels[m]}</b><small>{hints[m]}</small></span><span aria-hidden="true">{mode === m ? "✓" : ""}</span>
      </button>)}
      {note && <p className="composer-popover-note">{note}</p>}
      {children}
    </div>}
  </div>;
}

export function SessionModePicker({ link, session, open, onOpen, disabled }: {
  link: HostLink; session: Session; open: boolean; onOpen(open: boolean): void; disabled: boolean;
}) {
  const [state, setState] = useState<CodexModeState>({ plan: !!session.options.plan });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false), [objective, setObjective] = useState(""), [budget, setBudget] = useState("");
  const version = useRef(0);
  const running = inTurn(session.status), goal = state.goal;
  const mode = state.plan ? "plan" : goal?.status === "active" ? "goal" : "execute";
  useEffect(() => {
    const refresh = () => setReload(n => n + 1);
    const off = onHostEvent(e => { if (e.type === "codex.goal-changed" && e.sessionId === session.id) refresh(); });
    const reconnect = onHostReconnect(refresh);
    return () => { off(); reconnect(); };
  }, [session.id]);
  useEffect(() => { setState(old => ({ ...old, plan: !!session.options.plan })); }, [session.options.plan]);
  useEffect(() => {
    if (disabled || !session.runtimeRef) return;
    const v = ++version.current;
    void call(link, "GET /api/sessions/:id/codex-mode", { id: session.id }).then(next => {
      if (version.current === v) setState(old => next.goalError ? { ...old, plan: next.plan, goalError: next.goalError } : next);
    }, () => { if (version.current === v) setState(old => ({ ...old, goalError: "暂时读不到此会话的目标。" })); });
    return () => { ++version.current; };
  }, [link, session.id, session.runtimeRef, session.options.plan, running, open, disabled, reload]);

  async function change(name: string, args = "") {
    if (busy || disabled) return;
    ++version.current;
    setBusy(true); setError("");
    try {
      const result = await call(link, "POST /api/sessions/:id/commands", { id: session.id }, { name, args });
      ++version.current;
      if (result.codexMode) setState(result.codexMode);
      setEditing(false); onOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function pick(next: ComposerMode) {
    setError("");
    if (next === "goal") {
      setObjective(goal?.objective ?? ""); setBudget(goal?.tokenBudget?.toString() ?? ""); setEditing(true); onOpen(false);
    } else void change("plan", next === "plan" ? "on" : "off");
  }
  return <>
    <ComposerModePicker mode={mode} open={open} onOpen={on => { setError(""); onOpen(on); }} onPick={pick}
      disabled={disabled || busy} goalDisabled={running || goal === undefined || !!state.goalError} choicesLocked={running && goal?.status === "active"} nextTurn={running && goal?.status !== "active"}
      note={running && goal?.status === "active" ? "当前目标正在运行。回复或审批结束后可以暂停目标并切换。" : running ? "执行和计划的选择从下一轮生效；更改目标请等当前回复或审批结束。" : goal?.status === "active" ? "切到执行或计划会暂停当前目标，之后可以继续。" : undefined}>
      {state.goalError ? <p className="composer-popover-note">{state.goalError} <button type="button" className="link-btn" onClick={() => setReload(n => n + 1)}>重试</button></p> : goal === undefined && <p className="composer-popover-note" role="status">正在读取目标…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </ComposerModePicker>
    {editing && <Modal portal label="目标模式" className="codex-goal-dialog" onClose={() => setEditing(false)} busy={busy}>
      <h3>设置要持续完成的目标</h3>
      <textarea className="field" aria-label="目标内容" placeholder="希望 Codex 完成什么？" autoFocus maxLength={4000} rows={5} value={objective} onChange={e => setObjective(e.target.value)} />
      <label>Token 预算（可选）<input className="field" aria-label="Token 预算" type="number" min="1" step="1" value={budget} onChange={e => setBudget(e.target.value)} /></label>
      {goal && <p className="composer-popover-note">当前状态：{statuses[goal.status] ?? goal.status} · 已用 {goal.tokensUsed.toLocaleString()} tokens</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="settings-row end">
        {goal && <><button type="button" className="btn-ghost" disabled={busy || running || disabled} onClick={() => void change("goal-clear")}>清除目标</button>
          {goal.status === "active" && <button type="button" className="btn-ghost" disabled={busy || running || disabled} onClick={() => void change("goal-pause")}>暂停目标</button>}</>}
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => setEditing(false)}>取消</button>
        <button type="button" className="btn-primary" disabled={busy || running || disabled || !objective.trim() || (!!budget && (!Number.isSafeInteger(Number(budget)) || Number(budget) <= 0))} onClick={() => void change("goal-set", JSON.stringify({ objective, ...(budget ? { tokenBudget: Number(budget) } : {}) }))}>{goal?.status === "paused" ? "继续目标" : "设置目标"}</button>
      </div>
    </Modal>}
  </>;
}
