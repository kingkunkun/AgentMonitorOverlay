import type { TokenSource } from "./api.js";

export const TOKEN_STATS_REFRESH_MS = 30 * 60_000;
export const TOKEN_SOURCE_LABELS: Record<TokenSource, string> = {
  studio: "WorkStudio", codex: "独立 Codex", claude: "独立 Claude Code", "claude-shared": "Claude · 来源未分",
};
/** Equal versions keep the catalog's order (or the user's order of variants). Never change the selected model ID. */
export function compareModelVersions(a: { id: string }, b: { id: string }): number {
  const parts = (id: string) => {
    const slug = id.toLowerCase().split("/").at(-1) ?? "";
    const m = /^gpt[- ]?(\d+(?:\.\d+)*)\b/.exec(slug) ?? /^(?:claude-)?(?:opus|sonnet|haiku|fable)[- ](\d+(?:[.-]\d{1,3}\b)*)/.exec(slug);
    return m?.[1]?.split(/[.-]/).map(Number);
  };
  const x = parts(a.id), y = parts(b.id);
  if (!x || !y) return Number(!!y) - Number(!!x);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (y[i] ?? 0) - (x[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}
