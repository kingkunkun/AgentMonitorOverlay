import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const meterKey = (id: string) => createHash("sha256").update(id).digest("hex");
export const count = (v: unknown): number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
export function localDate(at: string | number): string | null {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export type Parts = { input: number; cached: number; output: number };
export const total = (p: Parts) => p.input + p.cached + p.output;
export interface CodexMeter { key: string; tokens: number; start: number; end: number; studio: number }
export interface ClaudeReceipt extends Parts { key: string; date: string }
export interface ClaudeCache { through: string; parts: Parts }
export interface MeterPaths { codex: string; claude: string; claudeConfig: string }

/** Read only the installed index with the highest schema number, never sum copies/migrations. SQLite projects only
 * meter fields; native thread lists, rollout files, titles, previews, user/account IDs and paths are not requested. */
export async function codexMeters(dir: string, studioRefs: Set<string>): Promise<CodexMeter[]> {
  const files = (await readdir(dir)).filter(f => /^state_\d+\.sqlite$/.test(f)).sort((a,b) => Number(b.slice(6,-7))-Number(a.slice(6,-7)));
  if (!files[0]) throw new Error("no meter");
  const db = new DatabaseSync(join(dir, files[0]), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=120;");
    const cols = new Set(db.prepare("PRAGMA table_info(threads)").all().map(r => r.name));
    // Old catalogs have no originator; local WorkStudio runtime refs still identify those calls.
    db.function("meter_key", id => meterKey(String(id)));
    db.function("ours", id => Number(studioRefs.has(String(id))));
    const ours = `ours(id)=1${cols.has("originator") ? " OR originator='amo-studio'" : ""}`;
    const edges = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get();
    // Subagents may omit the originator and need not have a corresponding WorkStudio session.
    const owned = `WITH RECURSIVE owned(id) AS (SELECT id FROM threads WHERE ${ours}${edges ? " UNION SELECT e.child_thread_id FROM thread_spawn_edges e JOIN owned ON e.parent_thread_id=owned.id" : ""})`;
    return db.prepare(`${owned} SELECT meter_key(id) AS key, tokens_used AS tokens, created_at*1000 AS start,
      updated_at*1000 AS end, id IN (SELECT id FROM owned) AS studio FROM threads WHERE tokens_used > 0`).all() as unknown as CodexMeter[];
  } finally { db.close(); }
}

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
async function localJson(file: string) {
  if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error("meter too large");
  return obj(JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")));
}
function claudeParts(input: unknown, creation: unknown, read: unknown, output: unknown): Parts {
  // Anthropic's four fields are disjoint; cache creation is input, not a cache hit.
  return { input: count(input) + count(creation), cached: count(read), output: count(output) };
}
/** Claude Code writes its last finished session's numeric receipt per project. Polling can miss intermediate
 * sessions and a resumed session can publish the same receipt twice. Never walk projects/ or load transcripts.
 * Only these fields leave this projection; not even the project names, auth info or original session ID leave it. */
export async function claudeReceipts(file: string): Promise<ClaudeReceipt[]> {
  const { projects } = await localJson(file);
  const result: ClaudeReceipt[] = [];
  for (const entry of Object.values(obj(projects))) {
    const p = obj(entry);
    if (typeof p.lastSessionId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(p.lastSessionId)) continue;
    const parts = claudeParts(p.lastTotalInputTokens, p.lastTotalCacheCreationInputTokens, p.lastTotalCacheReadInputTokens, p.lastTotalOutputTokens);
    if (!total(parts)) continue;
    const start = count(p.lastStartTime), duration = count(p.lastDuration);
    const day = start && typeof p.lastDuration === "number" && localDate(start) === localDate(start + duration) ? localDate(start) : null;
    result.push({ key: meterKey(p.lastSessionId), date: day || "", ...parts });
  }
  return result;
}
/** Claude Code's /stats cache is local, cumulative and can include Studio's Claude sessions. dailyModelTokens in
 * different CLI versions omits token classes; never use it to apportion lifetime input/cache/output to dates. */
export async function claudeCache(dir: string): Promise<ClaudeCache> {
  const { lastComputedDate, modelUsage } = await localJson(join(dir, "stats-cache.json"));
  if (typeof lastComputedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(lastComputedDate) || !modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) throw new Error("unsupported cache");
  const parts = { input: 0, cached: 0, output: 0 };
  for (const entry of Object.values(modelUsage)) {
    const p = obj(entry);
    if (![p.inputTokens, p.outputTokens, p.cacheReadInputTokens, p.cacheCreationInputTokens].some(n => typeof n === "number")) throw new Error("unsupported cache");
    const n = claudeParts(p.inputTokens, p.cacheCreationInputTokens, p.cacheReadInputTokens, p.outputTokens);
    parts.input += n.input; parts.cached += n.cached; parts.output += n.output;
  }
  return { through: lastComputedDate, parts };
}
