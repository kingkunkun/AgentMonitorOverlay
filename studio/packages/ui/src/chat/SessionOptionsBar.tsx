import { useEffect, useRef, useState } from "react";
import type { ModelProfile, Session, SessionOptions, SessionPreset } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { activeModel, optionsSummary, sameOptions, useProfileChoices } from "../lib/choices.js";
import { rememberPick } from "../lib/recents.js";
import { nextEffort, pickLabel } from "./pickers.js";
import { ComposerModelPicker } from "./ComposerModelPicker.js";
import { DSH_FULL_ACCESS, SandboxHint } from "../settings/SandboxHint.js";
import { SessionMcpTray, useSessionMcp } from "../mcp/SessionMcp.js";

// Under the composer: what the session runs with — model, effort, permissions — each one click away
// (design/ui-directions/new-task.html, "会话中切换"). Clicking the model or the permissions opens that group above the
// composer; the effort bars are clicked directly. Models switch only within the session's own account (the context
// stays); another account needs a new session. Codex takes a change from the next turn, Claude at once.

type Tray = "model" | "permission" | "tools" | "mcp" | null;

export function SessionOptionsBar({
  link,
  session,
  profile,
  presets,
  disabled,
}: {
  link: HostLink;
  session: Session;
  profile: ModelProfile | undefined;
  presets: readonly SessionPreset[];
  disabled: boolean;
}) {
  const { choices } = useProfileChoices(link, session.profileId);
  const [tray, setTray] = useState<Tray>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const mcp = useSessionMcp(link, session);
  const mcpOn = mcp.state?.entries.filter((e) => e.on).length ?? 0;
  const mine = presets.filter((p) => p.profileId === session.profileId);
  const model = choices ? activeModel(choices, session.options) : undefined;
  const when = session.runtime === "claude" ? "立即生效" : "下一轮生效";

  useEffect(() => {
    if (!tray) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setTray(null);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("mousedown", close);
    };
  }, [tray]);

  useEffect(() => {
    if (!note || note.error) return;
    const t = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(t);
  }, [note]);

  // Fast is sent only when it is what changed: presets carry model, effort and permissions, not speed.
  async function apply(next: SessionOptions, what: string, fast?: boolean) {
    setBusy(true);
    setTray(null);
    try {
      await call(
        link,
        "PATCH /api/sessions/:id/options",
        { id: session.id },
        fast === undefined ? { model: next.model ?? null, effort: next.effort ?? null, permission: next.permission ?? null } : { fast },
      );
      setNote({ text: `${what}，${when}` });
    } catch (err) {
      setNote({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  const setModel = (id: string, label: string) => {
    const next: SessionOptions = { ...session.options, model: id };
    // An effort the new model does not take falls back to its default.
    const m = choices?.models.find((x) => x.id === id);
    if (m && next.effort && !m.efforts.includes(next.effort)) delete next.effort;
    rememberPick({ profileId: session.profileId, model: m?.isDefault ? null : id });
    void apply(next, `型号换成「${label}」`);
  };
  const setEffort = (effort: string | null) => void apply({ ...session.options, effort: effort ?? undefined }, "思考强度已改");
  const setFast = (on: boolean) => void apply(session.options, on ? "Fast 已开" : "Fast 已关", on);
  const setPermission = (id: string) => void apply({ ...session.options, permission: id }, `权限换成「${choices?.permissions.find((p) => p.id === id)?.label ?? id}」`);

  // Alt M: models, Alt P: permissions, Alt E: one effort up.
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "m" || k === "p") {
        e.preventDefault();
        const want: Tray = k === "m" ? "model" : "permission";
        setTray((t) => (t === want ? null : want));
      } else if (k === "e" && model) {
        e.preventDefault();
        const next = nextEffort(model.efforts, session.options.effort ?? model.defaultEffort);
        if (next) setEffort(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The model by name also when it is the profile's default ("Opus 5.5", not just "Claude").
  const label = pickLabel(profile, model?.id ?? session.options.model ?? null, choices?.models);
  const permission = choices?.permissions.find((p) => p.id === (session.options.permission ?? choices.defaultPermission));

  const fullAccess = /full|bypass|danger/i.test(permission?.id ?? "") || /全部允许|完全访问|完全允许/.test(permission?.label ?? "");
  return (
    <div className="session-options codex-session-options" ref={box} data-testid="session-options" title={optionsSummary(choices, session.options)}>
      <button type="button" className="composer-permission" data-full-access={fullAccess || undefined} aria-label="权限" aria-expanded={tray === "permission"} data-testid="switch-permission" disabled={disabled || busy || !choices} onClick={() => setTray(tray === "permission" ? null : "permission")}><span aria-hidden="true">⛨</span>{fullAccess ? "完全访问" : permission?.label ?? "默认权限"}</button>
      <button type="button" className="composer-tools-trigger" aria-label="更多工具" title="更多工具与预设" aria-expanded={tray === "tools"} data-testid="composer-tools" onClick={() => setTray(tray === "tools" ? null : "tools")}>+</button>
      {tray === "permission" && choices && <div className="composer-popover composer-permission-menu" role="dialog" aria-label="权限" data-testid="options-tray">
        <div className="composer-popover-heading">权限</div>
        {choices.permissions.map((p) => <button type="button" className="composer-permission-option" key={p.id} disabled={busy || !!p.unavailable} aria-pressed={permission?.id === p.id} onClick={() => setPermission(p.id)} title={p.unavailable ?? p.description}><span><b>{p.label}</b><small>{p.unavailable ?? p.description}</small></span><span aria-hidden="true">{permission?.id === p.id ? "✓" : ""}</span></button>)}
        <SandboxHint link={link} workspaceId={session.workspaceId} active={session.runtime === "dsh" && (session.options.permission ?? choices.defaultPermission) === "workspace-write"} onUseFull={() => setPermission(DSH_FULL_ACCESS)} />
        <p className="composer-popover-note">文件外发仍须本机逐次确认。{when}。</p>
      </div>}
      {tray === "tools" && <div className="composer-popover composer-tools-menu" role="dialog" aria-label="更多工具">
        {session.runtime !== "remote" && <button type="button" data-testid="switch-mcp" onClick={() => { mcp.refresh(); setTray("mcp"); }}>MCP{mcp.state ? ` · ${mcpOn} 个已启用` : ""}<span aria-hidden="true">›</span></button>}
        {mine.length > 0 && <div className="composer-popover-heading">常用预设</div>}
        {mine.map((p) => <button type="button" key={p.id} data-testid="preset-chip" aria-pressed={sameOptions(p.options, session.options)} disabled={disabled || busy} title={optionsSummary(choices, p.options)} onClick={() => void apply(p.options, `已换成预设「${p.name}」`)}>{p.name}<span aria-hidden="true">{sameOptions(p.options, session.options) ? "✓" : ""}</span></button>)}
        {!mine.length && session.runtime === "remote" && <p className="composer-popover-note">此会话暂无其他工具选项。</p>}
      </div>}
      {tray === "mcp" && <div className="tray" role="dialog" aria-label="MCP" data-testid="options-tray"><SessionMcpTray link={link} session={session} state={mcp.state} onState={mcp.setState} disabled={disabled} /></div>}
      <span className="composer-options-spacer" />
      <ComposerModelPicker models={choices?.models ?? []} model={model} label={label.main} effort={session.options.effort} fast={session.options.fast} disabled={disabled || busy || !choices} open={tray === "model"} onOpen={(on) => setTray(on ? "model" : null)} onModel={setModel} onEffort={setEffort} onFast={setFast} footer={<p className="composer-popover-note">当前账号：{profile?.label ?? "默认"}。切换型号保留上下文，{when}；其他账号请新开会话。</p>} />
      {note && <span className={note.error ? "form-error composer-options-note" : "applied composer-options-note"} role={note.error ? "alert" : "status"} data-testid="options-note">{note.error ? note.text : `✓ ${note.text}`}</span>}
    </div>
  );
}
