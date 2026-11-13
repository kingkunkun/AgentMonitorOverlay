import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PermissionOption } from "@amo-studio/protocol";

type PermissionKind = "ask" | "auto" | "full";
export function permissionView(p: PermissionOption, codex = false) {
  const full = ["full-auto", "full-access", "bypassPermissions", "danger-full-access"].includes(p.id);
  if (full) return { label: "完全访问权限", caption: "完全访问", description: "可不受限制地访问互联网和你电脑上的任何文件", kind: "full" as const };
  if (codex && p.id === "workspace-write") return { label: "请求批准", caption: "请求批准", description: "编辑外部文件和使用互联网时始终询问", kind: "ask" as const };
  if (["auto-review", "auto"].includes(p.id)) return { label: "帮我批准", caption: "帮我批准", description: "仅对检测到的风险操作请求批准", kind: "auto" as const };
  return { label: p.label, caption: p.label, description: p.description, kind: "ask" as const };
}

export function PermissionIcon({ kind = "ask" }: { kind?: PermissionKind }) {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "ask" ? <path d="M6.5 10V5.5a1 1 0 0 1 2 0V9m0-3.5V3.8a1 1 0 0 1 2 0V9m0-3.5a1 1 0 0 1 2 0V10m0-2a1 1 0 0 1 2 0v5c0 3-1.4 4.5-4 4.5-2 0-3.2-1-4.3-2.7L4 11.4a1.1 1.1 0 0 1 1.7-1.3l.8.9" /> : <><path d="m10 2 6.5 2.7v5.1c0 3.4-2.3 5.9-6.5 8.2-4.2-2.3-6.5-4.8-6.5-8.2V4.7z" />{kind === "full" ? <path d="M10 6v5m0 2.5v.1" /> : <path d="m7.2 9.8 1.9 1.9 3.7-4" />}</>}
  </svg>;
}

/** Keep the runtime ids intact: the three primary choices are only aliases for capabilities the channel supplies. */
export function PermissionMenu({ permissions, value, disabled, onPick, children }: { permissions: readonly PermissionOption[]; value?: string; disabled?: boolean; onPick(id: string): void; children?: ReactNode }) {
  const codex = permissions.some((p) => p.id === "auto-review");
  const mainIds = codex ? ["workspace-write", "auto-review", "full-auto"] : ["default", "auto", "bypassPermissions"];
  const primary = mainIds.flatMap((id) => permissions.filter((p) => p.id === id));
  const extra = permissions.filter((p) => !mainIds.includes(p.id));
  const [more, setMore] = useState(false);
  const [learn, setLearn] = useState(false);
  const row = (p: PermissionOption) => {
    const view = permissionView(p, codex);
    return <button type="button" className="composer-permission-option" data-kind={view.kind} key={p.id} disabled={disabled || !!p.unavailable} aria-pressed={value === p.id} onClick={() => onPick(p.id)} title={p.unavailable ?? p.description}>
      <PermissionIcon kind={view.kind} /><span className="permission-option-copy"><b>{view.label}</b><small>{p.unavailable ?? view.description}</small></span><span className="permission-check" aria-hidden="true">{value === p.id ? "✓" : ""}</span>
    </button>;
  };
  return <>
    <div className="composer-popover-heading permission-heading"><span>应如何批准 WorkStudio 操作？</span><button type="button" className="permission-learn" aria-expanded={learn} onClick={() => setLearn(!learn)}>了解更多</button></div>
    {(primary.length ? primary : permissions).map(row)}
    {learn && <div className="permission-details">{(primary.length ? primary : permissions).map((p) => <p key={p.id}><b>{permissionView(p, codex).label}：</b>{p.description}</p>)}<p>权限仅作用于此会话；应用的本机文件外发确认仍然有效。</p>{primary.length > 0 && extra.length > 0 && <><button type="button" className="permission-more" aria-expanded={more} onClick={() => setMore(!more)}>更多权限<span aria-hidden="true">{more ? "⌃" : "⌄"}</span></button>{more && extra.map(row)}</>}</div>}
    {children}
  </>;
}

export function PermissionPicker({ permissions, value, disabled, onPick }: { permissions: readonly PermissionOption[]; value?: string; disabled?: boolean; onPick(id: string): void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const selected = permissions.find((p) => p.id === value);
  const view = selected && permissionView(selected, permissions.some((p) => p.id === "auto-review"));
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close); window.addEventListener("keydown", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); };
  }, [open]);
  return <div className="composer-permission-picker" ref={box}>
    <button type="button" className="composer-permission" data-full-access={view?.kind === "full" || undefined} aria-label="权限" aria-expanded={open} data-testid="switch-permission" disabled={disabled} onClick={() => setOpen(!open)}><PermissionIcon kind={view?.kind} />{view?.caption ?? "默认权限"}</button>
    {open && <div className="composer-popover composer-permission-menu" role="dialog" aria-label="权限"><PermissionMenu permissions={permissions} value={value} disabled={disabled} onPick={(id) => { onPick(id); setOpen(false); }} /></div>}
  </div>;
}
