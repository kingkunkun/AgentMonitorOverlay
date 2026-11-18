import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { localCodexProxy, LOCAL_CODEX_PROXY, profilesWithLocalProxy } from "./local-proxy.js";
import { BUILTIN_PROFILES, codexServerSpec, codexThreadParams } from "../profiles.js";
import { StaticCredentialReader } from "../credentials.js";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d); });
function home(config: string) { const dir = mkdtempSync(join(tmpdir(), "amo-studio-test-proxy-")); dirs.push(dir); writeFileSync(join(dir, "config.toml"), config); return dir; }
const catalog = 'model_catalog_json = "opencodex-catalog.json"\n';
it("adapts the already configured local OpenCodex gateway with explicit provider and no ChatGPT credential", () => {
  const dir = home(catalog + 'openai_base_url = "http://127.0.0.1:10100/v1"\n[mcp_servers.unrelated]\ncommand="never-run"');
  const proxy = localCodexProxy(dir)!; expect(proxy).toMatchObject({ baseUrl: "http://127.0.0.1:10100/v1", auth: "none", catalog: join(dir, "opencodex-catalog.json") });
  const profiles = profilesWithLocalProxy(BUILTIN_PROFILES, proxy), profile = profiles.find((p) => p.id === "codex-default")!;
  expect(codexThreadParams(profile)).toMatchObject({ modelProvider: LOCAL_CODEX_PROXY });
  const spec = codexServerSpec(profile, profiles, new StaticCredentialReader({}), { providers: { [LOCAL_CODEX_PROXY]: proxy } });
  expect(spec.configArgs).toContain(`model_providers.${LOCAL_CODEX_PROXY}.requires_openai_auth=false`);
  expect(spec.configArgs.some((a) => a.includes(".env_key="))).toBe(false); expect(spec.env).toEqual({});
  expect(profiles.filter((p) => p.id !== "codex-default")).toEqual(BUILTIN_PROFILES.filter((p) => p.id !== "codex-default"));
  const noCredentials = codexServerSpec({ ...profile, credentialId: "must-not-read" }, profiles, { read() { throw new Error("credential read"); } }, { providers: { [LOCAL_CODEX_PROXY]: proxy } });
  expect(noCredentials.env).toEqual({});
});
it("never auto-routes to remote, credential-bearing or ambiguous addresses, or replaces an explicit provider/profile", () => {
  for (const url of ["https://outside.invalid/v1", "http://172.16.1.2:10100/v1", "http://127.0.0.1:10100/v1?key=private", "http://user:pass@127.0.0.1:10100/v1", "http://localhost:10100/other"]) expect(localCodexProxy(home(catalog + `openai_base_url = ${JSON.stringify(url)}\n`))).toBeNull();
  for (const extra of ['model_provider="custom"\n', 'model_provider="openai"\n', 'profile="custom"\n', 'openai_base_url="http://localhost:9999/v1"\n']) expect(localCodexProxy(home(catalog + 'openai_base_url="http://localhost:10100/v1"\n' + extra))).toBeNull();
  expect(localCodexProxy(home('model="gpt-model"\n'))).toBeNull();
});
