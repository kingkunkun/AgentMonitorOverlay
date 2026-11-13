// Explicit user-approved source restart. Never interrupts an active session or kills a Host tree.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";

const [dataArg, hostArg, shellArg, downloadArg, mode] = process.argv.slice(2);
if (!dataArg || !/^\d+$/.test(hostArg ?? "") || !/^\d+$/.test(shellArg ?? "") || !/^\d+$/.test(downloadArg ?? "")) throw new Error("Usage: restart-studio-when-idle.mjs <dataDir> <hostPid> <shellPid> <temporaryDownloadPid> [--check]");
const dataDir = resolve(dataArg), studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expected = { host: Number(hostArg), shell: Number(shellArg), download: Number(downloadArg) };
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const receiptPath = join(dataDir, "restart-after-build.json"), lock = join(dataDir, "restart-after-build.lock");
const receipt = { helperPid: process.pid, expected, status: "checking", at: new Date().toISOString() };
const record = (status, extra = {}) => { Object.assign(receipt, { status, updatedAt: new Date().toISOString() }, extra); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2)); };
function identity(pid) {
  const command = `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`;
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, encoding: "utf8" }).trim();
  return text ? JSON.parse(text) : null;
}
const original = json(join(dataDir, "host.json"));
if (original.pid !== expected.host || json(join(dataDir, "shell.json")).pid !== expected.shell) throw new Error("Running Studio changed; restart cancelled");
const shellIdentity = identity(expected.shell), downloadIdentity = identity(expected.download);
if (!shellIdentity?.CommandLine?.includes("packages/app") || !downloadIdentity?.CommandLine?.includes("tool-downloads.mjs") || !downloadIdentity.CommandLine.includes("serve")) throw new Error("Unexpected process identity; restart cancelled");
const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
async function api(path, method = "GET", body, base = original.url) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json();
}
if (mode === "--check") {
  const health = await api("/api/health"), state = await api("/api/state");
  console.log(JSON.stringify({ valid: true, host: health.pid, running: health.running, tasks: state.tasks.length, sessions: state.sessions.length, temporaryDownloads: expected.download }));
  process.exit(0);
}
writeFileSync(lock, String(process.pid), { flag: "wx" });
try {
  record("waiting-for-idle");
  let quiet = 0;
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
  while (quiet < 3) {
    if (Date.now() > deadline) throw new Error("Still busy after four hours; no process was interrupted");
    if (json(join(dataDir, "host.json")).pid !== expected.host) throw new Error("Host changed while waiting; restart cancelled");
    const health = await api("/api/health");
    if (health.pid !== expected.host) throw new Error("Host identity changed");
    quiet = health.running === 0 ? quiet + 1 : 0;
    await pause(2000);
  }
  const before = await api("/api/state");
  const backupDir = join(dataDir, `backup-before-downloads-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(backupDir);
  const db = new DatabaseSync(join(dataDir, "studio.db"), { readOnly: true });
  try { await backup(db, join(backupDir, "studio.db")); } finally { db.close(); }
  record("backup-ready", { backupDir, before: { tasks: before.tasks.length, sessions: before.sessions.length } });
  // The Host repeats the busy check atomically; a new task starting meanwhile refuses this shutdown.
  await api("/api/shutdown", "POST", { interrupt: false });
  for (let i = 0; i < 120 && alive(expected.host); i++) await pause(500);
  if (alive(expected.host)) throw new Error("Host did not exit gracefully; no force-kill performed");
  for (let i = 0; i < 30 && alive(expected.shell); i++) await pause(500);
  if (alive(expected.shell)) {
    const current = identity(expected.shell);
    if (current?.CreationDate !== shellIdentity.CreationDate || current?.CommandLine !== shellIdentity.CommandLine) throw new Error("Shell identity changed");
    process.kill(expected.shell);
    for (let i = 0; i < 20 && alive(expected.shell); i++) await pause(250);
    if (alive(expected.shell)) throw new Error("Old shell did not exit; no duplicate shell started");
  }
  if (alive(expected.download)) {
    const current = identity(expected.download);
    if (current?.CreationDate !== downloadIdentity.CreationDate || current?.CommandLine !== downloadIdentity.CommandLine) throw new Error("Temporary service identity changed");
    process.kill(expected.download);
    for (let i = 0; i < 20 && alive(expected.download); i++) await pause(250);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|ELECTRON_RUN_AS_NODE$|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$)/.test(key)) delete env[key];
  env.AMO_STUDIO_DATA_DIR = dataDir;
  const shellPid = await new Promise((resolvePid, reject) => {
    const child = spawn(join(studio, "node_modules/electron/dist/electron.exe"), ["packages/app"], { cwd: studio, env, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolvePid(child.pid); });
  });
  record("starting", { shellPid });
  let next;
  for (let i = 0; i < 120; i++) {
    await pause(500);
    try { const candidate = json(join(dataDir, "host.json")); if (candidate.pid !== expected.host && (await api("/api/health", "GET", undefined, candidate.url)).ok) { next = candidate; break; } } catch {}
  }
  if (!next) throw new Error("New Host did not become healthy; backup preserved");
  const after = await api("/api/state", "GET", undefined, next.url);
  if (!before.tasks.every((a) => after.tasks.some((b) => a.id === b.id)) || !before.sessions.every((a) => after.sessions.some((b) => a.id === b.id))) throw new Error("Task/session preservation check failed; backup preserved");
  const downloads = await api("/api/tool-downloads", "GET", undefined, next.url);
  const company = await api("/api/company", "GET", undefined, next.url);
  if (!company.agents?.some((a) => a.id === "company-platform")) throw new Error("Platform agent not loaded");
  if (!downloads.running || !downloads.items.length) throw new Error("New download service unavailable");
  if (!(await fetch(downloads.urls[0], { signal: AbortSignal.timeout(10000) })).ok) throw new Error("Download landing page unavailable");
  record("complete", { hostPid: next.pid, after: { tasks: after.tasks.length, sessions: after.sessions.length }, downloads: downloads.urls, companyLoaded: Boolean(company) });
} catch (e) { record("failed", { error: String(e) }); process.exitCode = 1; }
finally { if (existsSync(lock)) unlinkSync(lock); }
