import { useEffect, useRef, useState } from "react";
import { BUILD_JOB_IDS, BUILD_JOBS, type BuildJobId, type BuildJobState, type BuildRun } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import "./cooperation.css";

// Jenkins 打包 (2026-11-18): the 6 owner-approved SurvivorTD jobs as buttons. 整包 and 母包 take the build machine for long:
// their button asks for a second click. The login is shared with jenkins-build-mcp (one Windows credential entry).

const GROUPS: Array<{ title: string; platform: "ios" | "android" }> = [{ title: "iOS", platform: "ios" }, { title: "安卓", platform: "android" }];
const active = (run?: BuildRun) => run?.status === "queued" || run?.status === "running";
const SEEN_KEY = "amo.build-job.seen-failure";

function useBuildState(link: HostLink, ms: number) {
  const [state, setState] = useState<BuildJobState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = () => call(link, "GET /api/build-job").then((s) => { if (live) { setState(s); setError(""); } }).catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const timer = setInterval(() => void load(), ms);
    return () => { live = false; clearInterval(timer); };
  }, [link, ms]);
  return { state, setState, error, setError };
}

/** The 6 buttons with each job's latest result. Used by the 打包 window and 设置 → MCP's jenkins-build card. */
export function BuildJobButtons({ link, state, onState, onError, compact }: { link: HostLink; state: BuildJobState | null; onState: (s: BuildJobState) => void; onError: (message: string) => void; compact?: boolean }) {
  const [busy, setBusy] = useState<BuildJobId | null>(null);
  const [arming, setArming] = useState<BuildJobId | null>(null);
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (disarm.current) clearTimeout(disarm.current); }, []);
  const ready = !!state?.credentialSaved && !!state.enabled;
  const start = async (id: BuildJobId) => {
    if (BUILD_JOBS[id].confirm && arming !== id) {
      setArming(id);
      if (disarm.current) clearTimeout(disarm.current);
      disarm.current = setTimeout(() => setArming(null), 6000);
      return;
    }
    setArming(null); setBusy(id); onError("");
    try { onState(await call(link, "POST /api/build-job/run", {}, { job: id })); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  return <div className="build-jobs" style={{ display: "grid", gap: 8 }}>
    {!ready && <p className="settings-hint">{state?.credentialSaved ? "Jenkins 账号已保存，打包尚未开启：在顶栏「打包」窗口点「保存并开启」。" : "还没有 Jenkins 登录：在顶栏「打包」窗口填账号和密码，或运行 jenkins-build-mcp 的 login。"}</p>}
    {GROUPS.map((g) => <div key={g.platform} style={{ display: "grid", gap: 4 }}>
      <strong>{g.title}</strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {BUILD_JOB_IDS.filter((id) => BUILD_JOBS[id].platform === g.platform).map((id) => {
          const run = state?.runs?.[id];
          return <button key={id} type="button" className={arming === id ? "btn-primary small" : "btn-ghost small"} data-testid={`build-run-${id}`} title={`${BUILD_JOBS[id].name}（Jenkins 默认参数）`}
            disabled={!ready || busy !== null || active(run)} onClick={() => void start(id)}>
            {busy === id ? "提交中…" : arming === id ? `再点一次确认：${BUILD_JOBS[id].label}` : active(run) ? `${BUILD_JOBS[id].label}（进行中）` : BUILD_JOBS[id].label}
          </button>;
        })}
      </div>
      {!compact && BUILD_JOB_IDS.filter((id) => BUILD_JOBS[id].platform === g.platform && state?.runs?.[id]).map((id) => {
        const run = state!.runs[id]!;
        return <span key={id} className="settings-hint" role="status">{BUILD_JOBS[id].label}：{run.message} · <a href={run.url} target="_blank" rel="noreferrer">{run.status === "queued" ? "查看队列" : "查看构建"}</a></span>;
      })}
      {compact && BUILD_JOB_IDS.filter((id) => BUILD_JOBS[id].platform === g.platform && active(state?.runs?.[id])).map((id) => <span key={id} className="settings-hint" role="status">{BUILD_JOBS[id].label}：{state!.runs[id]!.message}</span>)}
    </div>)}
  </div>;
}

export function BuildMenu({ link }: { link: HostLink }) {
  const [open, setOpen] = useState(false);
  const { state, setState, error, setError } = useBuildState(link, open ? 3000 : 15000);
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  // A failure only this computer was told about (no 中转, or this is WNY's own computer): open the window on it once.
  useEffect(() => {
    const failed = Object.values(state?.runs ?? {}).filter((r) => r?.status === "failed" && r.notified === "local").sort((a, b) => Date.parse(b!.updatedAt) - Date.parse(a!.updatedAt))[0];
    if (!failed || Date.now() - Date.parse(failed.updatedAt) > 3600_000) return;
    const mark = `${failed.job}:${failed.url}`;
    if (localStorage.getItem(SEEN_KEY) === mark) return;
    localStorage.setItem(SEEN_KEY, mark);
    setOpen(true);
  }, [state]);
  const run = async (action: () => Promise<BuildJobState>) => { setBusy(true); setError(""); try { setState(await action()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const failed = Object.values(state?.runs ?? {}).filter((r) => r?.status === "failed" && r.errorLog).sort((a, b) => Date.parse(b!.updatedAt) - Date.parse(a!.updatedAt))[0];
  const running = Object.values(state?.runs ?? {}).some(active);
  return <>
    <button className="tb-btn" data-testid="build-open" onClick={() => setOpen(true)} title="SurvivorTD iOS / 安卓 Jenkins 打包">{running ? "打包中" : "打包"}</button>
    {open && <Modal label="Jenkins 打包" className="cooperation-modal" onClose={() => setOpen(false)} busy={busy}><div className="cooperation-content">
      <div style={{ display: "flex", justifyContent: "space-between" }}><h2>Jenkins 打包</h2><button className="btn-ghost" onClick={() => setOpen(false)}>收起窗口</button></div>
      <p>点按钮直接触发对应 Job，使用 Jenkins 默认参数；整包和母包要再点一次确认。不同 Job 可以同时跑，同一个 Job 等上一次结束后再点。构建失败会通过中转 @WNY 通知（本机就是 WNY 或没登录中转时只在本机弹出）。也可在对话中输入 # 选打包预设。</p>
      <BuildJobButtons link={link} state={state} onState={setState} onError={setError} />
      <p><button className="btn-ghost" disabled={busy} onClick={() => void run(() => call(link, "POST /api/build-job/check"))}>刷新结果</button></p>
      {failed && <details open={failed.notified === "local"}><summary>{BUILD_JOBS[failed.job ?? "ios"].label} 失败日志（常见凭据已脱敏）</summary><pre style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto", fontSize: 12 }}>{failed.errorLog}</pre></details>}
      {error && <p role="alert">{error}</p>}
      <hr /><h3>本机配置 · {state?.enabled ? "已开启" : "已关闭"}</h3>
      <p>Jenkins 账号：{state?.username || "未配置"}。密码只保存到 Windows 凭据管理器，和 jenkins-build-mcp 共用同一条，不发给手机、不进入模型对话。</p>
      <input aria-label="Jenkins 账号" placeholder="Jenkins 账号" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input aria-label="Jenkins 密码或 API Token" placeholder={state?.credentialSaved ? "密码已保存；不修改则留空" : "Jenkins 登录密码或 API Token"} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
      <p><button className="btn-ghost" disabled={busy || !state?.credentialSaved && (!username || !token)} onClick={() => void run(async () => { const s = await call(link, "PUT /api/build-job", {}, { username: username || state?.username || "", ...(token ? { token } : {}), enabled: true }); setToken(""); return s; })}>保存并开启</button>{" "}<button className="btn-ghost" disabled={busy} onClick={() => void run(() => call(link, "PUT /api/build-job", {}, { username: state?.username || "", enabled: false }))}>关闭打包</button>{" "}<button className="btn-ghost" disabled={busy || !state?.credentialSaved} onClick={() => void run(() => call(link, "PUT /api/build-job", {}, { username: state?.username || "", enabled: false, clear: true }))}>清除 Jenkins 登录</button></p>
      <p className="muted">手机用自己的账号登录、配对电脑，并获当前任务授权后可发 # 打包预设；其他账号不能触发。当前 Jenkins 是 HTTP，密码会经过公司局域网，请仅使用可信网络。</p>
    </div></Modal>}
  </>;
}

/** 设置 → MCP: the buttons on the jenkins-build card. */
export function BuildJobCard({ link }: { link: HostLink }) {
  const { state, setState, error, setError } = useBuildState(link, 5000);
  return <div style={{ padding: "4px 0 8px 12px" }}>
    <BuildJobButtons link={link} state={state} onState={setState} onError={setError} compact />
    {error && <span className="form-error" role="alert">{error}</span>}
  </div>;
}

