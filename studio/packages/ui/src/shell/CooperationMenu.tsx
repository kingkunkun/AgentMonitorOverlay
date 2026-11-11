import { useEffect, useState } from "react";
import type { CooperationState } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import "./cooperation.css";
import { PhoneRemoteSettings } from "./PhoneRemoteSettings.js";

export function CooperationMenu({ link, onRemote }: { link: HostLink; onRemote(): void }) {
  const [state, setState] = useState<CooperationState | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const refresh = () => call(link, "GET /api/cooperation").then((s) => { setState(s); if (s.transfers.length) setOpen(true); });
  const preferredServer = state?.account?.server || state?.recentServers?.[0] || "";
  useEffect(() => { if (preferredServer) setServer((current) => current || preferredServer); }, [preferredServer]);
  useEffect(() => { let live = true; const read = () => { if (live) void refresh().catch(() => undefined); }; read(); const t = setInterval(read, 2000); return () => { live = false; clearInterval(t); }; }, [link]);
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(""); try { await action(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const active = !!state?.account || state?.remoteEnabled || state?.relayEnabled || state?.server.running;
  const loginMissing = !server.trim() ? "请先填写或选择服务器地址" : !name.trim() ? "请输入账号" : !password ? "请输入密码" : "";
  return <>
    <button type="button" className="tb-btn" data-testid="cooperation-open" onClick={() => setOpen(true)} title={`账号：${state?.account?.name ?? "未登录"}；远程：${state?.remoteEnabled ? "开" : "关"}；中转：${state?.relayEnabled ? "开" : "关"}`}>合作模式 · {active ? `团队${state?.remoteEnabled ? "开" : "关"} / 中转${state?.relayEnabled ? "开" : "关"} / 手机${state?.server.running ? "开" : "关"}` : "已关闭"}{!!state?.transfers.length && " · 待确认"}</button>
    {/* Electron's draggable titlebar swallows scrollbar drags; the dialog must live outside it. */}
    {open && <Modal label="合作模式" className="cooperation-modal" portal onClose={() => setOpen(false)} busy={busy}>
      <div className="cooperation-content">
        <div className="cooperation-header"><h2>合作模式</h2><button className="btn-ghost" onClick={() => setOpen(false)}>收起窗口</button></div>
        <p className="muted">团队账号、团队远程、中转和手机远程分别管理。收起窗口不会关闭功能。</p>
        <button className="btn-ghost danger" data-testid="cooperation-off" disabled={busy} onClick={() => void run(() => call(link, "POST /api/cooperation/off"))}>一键关闭合作模式并退出账号</button>
        {error && <p role="alert">{error}</p>}
        <hr /><h3>团队账号</h3>
        {state?.account ? <><p>{state.account.name} · {state.account.server}</p><button className="btn-ghost" disabled={busy} onClick={() => void run(() => call(link, "POST /api/cooperation/logout"))}>退出团队账号并关闭团队远程、中转</button></> : <div style={{ display: "grid", gap: 8 }}>
          <input aria-label="服务器地址" placeholder="团队服务器地址，例如 http://172.16.8.85:47120" value={server} onChange={(e) => setServer(e.target.value)} />
          {!!state?.recentServers?.length && <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}><span className="muted">最近使用：</span>{state.recentServers.map((s) => <button className="btn-ghost" key={s} onClick={() => setServer(s)}>{s}</button>)}</div>}
          <input aria-label="账号" placeholder="账号" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="密码" placeholder="密码（至少 12 位）" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input aria-label="注册邀请码" placeholder="注册邀请码（注册时填写）" value={invite} onChange={(e) => setInvite(e.target.value)} />
          <div><button className="btn-primary" title={loginMissing || "登录账号；不会自动开启远程或中转"} disabled={busy || !!loginMissing} onClick={() => void run(async () => { await call(link, "POST /api/cooperation/account", {}, { action: "login", server, name, password }); setPassword(""); })}>登录账号</button>{" "}<button className="btn-ghost" disabled={busy || !!loginMissing || password.length < 12} onClick={() => void run(async () => { await call(link, "POST /api/cooperation/account", {}, { action: "register", server, name, password, passphrase: invite }); setPassword(""); })}>创建账号并登录</button></div>
          {loginMissing && <p className="muted" role="status">{loginMissing}</p>}
        </div>}
        <hr /><h3>团队远程 · {state?.remoteEnabled ? "已开启" : "已关闭"}</h3>
        <p className="muted">仅使用上方团队账号，与团队服务器中的其他账号协作。关闭不影响手机远程；配对和任务授权仍需本机确认。</p>
        <button className="btn-ghost" data-testid="cooperation-remote-toggle" disabled={busy || !state?.account} onClick={() => void run(() => call(link, "PUT /api/remote/enabled", {}, { enabled: !state?.remoteEnabled }))}>{state?.remoteEnabled ? "关闭远程" : "开启远程"}</button>{" "}<button className="btn-ghost" onClick={() => { setOpen(false); onRemote(); }}>设备配对与任务授权</button>
        <hr /><h3>Work中转 · {state?.relayEnabled ? "已开启" : "已关闭"}</h3>
        <button className="btn-ghost" data-testid="cooperation-relay-toggle" disabled={busy || !state?.account} onClick={() => void run(() => call(link, "PUT /api/cooperation/relay", {}, { enabled: !state?.relayEnabled }))}>{state?.relayEnabled ? "关闭中转" : "开启中转"}</button>{" "}<button className="btn-ghost" disabled={!state?.relayEnabled} onClick={() => void window.amo?.openInRelay?.().catch((e) => setError(String(e)))}>打开中转窗口</button>
        <hr /><PhoneRemoteSettings link={link} state={state} busy={busy} run={run} />
        <hr /><h3>本机外发确认</h3><p className="muted">原生 Claude / Codex / DOT 对话禁止导入。AI 的全部允许不能跳过 WorkStudio 文件外发确认。</p>
        {state?.transfers.map((t) => <div key={t.id} style={{ padding: 10, border: "1px solid var(--border)", margin: "8px 0" }}><strong>{t.peer}</strong><p style={{ overflowWrap: "anywhere" }}>{t.path}</p><button className="btn-primary" onClick={() => void run(() => call(link, "POST /api/cooperation/transfers/:id", { id: t.id }, { allow: true }))}>仅允许本次发送</button>{" "}<button className="btn-ghost" onClick={() => void run(() => call(link, "POST /api/cooperation/transfers/:id", { id: t.id }, { allow: false }))}>拒绝</button></div>)}
      </div>
    </Modal>}
  </>;
}
