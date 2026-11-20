import type { DatabaseSync } from "node:sqlite";
import { count, localDate, total, type ClaudeReceipt, type CodexMeter } from "./meters.js";

interface Snapshot { tokens: number; sampled: number; days: Record<string, number>; studio: boolean }
export interface Receipt extends ClaudeReceipt { studio: boolean }

/** A device counter persists across refreshes, Host restarts, and native pruning. Never store native IDs or paths.
 * A smaller counter may be a reset or compaction; do not replay the baseline as new consumption. */
export function reconcileCodex(db: DatabaseSync, meters: CodexMeter[], owned: Set<string>, now: number) {
  const saved = readMeters<Snapshot>(db, "codex");
  const put = writer(db, "codex");
  for (const m of meters) {
    const prev = saved.get(m.key);
    const tokens = count(m.tokens);
    if (!tokens) continue;
    const s = prev ?? { tokens: 0, sampled: 0, days: {}, studio: false };
    const diff = Math.max(0, tokens - s.tokens);
    const from = Math.max(m.start, s.sampled);
    // A first multi-day balance or a gap across midnight has no day. Do not charge it all to updated_at.
    if (diff) {
      const end = Math.min(m.end, now);
      const day = from > 0 && end >= from && localDate(from) === localDate(end) ? localDate(end)! : "";
      s.days[day] = (s.days[day] ?? 0) + diff;
      s.tokens = tokens;
    }
    s.sampled = now;
    s.studio ||= !!m.studio || owned.has(m.key);
    saved.set(m.key, s);
    put(m.key, s);
  }
  return saved;
}

export function reconcileClaude(db: DatabaseSync, receipts: ClaudeReceipt[], owned: Set<string>) {
  const saved = readMeters<Receipt>(db, "claude"), put = writer(db, "claude");
  for (const r of receipts) {
    const prev = saved.get(r.key);
    const next = prev && total(prev) >= total(r) ? prev : { ...r, date: prev && prev.date !== r.date ? "" : r.date, studio: false };
    next.studio ||= !!prev?.studio || owned.has(r.key);
    saved.set(r.key, next);
    put(r.key, next);
  }
  return saved;
}
function readMeters<T>(db: DatabaseSync, kind: string) {
  return new Map(db.prepare("SELECT meter,body FROM device_token_meters WHERE kind=?").all(kind).map(r => [String(r.meter), JSON.parse(String(r.body)) as T]));
}
function writer(db: DatabaseSync, kind: string) {
  const put = db.prepare("INSERT INTO device_token_meters(kind,meter,body) VALUES (?,?,?) ON CONFLICT(kind,meter) DO UPDATE SET body=excluded.body");
  return (key: string, value: unknown) => put.run(kind, key, JSON.stringify(value));
}
