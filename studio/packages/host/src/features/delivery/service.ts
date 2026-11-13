import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Feature } from "../../core/feature.js";
import type { DutyJob, DutyJobResult } from "../duty/service.js";

// 交付值守 (delivery, 2026-11-13, the user: 把这个工具做成定时不停的 Agent，定时提交 git、定时打包、定时推到打包机):
// three of Studio's own jobs, off until the person turns them on in 设置 → 值守.
//   delivery.repo  every 10 min: the checkout's changes committed and pushed to origin and the low Mac's bare repo;
//   delivery.apk   every 6 h: nothing new since the last good build is skipped; otherwise studio/mobile is built and
//                  the APK published to the tool download entry;
//   delivery.ios   every 6 h: the commit goes to the low Mac (172.16.8.160) and build-low-mac.sh makes the TestFlight
//                  build with that Mac's own profile and signing identity.
// A run that finds nothing to do says so and stops quickly; nothing here starts a model.

const HERE = dirname(fileURLToPath(import.meta.url));
/** The studio folder of this checkout (src/features/delivery and dist/features/delivery sit the same depth). */
const STUDIO = resolve(HERE, "../../../../..");
const REPO = resolve(STUDIO, "..");
const MOBILE = join(STUDIO, "mobile");
const APK = join(MOBILE, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const LOW_MAC = "td@172.16.8.160";

const APK_KEY = "delivery.apk";
const IOS_KEY = "delivery.ios";
const GIT_KEY = "delivery.git";
const OUTPUT_KEPT = 3000;

interface Built {
  commit: string;
  at: string;
  version?: string;
  detail?: string;
}

interface Output {
  code: number | null;
  out: string;
  err: string;
}

/** One command, its output kept to a few lines; killed by the item's signal or its own time limit. */
function run(command: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Output> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: opts.cwd ?? REPO, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    const keep = (text: string, chunk: Buffer) => (text + chunk.toString("utf8")).slice(-OUTPUT_KEPT);
    child.stdout!.on("data", (c: Buffer) => { out = keep(out, c); });
    child.stderr!.on("data", (c: Buffer) => { err = keep(err, c); });
    const stop = () => { child.kill(); };
    const timer = opts.timeoutMs ? setTimeout(stop, opts.timeoutMs) : null;
    opts.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (e) => { if (timer) clearTimeout(timer); fail(e); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
      done({ code, out, err });
    });
  });
}

const git = (args: string[], opts: { cwd?: string; signal?: AbortSignal } = {}) => run("git", args, { ...opts, cwd: opts.cwd ?? REPO });

/** The last lines of a command's failure, for a run summary. */
function why(r: Output): string {
  const text = (r.err || r.out).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" / ");
  return (text || ("exit " + r.code)).slice(0, 300);
}

const versionOf = (text: string) => /MARKETING_VERSION\s*=\s*(\S+)/.exec(text)?.[1] ?? "";

export class DeliveryFeature extends Feature {
  private kept<T>(key: string): T | null {
    try { return JSON.parse(this.store.getKv(key)?.value ?? "null") as T | null; } catch { return null; }
  }
  private keep(key: string, value: Built): void {
    this.store.setKv(key, JSON.stringify(value));
  }
  /** The folder the tool download entry reads (the same one DownloadsFeature serves). */
  private dataDir(): string {
    return dirname(this.store.path);
  }
  private async head(): Promise<string> {
    const r = await git(["rev-parse", "HEAD"]);
    if (r.code !== 0) throw new Error("读不到提交：" + why(r));
    return r.out.trim();
  }
  private async hasRemote(name: string): Promise<boolean> {
    const r = await git(["remote"]);
    return r.code === 0 && r.out.split(/\r?\n/).some((x) => x.trim() === name);
  }

  /** Registered by HostService (src/service.ts), like the issues check. */
  jobs(): DutyJob[] {
    return [
      {
        name: "delivery.repo",
        label: "提交并推送代码",
        description: "有改动就提交，推到 GitHub 和低配打包机的仓库；没有改动很快结束。",
        item: { id: "duty-delivery-repo", title: "定时提交代码", schedule: { every: 600 } },
        run: (ctx) => this.syncRepo(ctx.signal),
      },
      {
        name: "delivery.apk",
        label: "打安卓包并发布下载",
        description: "提交变了才打 APK，放进工具下载入口；同一次提交不重复打包。",
        item: { id: "duty-delivery-apk", title: "定时打安卓包", schedule: { every: 6 * 3600 } },
        run: (ctx) => this.buildApk(ctx.signal),
      },
      {
        name: "delivery.ios",
        label: "推送到低配打包机打 TestFlight",
        description: "提交变了才把代码送到 172.16.8.160，用那台机器的证书打包并上传 TestFlight。",
        item: { id: "duty-delivery-ios", title: "定时打 iOS 包", schedule: { every: 6 * 3600 } },
        run: (ctx) => this.buildIos(ctx.signal),
      },
    ];
  }

  // ---- 定时提交代码

