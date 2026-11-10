import { BUILD_JOB_URL, type BuildJobState, type BuildRun } from "@amo-studio/protocol";
import type { HostService } from "../service.js";
import { newId } from "../store/store.js";
import type { CredentialStore } from "../runtime/credentials.js";
import { HostError } from "./shared.js";

const CREDENTIAL = "jenkins-survivortd-ios";
const STATE_KEY = "build-job.state";
const ENABLED_KEY = "build-job.enabled";
export const isBuildCommand = (text: unknown): boolean => typeof text === "string" && /^\/(打包|build)\s*$/i.test(text.trim());

/** A fixed, owner-configured job. No shell, file uploads, job parameters, browser cookies or model-facing tool. */
export class BuildJob {
  private submitting = false;
  private checking = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  constructor(private readonly host: HostService, private readonly request: typeof fetch = fetch) {}
  private credential(): { username: string; token: string } | null {
    try { const c = JSON.parse(this.host.options.credentials?.read(CREDENTIAL) ?? "null"); return c && typeof c.username === "string" && typeof c.token === "string" ? c : null; } catch { return null; }
  }
  state(): BuildJobState {
    let last: BuildRun | null = null;
    try { last = JSON.parse(this.host.store.getKv(STATE_KEY)?.value ?? "null"); } catch { /* old/corrupt state is not an instruction */ }
    const credential = this.credential();
    return { jobUrl: BUILD_JOB_URL, username: credential?.username ?? "", credentialSaved: !!credential, enabled: this.host.store.getKv(ENABLED_KEY)?.value === "1", last };
  }
  configure(input: { username: string; token?: string; enabled: boolean; clear?: boolean }): BuildJobState {
    const credentials = this.host.options.credentials as CredentialStore | undefined;
    if (input.clear || input.token) {
      if (!credentials?.write || !credentials.remove) throw new HostError("bad_request", "此环境没有可写的系统凭据存储");
      if (input.clear) credentials.remove(CREDENTIAL);
      else {
        if (!input.username.trim() || /[:\r\n]/.test(input.username) || /[\r\n]/.test(input.token!) || input.token!.length > 4096) throw new HostError("bad_request", "Jenkins 账号或 API Token 无效");
        credentials.write(CREDENTIAL, JSON.stringify({ username: input.username.trim(), token: input.token!.trim() }));
      }
    }
    this.host.store.setKv(ENABLED_KEY, input.enabled && !input.clear ? "1" : "0");
    return this.state();
  }
  private headers(): Record<string, string> {
    const credential = this.credential();
    if (!credential) throw new HostError("bad_request", "请先在打包窗口保存 Jenkins 账号和 API Token");
    return { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}`, accept: "application/json" };
  }
  private safeUrl(value: string, queue = false): string {
    const base = new URL(BUILD_JOB_URL);
    const u = new URL(value, base);
    const allowed = queue ? /^\/queue\/item\/\d+\/$/.test(u.pathname) : u.pathname.startsWith(base.pathname) && /^\d+\/$/.test(u.pathname.slice(base.pathname.length));
    if (u.origin !== base.origin || u.username || u.password || u.search || u.hash || !allowed) throw new HostError("bad_request", "Jenkins 返回了未授权的构建地址");
    return u.href;
  }
  private async call(url: string, method = "GET"): Promise<Response> {
    return this.request(url, { method, headers: this.headers(), redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(15_000), this.abort.signal]) });
  }
  private save(run: BuildRun): void {
    if (this.stopped) return;
    this.host.store.setKv(STATE_KEY, JSON.stringify(run));
    if (run.sessionId && this.host.store.getSession(run.sessionId)) {
      const item = this.host.store.appendItem({ id: newId("item"), sessionId: run.sessionId, createdAt: new Date().toISOString(), type: "notice", level: run.status === "failed" || run.status === "unknown" ? "warning" : "info", message: `【iOS 打包】${run.message}\n${run.url}` });
      this.host.publish({ type: "item.appended", item });
    }
  }
  async run(sessionId?: string, commandText = "/打包"): Promise<BuildJobState> {
    if (this.stopped) throw new HostError("read_only", "工作台正在退出");
    if (this.submitting || ["queued", "running"].includes(this.state().last?.status ?? "")) throw new HostError("conflict", "已有打包在排队或运行，请等待结果");
    if (!this.state().enabled) throw new HostError("read_only", "打包指令尚未开启，请先在电脑的打包窗口配置");
    this.headers();
    if (sessionId) {
      const s = this.host.store.getSession(sessionId);
      if (!s || s.runtime === "remote" || s.archivedAt || !s.taskId || !this.host.cooperation.taskAllowed(s.taskId)) throw new HostError("read_only", "请在本机 WorkStudio 创建的有效任务会话中发起打包");
    }
    this.submitting = true;
    try {
      if (sessionId) {
        const item = this.host.store.appendItem({ id: newId("item"), sessionId, createdAt: new Date().toISOString(), type: "user", text: commandText });
        this.host.publish({ type: "item.appended", item });
      }
      // Exactly one POST. A timeout may mean Jenkins accepted it: never retry automatically.
      const response = await this.call(`${BUILD_JOB_URL}build?delay=0sec`, "POST");
      if (response.status !== 201) throw new HostError("bad_request", response.status === 401 || response.status === 403 ? "Jenkins 拒绝访问，请检查账号、API Token 和此 Job 的构建权限" : `Jenkins 未确认入队（HTTP ${response.status}）；请在 Job 页面检查，勿重复点击`);
      const queueUrl = this.safeUrl(response.headers.get("location") ?? "", true);
      this.save({ status: "queued", message: "已进入 Jenkins 队列", url: queueUrl, queueUrl, ...(sessionId ? { sessionId } : {}), updatedAt: new Date().toISOString() });
      this.schedule();
      return this.state();
    } catch (error) {
      const message = error instanceof HostError ? error.message : "请求结果未知，Jenkins 可能已收到打包；请先打开 Job 检查，程序不会自动重试";
      this.save({ status: "unknown", message, url: BUILD_JOB_URL, ...(sessionId ? { sessionId } : {}), updatedAt: new Date().toISOString() });
      return this.state();
    } finally { this.submitting = false; }
  }
  private schedule(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; void this.check(); }, 10_000);
    this.timer.unref();
  }
  async check(): Promise<BuildJobState> {
    if (this.checking || this.stopped) return this.state();
    const last = this.state().last;
    if (!last || !["queued", "running"].includes(last.status)) return this.state();
    this.checking = true;
    try {
      const address = this.safeUrl(last.status === "queued" ? last.queueUrl! : last.url, last.status === "queued");
      const response = await this.call(`${address}api/json`);
      if (!response.ok) throw new Error("status unavailable");
      const data = await response.json() as { cancelled?: boolean; executable?: { url?: string }; building?: boolean; result?: string };
      if (data.cancelled) this.save({ ...last, status: "failed", message: "Jenkins 已取消排队", updatedAt: new Date().toISOString() });
      else if (last.status === "queued" && data.executable?.url) this.save({ ...last, status: "running", url: this.safeUrl(data.executable.url), message: "正在打包", updatedAt: new Date().toISOString() });
      else if (last.status === "running" && data.building === false && data.result) this.save({ ...last, status: data.result === "SUCCESS" ? "success" : "failed", message: data.result === "SUCCESS" ? "打包成功，打开构建页面查看产物" : `打包结束：${String(data.result).slice(0, 80)}`, updatedAt: new Date().toISOString() });
      else if (Date.now() - Date.parse(last.updatedAt) > 2 * 60 * 60_000) throw new Error("poll limit");
    } catch { this.save({ ...last, status: "unknown", message: "暂时无法确认构建状态，请打开 Jenkins 查看；不会重新提交打包", updatedAt: new Date().toISOString() }); }
    finally { this.checking = false; }
    if (["queued", "running"].includes(this.state().last?.status ?? "")) this.schedule();
    return this.state();
  }
  async command(sessionId: string, text = "/打包"): Promise<{ mode: "start" }> {
    if (!isBuildCommand(text)) throw new HostError("bad_request", "打包指令无效");
    await this.run(sessionId, text.trim());
    return { mode: "start" };
  }
  async stop(): Promise<void> { this.stopped = true; this.abort.abort(); if (this.timer) clearTimeout(this.timer); this.timer = null; while (this.submitting || this.checking) await new Promise((resolve) => setTimeout(resolve, 10)); }
}
