import { useEffect, useRef, useState } from "react";
import type { ModelOption } from "@amo-studio/protocol";
import { effortLabel } from "../lib/choices.js";

export interface ComposerModelGroup { profileId: string; label: string; models: readonly ModelOption[]; loading?: boolean; disabledReason?: string }

function BoltIcon() { return <svg width="14" height="16" viewBox="0 0 16 18" aria-hidden="true"><path d="M9.5 1 2 10h5l-.5 7L14 7H9z" fill="currentColor" /></svg>; }

/** A compact model/effort control, shared by conversation and new-chat composers. */
export function ComposerModelPicker({ models, model, label, effort, fast, disabled, open, onOpen, onModel, onEffort, onFast, footer, fastUsage, groups, profileId, onProfileModel }: {
  models: readonly ModelOption[]; model?: ModelOption; label: string; effort?: string | null; fast?: boolean; disabled?: boolean;
  open: boolean; onOpen(open: boolean): void; onModel(id: string, label: string): void; onEffort(value: string | null): void;
  onFast?(on: boolean): void; footer?: React.ReactNode; fastUsage?: React.ReactNode;
  groups?: readonly ComposerModelGroup[]; profileId?: string; onProfileModel?(profileId: string, id: string, label: string): void;
}) {
  const [page, setPage] = useState<"effort" | "models">("effort");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const current = effort ?? model?.defaultEffort;
  const levels = model?.efforts ?? [];
  const index = Math.max(0, levels.indexOf(current ?? ""));
  useEffect(() => setPreview(index), [index, model?.id, open]);
  useEffect(() => { if (!open) { setPage("effort"); setQuery(""); return; } const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) onOpen(false); }; window.addEventListener("mousedown", close); window.addEventListener("keydown", close); return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); }; }, [open, onOpen]);
  const commit = (i: number) => { const value = levels[i]; if (value && value !== current) onEffort(value); };
  return <div className="composer-model-picker" ref={box}>
    {fast === true && model?.fast && <button type="button" className="composer-fast-active" aria-label="Fast 已开启" aria-pressed="true" data-testid="fast-active" disabled={disabled} title={`Fast 已开启：${model.fast.description ?? "可能更快消耗额度或额外计费"}。点击关闭`} onClick={() => onFast?.(false)}><BoltIcon /></button>}
    <button type="button" className="composer-model-trigger" data-testid="switch-model" aria-label="模型与思考强度" aria-expanded={open} disabled={disabled} onClick={() => onOpen(!open)} onContextMenu={(e) => { e.preventDefault(); setPage("models"); onOpen(true); }} title="选择模型与思考强度 · Alt M">
      <span className="composer-model-name">{label}</span>{levels.length > 0 && <span className="composer-effort-caption" data-testid="effort-label">{current ? effortLabel(current) : "默认"}</span>}<span aria-hidden="true">⌄</span>
    </button>
    {open && <div className={`composer-popover model-effort-popover${page === "models" ? " model-list-popover" : ""}`} role="dialog" aria-label={page === "models" ? "选择模型" : "模型与思考强度"} data-testid="model-effort-popover">
      {page === "effort" ? <>
        <div className="effort-popover-head">
          {model?.fast && onFast ? <span className="fast-control"><button type="button" className="popover-icon" data-testid="fast-toggle" aria-label="Fast 模式" aria-pressed={fast === true} title={model.fast.description ?? "更快的响应速度"} disabled={disabled} onClick={() => onFast(!fast)}><BoltIcon /></button><span className="fast-control-tip" role="tooltip">{fastUsage ?? model.fast.description ?? "Fast 可能更快消耗额度或额外计费。"}</span></span> : <span className="popover-icon-placeholder" />}
          <strong>{levels.length ? effortLabel(levels[preview] ?? current ?? "") : "模型"}</strong>
          <button type="button" className="popover-icon" aria-label="恢复默认思考强度" title="恢复模型默认强度" disabled={disabled || !levels.length} onClick={() => onEffort(null)}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15.4 5.8A6.5 6.5 0 1 1 7 3.8M15.5 2.7v4.5H11" /></svg></button>
        </div>
        <button type="button" className="effort-model-link" aria-label="选择模型" onClick={() => setPage("models")}>{label}<span aria-hidden="true">›</span></button>
        {levels.length > 0 ? <div className="effort-slider" style={{ "--effort-progress": `calc(13px + (100% - 26px) * ${levels.length > 1 ? preview / (levels.length - 1) : 1})` } as React.CSSProperties}>
          <input type="range" aria-label="思考强度" aria-valuetext={effortLabel(levels[preview] ?? "")} min={0} max={Math.max(0, levels.length - 1)} step={1} value={preview} disabled={disabled || levels.length < 2} onChange={(e) => setPreview(Number(e.target.value))} onPointerUp={(e) => commit(Number(e.currentTarget.value))} onKeyUp={(e) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) commit(Number(e.currentTarget.value)); }} />
          <div className="effort-step-dots" aria-hidden="true">{levels.map((level, i) => <span key={level} data-filled={i < preview || undefined} data-selected={i === preview || undefined} style={{ left: `${levels.length > 1 ? i / (levels.length - 1) * 100 : 50}%` }} />)}</div>
        </div> : <p className="composer-popover-note">此模型不提供思考强度选项。</p>}
      </> : <>
        <div className="composer-popover-heading">选择模型<button className="popover-icon" type="button" aria-label="返回思考强度" onClick={() => setPage("effort")}>‹</button></div>
        <input className="composer-model-search" type="search" aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <div className="composer-model-list" role="listbox" aria-label="型号">{(groups ?? [{ profileId: profileId ?? "", label: "", models }]).map((g) => {
          const rows = g.models.filter((m) => `${g.label} ${m.label} ${m.id}`.toLowerCase().includes(query.toLowerCase()));
          if (query && !rows.length && !g.label.toLowerCase().includes(query.toLowerCase())) return null;
          return <div className="composer-model-group" role="group" aria-label={g.label || "当前渠道"} key={g.profileId}>
            {g.label && <div className="composer-model-group-title">{g.label}{g.profileId === profileId ? " · 当前" : ""}</div>}
            {g.loading && <p className="composer-popover-note">正在读取型号…</p>}
            {!g.loading && !g.models.length && <p className="composer-popover-note">暂时无法读取此渠道型号</p>}
            {rows.map((m) => { const selected = (!groups || g.profileId === profileId) && m.id === model?.id; return <button type="button" role="option" key={m.id} aria-selected={selected} disabled={disabled || !!g.disabledReason} title={g.disabledReason ?? m.description} onClick={() => onProfileModel ? onProfileModel(g.profileId, m.id, m.label) : onModel(m.id, m.label)}><span>{m.label}</span><span aria-hidden="true">{selected ? "✓" : ""}</span></button>; })}
          </div>;
        })}</div>
        {footer}
      </>}
    </div>}
  </div>;
}
