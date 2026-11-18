import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { ModelProfile } from "@amo-studio/protocol";
import type { CodexProviderDef } from "../profiles.js";

export const LOCAL_CODEX_PROXY = "workstudio-opencodex";

/** Read routing metadata only; never open auth.json, native sessions or the proxy's credential store. */
export function localCodexProxy(home: string): CodexProviderDef | null {
  try {
    const file = join(home, "config.toml");
    if (statSync(file).size > 512 * 1024) return null;
    const values = new Map<string, string>();
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*(openai_base_url|model_catalog_json|model_provider|profile)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
      if (!m) continue;
      if (values.has(m[1]!)) return null;
      values.set(m[1]!, m[2]!.startsWith('"') ? JSON.parse(m[2]!) : m[2]!.slice(1, -1));
    }
    if (values.has("profile") || values.has("model_provider")) return null;
    const catalog = values.get("model_catalog_json"), address = values.get("openai_base_url");
    if (!catalog || !address || !/^opencodex-catalog\.json$/i.test(basename(catalog))) return null;
    const url = new URL(address);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") return null;
    return { name: "OpenCodex（本机代理）", baseUrl: url.href.replace(/\/$/, ""), wireApi: "responses", envKey: "", auth: "none", catalog: isAbsolute(catalog) ? catalog : join(home, catalog) };
  } catch { return null; }
}

/** The same default profile id keeps all existing WorkStudio chats; provider identity changes explicitly. */
export function profilesWithLocalProxy(profiles: readonly ModelProfile[], proxy: CodexProviderDef | null): readonly ModelProfile[] {
  return proxy ? profiles.map((p) => p.id === "codex-default" && p.runtime === "codex" && !p.provider ? { ...p, provider: LOCAL_CODEX_PROXY } : p) : profiles;
}