  private async syncRepo(signal: AbortSignal): Promise<DutyJobResult> {
    const status = await git(["status", "--porcelain"], { signal });
    if (status.code !== 0) return { ok: false, summary: "读不到改动：" + why(status) };
    if (!status.out.trim()) {
      const head = await this.head();
      return { ok: true, skipped: true, summary: "没有改动（" + head.slice(0, 7) + "）" };
    }
    const add = await git(["add", "-A"], { signal });
    if (add.code !== 0) return { ok: false, summary: "暂存失败：" + why(add) };
    const at = new Date();
    const message = "chore(delivery): 自动提交 " + at.toLocaleString("zh-CN", { hour12: false });
    const commit = await git(["commit", "-m", message], { signal });
    if (commit.code !== 0) return { ok: false, summary: "提交失败：" + why(commit) };
    const head = await this.head();
    const ahead = await git(["rev-list", "--count", "origin/master..HEAD"], { signal });
    if (ahead.code === 0 && Number(ahead.out.trim()) === 0) {
      this.keep(GIT_KEY, { commit: head, at: at.toISOString(), detail: "只有提交，没有要推的" });
      return { ok: true, summary: "已提交 " + head.slice(0, 7) + "，远端已是最新" };
    }
    const pushed: string[] = [];
    const failed: string[] = [];
    const targets = ["origin"];
    if (await this.hasRemote("lowmac")) targets.push("lowmac");
    for (const target of targets) {
      const push = await git(["push", target, "master"], { signal });
      if (push.code === 0) pushed.push(target);
      else failed.push(target + "：" + why(push));
    }
    this.keep(GIT_KEY, { commit: head, at: at.toISOString(), detail: "推送 " + pushed.join("、") });
    if (failed.length) return { ok: false, summary: "已提交 " + head.slice(0, 7) + "；推送失败 " + failed.join("；") };
    return { ok: true, summary: "已提交并推送 " + head.slice(0, 7) + "（" + pushed.join("、") + "）" };
  }

  // ---- 定时打安卓包

  private async buildApk(signal: AbortSignal): Promise<DutyJobResult> {
    const head = await this.head();
    const last = this.kept<Built>(APK_KEY);
    if (last?.commit === head && existsSync(APK)) {
      return { ok: true, skipped: true, summary: "这次提交（" + head.slice(0, 7) + "）已经打过 " + (last.version ?? "APK") };
    }
    const build = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(MOBILE, "build.ps1"), ":app:assembleDebug"], { cwd: REPO, signal, timeoutMs: 45 * 60_000 });
    if (build.code !== 0) return { ok: false, summary: "安卓打包失败：" + why(build) };
    if (!existsSync(APK)) return { ok: false, summary: "打包结束了却没有找到 APK" };
    const publish = await run(process.execPath, [join(STUDIO, "scripts", "tool-downloads.mjs"), "publish", this.dataDir(), APK], { cwd: REPO, signal, timeoutMs: 5 * 60_000 });
    if (publish.code !== 0) return { ok: false, summary: "APK 已生成，发布到下载入口失败：" + why(publish) };
    let version = "";
    try {
      const item = JSON.parse(publish.out.slice(publish.out.indexOf("{"))) as { version?: string };
      version = item.version ? "WorkStudio " + item.version : "";
    } catch { /* 发布成功但输出读不懂：只说打好了 */ }
    const at = new Date();
    this.keep(APK_KEY, { commit: head, at: at.toISOString(), version: version || undefined });
    const size = (statSync(APK).size / 1024 / 1024).toFixed(1);
    return { ok: true, summary: (version || "APK") + " 打好并放进下载入口（" + size + " MB，" + head.slice(0, 7) + "）" };
  }

  // ---- 定时打 iOS 包（低配打包机）

  private async buildIos(signal: AbortSignal): Promise<DutyJobResult> {
    const head = await this.head();
    const last = this.kept<Built>(IOS_KEY);
    if (last?.commit === head) return { ok: true, skipped: true, summary: "这次提交（" + head.slice(0, 7) + "）已经打过 iOS " + (last.version ?? "") };
    const short = head.slice(0, 10);
    const dir = "workstudio-build/src/" + short;
    const unpack = "rm -rf ~/" + dir + " && mkdir -p ~/" + dir + " && tar -xf - -C ~/" + dir;
    const archive = await new Promise<Output>((done, fail) => {
      const tar = spawn("git", ["-c", "core.autocrlf=false", "archive", "--format=tar", head, "studio/mobile"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const ssh = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", LOW_MAC, unpack], { stdio: ["pipe", "pipe", "pipe"] });
      tar.stdout!.pipe(ssh.stdin!);
      let err = "";
      ssh.stderr!.on("data", (c: Buffer) => { err = (err + c.toString("utf8")).slice(-OUTPUT_KEPT); });
      tar.on("error", fail);
      ssh.on("error", fail);
      ssh.on("close", (code) => done({ code, out: "", err }));
    });
    if (archive.code !== 0) return { ok: false, summary: "把代码送到打包机失败：" + why(archive) };
    const committed = await git(["show", head + ":studio/mobile/iosApp/Version.xcconfig"]);
    const version = versionOf(committed.out);
    if (!version) return { ok: false, summary: "读不到 MARKETING_VERSION" };
    const count = await git(["rev-list", "--count", head]);
    const build = count.out.trim();
    if (!/^\d+$/.test(build)) return { ok: false, summary: "算不出构建号" };
    const remote = "nice -n 10 bash ~/" + dir + "/studio/mobile/iosApp/build-low-mac.sh ~/" + dir + "/studio/mobile " + version + " " + build;
    const made = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", LOW_MAC, remote], { signal, timeoutMs: 3 * 3600_000 });
    const at = new Date();
    if (made.code === 0 && /已上传/.test(made.out)) {
      this.keep(IOS_KEY, { commit: head, at: at.toISOString(), version: version + " (" + build + ")" });
      return { ok: true, summary: "iOS " + version + " (" + build + ") 已上传 TestFlight（" + head.slice(0, 7) + "）" };
    }
    if (made.code === 0) {
      this.keep(IOS_KEY, { commit: head, at: at.toISOString(), version: version + " (" + build + ")", detail: "打好没上传" });
      return { ok: true, summary: "iOS " + version + " (" + build + ") 打好了，没有上传（" + head.slice(0, 7) + "）" };
    }
    return { ok: false, summary: "iOS 打包失败：" + why(made) };
  }
}
