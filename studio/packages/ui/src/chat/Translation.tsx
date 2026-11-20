import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { TRANSLATION_TEXT_LIMIT, type TranslationResult, type TranslationTarget } from "@amo-studio/protocol";
import { call, copyText, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import "./translation.css";

export const readingTarget = (source: string): TranslationTarget => /\p{Script=Han}/u.test(source) ? "en" : "zh";
export const targetLabel = (target: TranslationTarget) => target === "en" ? "英文" : "中文";
const message = (e: unknown) => e instanceof Error ? e.message : "翻译失败，请重试";
const translate = (link: HostLink, text: string, target: TranslationTarget) => text.length > TRANSLATION_TEXT_LIMIT
  ? Promise.reject(new Error(`一次最多翻译 ${TRANSLATION_TEXT_LIMIT} 个字符，请缩短原文`))
  : call(link, "POST /api/translate", {}, { text, target });

/** Keyed by the composer/session at the call site. Editing or sending invalidates the request, even after undoing an edit. */
export function DraftTranslation({ link, text, onReplace, input, disabled = false }: { link: HostLink; text: string; onReplace(text: string): void; input: RefObject<HTMLInputElement | HTMLTextAreaElement | null>; disabled?: boolean }) {
  const serial = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  useLayoutEffect(() => {
    active.current = false;
    setPending(false); setError("");
    setUndo(last => !disabled && last?.after === text ? last : null);
    return () => { serial.current++; };
  }, [link, text, disabled]);
  const restore = !!undo && undo.after === text;
  function replace(value: string) {
    onReplace(value);
    if (document.activeElement === button.current) {
      const field = input.current;
      field?.focus({ preventScroll: true });
      requestAnimationFrame(() => { if (field && document.activeElement === field && field.value === value) field.setSelectionRange(value.length, value.length); });
    }
  }
  async function click() {
    if (active.current || disabled || !text.trim()) return;
    if (undo && restore) { setUndo(null); replace(undo.before); return; }
    const id = ++serial.current;
    active.current = true; setPending(true); setError("");
    try {
      const result = await translate(link, text, "en");
      if (serial.current !== id) return;
      setUndo({ before: text, after: result.text });
      replace(result.text);
    } catch (err) { if (serial.current === id) setError(message(err)); }
    finally { if (serial.current === id) { active.current = false; setPending(false); } }
  }
  const label = pending ? "翻译中…" : restore ? "撤销翻译" : "译成英文";
  return <span className="draft-translation">
    <button ref={button} className="draft-translate-btn" type="button" disabled={disabled || !text.trim()} aria-disabled={pending || disabled || !text.trim()} aria-busy={pending} onClick={() => void click()} title={restore ? "恢复翻译前的草稿" : "把草稿翻译成英文，可编辑后发送"}>{label}</button>
    {error && <span className="draft-translate-error" role="alert">{error}<button type="button" aria-label="关闭翻译提示" onClick={() => setError("")}>×</button></span>}
  </span>;
}

export function TranslationDialog({ link, source, initialTarget, onClose }: { link: HostLink; source: string; initialTarget: TranslationTarget; onClose(): void }) {
  const [target, setTarget] = useState(initialTarget);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const request = useRef<{ link: HostLink; source: string; target: TranslationTarget; retry: number; promise: Promise<TranslationResult> } | null>(null);
  useEffect(() => {
    let live = true;
    setError(""); setResult(null); setCopied(false);
    const last = request.current;
    if (!last || last.link !== link || last.source !== source || last.target !== target || last.retry !== retry)
      request.current = { link, source, target, retry, promise: translate(link, source, target) };
    void request.current!.promise.then(r => { if (live) setResult(r); }, err => { if (live) setError(message(err)); });
    return () => { live = false; };
  }, [link, source, target, retry]);
  return <Modal label="选段翻译" className="translation-dialog" portal onClose={onClose}>
    <div className="modal-head"><h2>选段翻译</h2><button type="button" className="btn-ghost small" aria-label="关闭翻译" onClick={onClose}>×</button></div>
    <details className="translation-source"><summary>查看原文</summary><p>{source}</p></details>
    <div role="group" aria-label="目标语言" className="translation-languages">{(["zh", "en"] as const).map(t =>
      <button type="button" key={t} className="chip small" aria-pressed={t === target} onClick={() => setTarget(t)}>{targetLabel(t)}</button>)}</div>
    {result ? <div className="translation-output" aria-label="译文">{result.text}</div> : error
      ? <div className="form-error" role="alert">{error} <button type="button" className="link-btn" onClick={() => setRetry(r => r + 1)}>重试</button></div>
      : <div className="settings-hint" role="status">正在译成{targetLabel(target)}…</div>}
    <div className="translation-footer"><small>{result?.model}</small><button type="button" className="btn-ghost small" disabled={!result} onClick={() => { if (result) void copyText(result.text).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? "已复制" : "复制译文"}</button></div>
  </Modal>;
}
