import { useEffect, useState } from "react";
import type { ToolDownloadsState } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

export function DownloadsPage({ link }: { link: HostLink }) {
  const [state, setState] = useState<ToolDownloadsState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() { try { setState(await call(link, "GET /api/tool-downloads", {})); } catch (e) { setMessage(String(e)); } }
  useEffect(() => { void refresh(); }, [link]);
  async function configure(enabled: boolean, lan: boolean) {
    setBusy(true); setMessage("");
    try { setState(await call(link, "PUT /api/tool-downloads", {}, { enabled, lan })); }
    catch (e) { setMessage(String(e)); } finally { setBusy(false); }
  }
  const urls = state?.urls ?? [];
  const url = urls.find((u) => !u.includes("127.0.0.1")) ?? urls[0];
  async function copy(text: string) { try { if (window.amo?.copyText) await window.amo.copyText(text); else await navigator.clipboard.writeText(text); setMessage("下载链接已复制"); } catch { setMessage(`请复制链接：${text}`); } }
  function open(url: string) { if (window.amo?.openExternal) void window.amo.openExternal(url); else window.open(url, "_blank", "noopener,noreferrer"); }
  return <section className="settings-section downloads-page">
    <h2>工具下载</h2>
    <p className="muted">在手机浏览器打开下载页，安装手机工作台。同一局域网内可直接下载，无需传递工作台账号。</p>
    <p><label><input type="checkbox" checked={state?.enabled ?? false} disabled={busy || !state} onChange={(e) => void configure(e.target.checked, state?.lan ?? false)} /> 开启本机下载服务</label></p>
    <p><label><input type="checkbox" checked={state?.lan ?? false} disabled={busy || !state} onChange={(e) => void configure(state?.enabled ?? false, e.target.checked)} /> 允许同一局域网的设备下载</label></p>
    <p className="muted">{state?.running ? `服务运行中 · 端口 ${state.port}` : "下载服务未运行"}。这里只提供已发布的安装包；聊天、附件和账号不在下载目录中。</p>
    {url && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><code style={{ userSelect: "all" }}>{url}</code><button onClick={() => void copy(url)}>复制下载页链接</button><button onClick={() => open(url)}>打开下载页 ↗</button></div>}
    <div><button className="btn-ghost small" disabled={busy} onClick={() => void refresh()}>刷新安装包</button></div>
    {state?.items.map((a) => <article key={a.id} style={{ border: "1px solid var(--border, #ddd)", borderRadius: 12, padding: 20, marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>{a.title}</h3><p>Android · {a.version} · {(a.bytes / 1048576).toFixed(1)} MB · {a.publishedAt.slice(0, 10)}</p>
      <p style={{ whiteSpace: "pre-wrap" }}>{a.notes}</p>
      {url && <div style={{ display: "flex", gap: 12 }}><button onClick={() => open(`${url}files/${a.id}`)}>下载 APK</button><button onClick={() => void copy(`${url}files/${a.id}`)}>复制 APK 链接</button></div>}
      <p className="muted" style={{ overflowWrap: "anywhere", fontSize: 11 }}>SHA-256：{a.sha256}</p>
    </article>)}
    {state && !state.items.length && <p className="muted">暂无安装包。发布后点击“刷新安装包”即可显示。</p>}
    {(message || state?.error) && <p role="status">{message || state?.error}</p>}
  </section>;
}
