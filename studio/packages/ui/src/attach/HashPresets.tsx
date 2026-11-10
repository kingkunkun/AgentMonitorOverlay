import { useEffect, useState } from "react";
import { presetMessage, type ChatPreset, type ChatPresetsState } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import "../shell/cooperation.css";

export function useChatPresets(link: HostLink): ChatPreset[] {
  const [presets, setPresets] = useState<ChatPreset[]>([]);
  useEffect(() => { let live = true; const load = () => void call(link, "GET /api/chat-presets").then((s) => { if (live) setPresets(s.presets); }).catch(() => undefined); load(); window.addEventListener("amo:chat-presets", load); return () => { live = false; window.removeEventListener("amo:chat-presets", load); }; }, [link]);
  return presets;
}

export function HashPresetSettings({ link, onPick }: { link: HostLink; onPick?(text: string): void }) {
  const [state, setState] = useState<ChatPresetsState | null>(null);
  const [drafts, setDrafts] = useState<ChatPreset[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { let live = true; void call(link, "GET /api/chat-presets").then((s) => { if (live) { setState(s); setDrafts(s.presets); setSelected(s.presets[0]?.id ?? ""); } }).catch((e) => { if (live) setError(String(e)); }); return () => { live = false; }; }, [link]);
  const current = drafts.find((p) => p.id === selected);
  const patch = (p: Partial<ChatPreset>) => { setDrafts((all) => all.map((t) => t.id === selected ? { ...t, ...p } : t)); setMessage(""); };
  const save = async () => { setBusy(true); setError(""); try { const s = await call(link, "PUT /api/chat-presets", {}, { presets: drafts }); setState(s); setDrafts(s.presets); setMessage("已保存到本地设置文档"); window.dispatchEvent(new Event("amo:chat-presets")); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <section className="hash-presets-settings">
    <h3># 提示词与默认聊天任务</h3>
    <p>输入 # 弹出预设，选中后填入默认任务；发送才执行。绑定打包后由工作台提交 Job，成功或失败回到原会话，失败日志自动交给当前 AI 分析。</p>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0" }}>{drafts.map((p) => <button className={selected === p.id ? "btn-primary" : "btn-ghost"} key={p.id} onClick={() => setSelected(p.id)}>#{p.phrase}</button>)}</div>
    {current && <div style={{ display: "grid", gap: 10 }}>
      <label>提示词名称（不含 #）<input aria-label="提示词名称" value={current.phrase} onChange={(e) => patch({ phrase: e.target.value })} /></label>
      <label>默认聊天任务<textarea aria-label="默认聊天任务" rows={6} value={current.prompt} onChange={(e) => patch({ prompt: e.target.value })} style={{ width: "100%", boxSizing: "border-box", resize: "vertical" }} /></label>
      <label>发送后的自动任务 <select aria-label="自动任务" value={current.job ?? ""} onChange={(e) => patch({ job: e.target.value === "ios" ? "ios" : e.target.value === "android" ? "android" : null })}><option value="">仅填入提示词，由 AI 对话处理</option><option value="ios">高配打包机 · iOS</option><option value="android">高配打包机 · 安卓</option></select></label>
      {onPick && <button className="btn-primary" disabled={busy} onClick={() => { const saved = state?.presets.find((p) => p.id === current.id); if (saved && JSON.stringify(saved) === JSON.stringify(current)) onPick(presetMessage(current)); else setError("请先保存修改，再使用这条预设"); }}>填入当前对话</button>}
    </div>}
    <p style={{ display: "flex", gap: 8 }}><button className="btn-primary" disabled={busy || !state} onClick={() => void save()}>保存提示词</button><button className="btn-ghost" disabled={busy || !state || drafts.length >= 100} onClick={() => { const p: ChatPreset = { id: `preset-${crypto.randomUUID()}`, phrase: "新提示词", prompt: "请完成下面的任务。", job: null }; setDrafts((all) => [...all, p]); setSelected(p.id); }}>新增提示词</button><button className="btn-ghost" disabled={busy || !current} onClick={() => { const next = drafts.filter((p) => p.id !== selected); setDrafts(next); setSelected(next[0]?.id ?? ""); }}>移除此项（保存生效）</button></p>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {state && <p className="muted">本地设置文档：<code style={{ overflowWrap: "anywhere" }}>{state.filePath}</code>。不保存密码或 Token；两种打包复用电脑“打包”窗口配置的 Jenkins 接口凭据。日志只自动提取有限尾部并做常见凭据脱敏。</p>}
  </section>;
}

export function HashPresetButton({ link, onPick }: { link: HostLink; onPick?(text: string): void }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="btn-ghost small" data-testid="hash-presets-open" onClick={() => setOpen(true)} title="# 提示词：默认任务、iOS / 安卓自动打包"># 提示词</button>{open && <Modal label="# 提示词" className="cooperation-modal" onClose={() => setOpen(false)}><div className="cooperation-content"><div style={{ display: "flex", justifyContent: "space-between" }}><h2># 提示词</h2><button className="btn-ghost" onClick={() => setOpen(false)}>关闭</button></div><HashPresetSettings link={link} onPick={onPick ? (text) => { onPick(text); setOpen(false); } : undefined} /></div></Modal>}</>;
}
