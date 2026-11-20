import { TOKEN_STATS_REFRESH_MS, type TokenSource, type TokenSourceReport, type TokenStats, type TokenStatsDay, type TokenStatsModel } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { claudeCache, claudeReceipts, codexMeters, count, localDate, meterKey, total, type ClaudeCache, type Parts } from "./meters.js";
import { reconcileClaude, reconcileCodex } from "./ledger.js";

export { localDate } from "./meters.js";
const zero = { input: 0, cached: 0, output: 0 };
type Report = Omit<TokenSourceReport, "total">;

export class StatsFeature extends Feature {
  private snapshot?: TokenStats;
  private pending?: Promise<TokenStats>;
  private timer?: ReturnType<typeof setInterval>;

  startSampling(): void {
    if (!this.options.meterPaths || this.timer) return;
    const sample = () => { void this.tokens(true).catch(() => this.log("本机 Token 统计暂未更新")); };
    this.timer = setInterval(sample, TOKEN_STATS_REFRESH_MS);
    this.timer.unref();
    sample();
  }

  async stopSampling(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending?.catch(() => {});
  }

  tokens(refresh = false): Promise<TokenStats> {
    if (this.pending) return this.pending;
    if (!refresh && this.snapshot && Date.now() - Date.parse(this.snapshot.generatedAt) < TOKEN_STATS_REFRESH_MS) return Promise.resolve(this.snapshot);
    this.pending = this.collect().then(result => this.snapshot = result).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async collect(): Promise<TokenStats> {
    const start = performance.now();
    const paths = this.options.meterPaths;
    const refs = (runtime: string) => new Set(this.store.db.prepare("SELECT runtime_ref FROM sessions WHERE runtime=? AND runtime_ref IS NOT NULL").all(runtime).map(r => String(r.runtime_ref)));
    const codex = refs("codex"), claude = refs("claude");
    const digest = (refs: Set<string>) => new Set([...refs].map(meterKey));
    const codexKeys = digest(codex), claudeKeys = digest(claude);
    // Read native snapshots BEFORE Studio turns: a new Studio turn counted during I/O can only reduce the difference.
    const [cm, cr, cc] = await Promise.allSettled(paths ? [
      codexMeters(paths.codex, codex), claudeReceipts(paths.claudeConfig), claudeCache(paths.claude),
    ] as const : [Promise.reject(), Promise.reject(), Promise.reject()] as const);
    const now = Date.now();
    const days = new Map<string, TokenStatsDay>(), models = new Map<string, TokenStatsModel>();
    const byRef = new Map<string, number>();
    const reports: Report[] = [];
    const add = (source: TokenSource, profileId: string, date: string, parts: Parts, unclassified = 0, turns = 0) => {
      if (!(total(parts) + unclassified)) return;
      const key = JSON.stringify([source, profileId, date]);
      const row = days.get(key) ?? { source, date, profileId, ...zero, unclassified: 0, turns: 0 };
      row.input += parts.input; row.cached += parts.cached; row.output += parts.output; row.unclassified += unclassified; row.turns += turns;
      days.set(key, row);
    };
    const nativeModel = (id: string, label: string, runtime: "claude" | "codex") => {
      models.set(id, { profileId: id, label, runtime, removed: false, model: null });
      return id;
    };
    // These are the live/archived turns executed here; remote task copies cannot contribute local traffic.
    const claudeKnown: Array<{ date: string; tokens: number }> = [];
    for (const t of this.store.listTurnUsage()) {
      const date = localDate(t.startedAt) ?? "", input = count(t.input), cached = Math.min(input, count(t.cached)), output = count(t.output);
      if (!input && !output) continue;
      add("studio", t.profileId, date, { input: input - cached, cached, output }, 0, 1);
      if (t.ref) {
        // Studio's Claude subagent refs share the parent CLI process and its project receipt.
        const ref = t.runtime === "claude" ? t.ref.split("/agent/", 1)[0]! : t.ref;
        const key = t.runtime + ":" + meterKey(ref);
        byRef.set(key, (byRef.get(key) ?? 0) + input + output);
      }
      // A shared Claude cache has no request IDs. Subtract potential overlaps conservatively, even if the profile
      // has since been removed. Known Studio-private provider directories need not be subtracted.
      if (t.runtime === "claude" && (t.profileId === "claude-subscription" || !this.profiles.some(p => p.id === t.profileId))) claudeKnown.push({ date, tokens: input + output });
    }
    for (const r of this.store.db.prepare("SELECT day,model,input,cached,output FROM studio_request_usage").all()) {
      const model = String(r.model), id = nativeModel("meter:translation:" + model, model + " · 翻译", "codex");
      add("studio", id, String(r.day), { input: count(r.input), cached: count(r.cached), output: count(r.output) });
    }
    reports.push({ source: "studio", status: "available", note: "本机回合及有用量回执的翻译。排除在其他设备执行的任务副本。" });

    const [codexSaved, claudeSaved] = this.store.transaction(() => [
      reconcileCodex(this.store.db, cm.status === "fulfilled" ? cm.value : [], codexKeys, now),
      reconcileClaude(this.store.db, cr.status === "fulfilled" ? cr.value : [], claudeKeys),
    ] as const);
    const cid = nativeModel("meter:codex", "Codex · 原生计数", "codex");
    for (const [key, m] of codexSaved) {
      if (m.studio || codexKeys.has(key) || byRef.has("codex:" + key)) {
        const rest = Math.max(0, m.tokens - (byRef.get("codex:" + key) ?? 0));
        add("studio", cid, Object.keys(m.days).length === 1 ? Object.keys(m.days)[0]! : "", zero, rest);
      } else {
        for (const [date, n] of Object.entries(m.days)) add("codex", cid, date, zero, n);
      }
    }
    reports.push({ source: "codex", status: cm.status === "fulfilled" ? "available" : codexSaved.size ? "partial" : "unavailable",
      note: cm.status === "fulfilled" ? "Codex 本地索引的累计 Token；匹配 WorkStudio 的会话及其子 Agent 后去重。原生索引没有输入、输出明细。" : codexSaved.size ? "本次未读到 Codex 索引，保留上次已记录的计数。" : "未读到兼容的 Codex 本地用量索引。" });

    const aid = nativeModel("meter:claude", "Claude Code · 本机回执", "claude");
    for (const [key, m] of claudeSaved) {
      if (m.studio || claudeKeys.has(key) || byRef.has("claude:" + key)) {
        const rest = Math.max(0, total(m) - (byRef.get("claude:" + key) ?? 0));
        add("studio", aid, m.date, zero, rest);
        if (rest) claudeKnown.push({ date: m.date, tokens: rest });
      } else {
        add("claude", aid, m.date, m);
        claudeKnown.push({ date: m.date, tokens: total(m) });
      }
    }
    reports.push({ source: "claude", status: claudeSaved.size ? "partial" : "unavailable", note: claudeSaved.size ? "各项目已留存的独立 Claude Code 用量回执；两次采集之间被覆盖的回执可能缺失。" : "未发现独立 Claude Code 的会话用量回执；这不代表没有使用。" });

    // /stats caches are lifetime snapshots, not increments. Do not add them to the receipt ledger. Only its
    // uncovered remainder is additive; without identities it is never presented as proven standalone use.
    const cacheRow = this.store.db.prepare("SELECT body FROM device_token_meters WHERE kind='claude-cache' AND meter='local'").get();
    let cache: ClaudeCache | undefined = cacheRow ? JSON.parse(String(cacheRow.body)) : undefined;
    if (cc.status === "fulfilled" && (!cache || (cc.value.through >= cache.through && total(cc.value.parts) >= total(cache.parts)))) {
      cache = cc.value;
      this.store.db.prepare("INSERT OR REPLACE INTO device_token_meters(kind,meter,body) VALUES ('claude-cache','local',?)").run(JSON.stringify(cache));
    }
    if (cache) {
      const through = cache.through;
      const overlap = claudeKnown.reduce((sum, x) => sum + (!x.date || x.date <= through ? x.tokens : 0), 0);
      const id = nativeModel("meter:claude-shared", "Claude Code · 本地汇总", "claude");
      if (overlap) add("claude-shared", id, "", zero, Math.max(0, total(cache.parts) - overlap));
      else add("claude-shared", id, "", cache.parts);
    }
    reports.push({ source: "claude-shared", status: cache ? "partial" : "unavailable", note: cache ?
      `Claude Code /stats 的本机缓存截至 ${cache.through}；扣除可能重叠的已知用量，仅将差额计入累计。无法确认启动客户端。${cc.status === "fulfilled" ? "" : " 本次未读到新缓存。"}` :
      "没有可用的本机汇总。可在 Claude Code 中打开 /stats，让它生成缓存后重新统计。" });
    const rows = [...days.values()].sort((a,b) => a.date.localeCompare(b.date) || a.profileId.localeCompare(b.profileId));
    const used = new Set(rows.map(r => r.profileId));
    for (const id of used) if (!models.has(id)) {
      const p = this.profiles.find(x => x.id === id);
      models.set(id, p ? { profileId: id, label: p.label, runtime: p.runtime, model: p.model, removed: false } : { profileId: id, label: id, runtime: null, model: null, removed: true });
    }
    const sources = reports.map(r => ({ ...r, total: rows.reduce((n,x) => n + (x.source === r.source ? total(x) + x.unclassified : 0), 0) }));
    return { generatedAt: new Date(now).toISOString(), ms: Math.round(performance.now() - start), total: sources.reduce((s,r) => s+r.total,0),
      turns: rows.reduce((s,d) => s+d.turns,0), days: rows, models: [...models.values()].filter(m => used.has(m.profileId)), sources };
  }
}
