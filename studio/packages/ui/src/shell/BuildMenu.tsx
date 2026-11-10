import { useEffect, useState } from "react";
import { BUILD_JOBS, type BuildJobId, type BuildJobState } from "@amo-studio/protocol";
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
  const [job, setJob] = useState<BuildJobId>("ios");
  const refresh = () => call(link, "GET /api/build-job").then(setState);
  useEffect(() => { if (!open) return; void refresh().then(() => undefined).catch((e) => setError(String(e))); const timer = setInterval(() => void refresh().catch(() => undefined), 3000); return () => clearInterval(timer); }, [open, link]);
  const run = async (action: () => Promise<BuildJobState>) => { setBusy(true); setError(""); try { setState(await action()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <>
    <button className="tb-btn" data-testid="build-open" onClick={() => setOpen(true)} title="SurvivorTD iOS / 安卓打包">打包</button>
    {open && <Modal label="Jenkins 打包" className="cooperation-modal" onClose={() => setOpen(false)} busy={busy}><div className="cooperation-content">
      <div style={{ display: "flex", justifyContent: "space-between" }}><h2>Jenkins 打包</h2><button className="btn-ghost" onClick={() => setOpen(false)}>收起窗口</button></div>
      <label>选择打包任务 <select aria-label="打包任务" value={job} onChange={(e) => setJob(e.target.value as BuildJobId)}><option value="ios">SurvivorTD_IOS_Auto</option><option value="android">SurvivorTD_Android_Auto</option></select></label><p>仅执行你指定的这两个 Job，使用 Jenkins 默认参数。也可在对话中输入 # 选择打包预设；失败日志自动交给当前 AI 分析。</p>
      <p><a href={BUILD_JOBS[job].url} target="_blank" rel="noreferrer">打开 Jenkins Job</a></p>
      <button className="btn-primary" data-testid="build-run" disabled={busy || !state?.credentialSaved || !state.enabled || ["queued", "running"].includes(state?.last?.status ?? "")} onClick={() => void run(() => call(link, "POST /api/build-job/run", {}, { job }))}>立即打包</button>{" "}<button className="btn-ghost" disabled={busy} onClick={() => void run(() => call(link, "POST /api/build-job/check"))}>刷新结果</button>
      {state?.last && <><p role="status">{state.last.message}</p><p><a href={state.last.url} target="_blank" rel="noreferrer">查看队列 / 构建结果</a></p></>}
      {state?.last?.errorLog && <details open><summary>失败日志（常见凭据已脱敏）</summary><pre style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", fontSize: 12 }}>{state.last.errorLog}</pre></details>}
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
