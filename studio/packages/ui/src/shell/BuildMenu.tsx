import { useEffect, useState } from "react";
import type { BuildJobState } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import "./cooperation.css";

export function BuildMenu({ link }: { link: HostLink }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BuildJobState | null>(null);
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = () => call(link, "GET /api/build-job").then(setState);
  useEffect(() => { if (!open) return; void refresh().then(() => undefined).catch((e) => setError(String(e))); const timer = setInterval(() => void refresh().catch(() => undefined), 3000); return () => clearInterval(timer); }, [open, link]);
  const run = async (action: () => Promise<BuildJobState>) => { setBusy(true); setError(""); try { setState(await action()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <>
    <button className="tb-btn" data-testid="build-open" onClick={() => setOpen(true)} title="SurvivorTD iOS 打包">打包</button>
    {open && <Modal label="iOS 打包" className="cooperation-modal" onClose={() => setOpen(false)} busy={busy}><div className="cooperation-content">
      <div style={{ display: "flex", justifyContent: "space-between" }}><h2>iOS 打包</h2><button className="btn-ghost" onClick={() => setOpen(false)}>收起窗口</button></div>
      <h3>SurvivorTD_IOS_Auto</h3><p>只执行这个 Job，使用 Jenkins 默认参数。打开窗口不会触发；点击“立即打包”或在已授权会话发送 <code>/打包</code> 才执行。</p>
      <p><a href={state?.jobUrl} target="_blank" rel="noreferrer">打开 Jenkins Job</a></p>
      <button className="btn-primary" data-testid="build-run" disabled={busy || !state?.credentialSaved || !state.enabled || ["queued", "running"].includes(state?.last?.status ?? "")} onClick={() => void run(() => call(link, "POST /api/build-job/run"))}>立即打包</button>{" "}<button className="btn-ghost" disabled={busy} onClick={() => void run(() => call(link, "POST /api/build-job/check"))}>刷新结果</button>
      {state?.last && <><p role="status">{state.last.message}</p><p><a href={state.last.url} target="_blank" rel="noreferrer">查看队列 / 构建结果</a></p></>}
      {error && <p role="alert">{error}</p>}
      <hr /><h3>本机配置 · {state?.enabled ? "已开启" : "已关闭"}</h3>
      <p>Jenkins 账号：{state?.username || "未配置"}。API Token 只保存到 Windows 凭据管理器，不发给手机、不进入模型对话。</p>
      <input aria-label="Jenkins 账号" placeholder="Jenkins 账号" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input aria-label="Jenkins API Token" placeholder={state?.credentialSaved ? "API Token 已保存；不修改则留空" : "Jenkins API Token（不是登录密码）"} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
      <p><button className="btn-ghost" disabled={busy || !state?.credentialSaved && (!username || !token)} onClick={() => void run(async () => { const s = await call(link, "PUT /api/build-job", {}, { username: username || state?.username || "", ...(token ? { token } : {}), enabled: true }); setToken(""); return s; })}>保存并开启打包指令</button>{" "}<button className="btn-ghost" disabled={busy} onClick={() => void run(() => call(link, "PUT /api/build-job", {}, { username: state?.username || "", enabled: false }))}>关闭打包指令</button>{" "}<button className="btn-ghost" disabled={busy || !state?.credentialSaved} onClick={() => void run(() => call(link, "PUT /api/build-job", {}, { username: state?.username || "", enabled: false, clear: true }))}>清除接口凭据</button></p>
      <p className="muted">手机用自己的账号登录、配对电脑，并获当前任务授权后可发 /打包；其他账号不能触发。关闭合作模式后手机不能发指令。当前 Jenkins 是 HTTP，接口凭据会经过公司局域网，请仅使用可信网络。</p>
    </div></Modal>}
  </>;
}
