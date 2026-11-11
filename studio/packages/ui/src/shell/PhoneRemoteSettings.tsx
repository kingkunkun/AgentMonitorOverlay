import { useRef, useState } from "react";
import type { CooperationState, PhoneAccount } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

export function PhoneRemoteSettings({ link, state, busy, run }: { link: HostLink; state: CooperationState | null; busy: boolean; run(action: () => Promise<unknown>): Promise<void> }) {
  const [name, setName] = useState(""), [password, setPassword] = useState(""), [forward, setForward] = useState(false);
  const server = state?.server;
  const accounts = useRef<HTMLDivElement>(null);
  const addresses = (server?.addresses ?? []).filter((a) => !a.includes("127.0.0.1"));
  const automatic = addresses.filter((a) => a.startsWith("http://169.254."));
  const connectionAddresses = addresses.filter((a) => !automatic.includes(a));
  return <section className="phone-remote-settings" data-testid="phone-remote-settings">
    <h3>手机远程 · {server?.running ? "已开启" : "已关闭"}</h3>
    <p className="muted">使用这台电脑的独立账号，与团队账号和团队远程开关互不影响。手机可查看完整 WorkStudio 聊天，并用本机模型接管执行；不导入原生客户端记录。</p>
    <button className="btn-ghost" data-testid="phone-remote-toggle" disabled={busy} onClick={() => void run(() => call(link, "PUT /api/cooperation/server", {}, { enabled: !server?.running, lan: server?.lan ?? false }))}>{server?.running ? "关闭手机远程" : "开启手机远程"}</button>{" "}
    <label><input type="checkbox" checked={server?.lan ?? false} disabled={busy} onChange={(e) => void run(() => call(link, "PUT /api/cooperation/server", {}, { enabled: server?.running ?? false, lan: e.target.checked }))} /> 允许同一局域网的手机连接</label>
    {server?.error && <p role="alert">{server.error}</p>}
    <p><button className="btn-ghost" data-testid="phone-manage-accounts" onClick={() => accounts.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>管理手机账号</button></p>
    {server?.running && <div className="phone-addresses"><p>手机连接地址（选一个即可）：</p><p className="muted">把地址填到手机 WorkStudio 的“服务器地址”，不需要在浏览器逐个打开。它们来自这台电脑的不同网卡，都是同一个手机服务；选择手机所在网络能访问的地址，虚拟网卡地址通常不可达。</p>{connectionAddresses.map((address) => <p key={address}><code>{address}</code></p>)}{!!automatic.length && <details><summary>自动分配地址（通常不用）</summary>{automatic.map((address) => <p key={address}><code>{address}</code></p>)}</details>}{!server.lan && <p className="muted">当前仅本机可访问，请勾选允许局域网连接。</p>}</div>}
    <div ref={accounts} className="phone-account-management">
    <h4>手机账号管理</h4><p className="muted">账号只能在这台电脑创建。拥有账号即可配对并接管本机聊天，请只给自己信任的手机使用。删除或停用账号会立即断开，电脑里的聊天不删除。</p>
    <div className="phone-account-create">
      <input aria-label="手机账号名称" placeholder="新手机账号" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label="手机账号密码" placeholder="密码（12–128 位）" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label><input type="checkbox" checked={forward} onChange={(e) => setForward(e.target.checked)} /> 同步团队来信</label>
      <button className="btn-primary" disabled={busy || !name.trim() || password.length < 12 || password.length > 128} onClick={() => void run(async () => { await call(link, "POST /api/cooperation/phone-accounts", {}, { name: name.trim(), password, forwardTeamInbox: forward }); setName(""); setPassword(""); setForward(false); })}>创建手机账号</button>
    </div>
    {(server?.accounts ?? []).map((account) => <PhoneAccountRow key={account.name} link={link} account={account} busy={busy} run={run} />)}
    </div>
    <p className="muted">手机登录此账号后，选择名称带“手机远程”的这台电脑申请配对。账号由本机创建，配对后自动同步本机聊天。团队来信只同步给勾选“同步团队来信”的手机账号；不会自动执行。需要接收团队来信时，另行开启 Work中转。</p>
  </section>;
}

function PhoneAccountRow({ link, account, busy, run }: { link: HostLink; account: PhoneAccount; busy: boolean; run(action: () => Promise<unknown>): Promise<void> }) {
  const [editing, setEditing] = useState(false), [password, setPassword] = useState(""), [deleting, setDeleting] = useState(false);
  const patch = (input: { enabled?: boolean; forwardTeamInbox?: boolean; password?: string }) => call(link, "PATCH /api/cooperation/phone-accounts/:name", { name: account.name }, input);
  return <div className="phone-account-row" data-testid="phone-account-row">
    <strong>{account.name}</strong><span className="muted">{account.enabled ? "可登录" : "已停用"} · {account.devices} 台手机在线 · 全部本机聊天</span>
    <label><input type="checkbox" checked={account.forwardTeamInbox} disabled={busy} onChange={(e) => void run(() => patch({ forwardTeamInbox: e.target.checked }))} /> 同步团队来信</label>
    <div><button className="btn-ghost" disabled={busy} onClick={() => void run(() => patch({ enabled: !account.enabled }))}>{account.enabled ? "停用账号" : "启用账号"}</button>{" "}<button className="btn-ghost" disabled={busy} onClick={() => { setEditing(!editing); setPassword(""); }}>重设密码</button>{" "}<button className="btn-ghost danger" disabled={busy} onClick={() => setDeleting(!deleting)}>删除账号</button></div>
    {editing && <div><input aria-label={`${account.name} 的新密码`} type="password" autoComplete="new-password" placeholder="新密码（12–128 位）" value={password} onChange={(e) => setPassword(e.target.value)} /><button className="btn-ghost" disabled={busy || password.length < 12 || password.length > 128} onClick={() => void run(async () => { await patch({ password }); setPassword(""); setEditing(false); })}>保存新密码并断开旧登录</button></div>}
    {deleting && <div role="alert">删除“{account.name}”并断开它的手机？聊天记录保留。<button className="btn-ghost danger" disabled={busy} onClick={() => void run(() => call(link, "DELETE /api/cooperation/phone-accounts/:name", { name: account.name }))}>确认删除</button>{" "}<button className="btn-ghost" onClick={() => setDeleting(false)}>取消</button></div>}
  </div>;
}
