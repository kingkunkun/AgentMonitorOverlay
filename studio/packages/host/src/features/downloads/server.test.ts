import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ToolDownloadServer } from "./server.js";
const roots: string[] = [], servers: ToolDownloadServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amo-downloads-")); roots.push(root);
  mkdirSync(join(root, "files"));
  const data = Buffer.from("verified-apk-fixture"); const sha256 = createHash("sha256").update(data).digest("hex");
  const item = { id: "phone-workstudio", title: "<script>bad</script>", version: "0.2.3", versionCode: 7, filename: "WorkStudio-Mobile-0.2.3.apk", bytes: data.length, sha256, publishedAt: "2026-11-13", notes: "phone" };
  writeFileSync(join(root, "files", `${sha256}.apk`), data); writeFileSync(join(root, "catalog.json"), JSON.stringify([item]));
  const server = new ToolDownloadServer(root); servers.push(server);
  return { root, data, item, server };
}
it("serves only cataloged APKs, supports HEAD/ranges and escapes the public landing", async () => {
  const { server, data } = fixture(); await server.start(false, 47976);
  const base = `http://127.0.0.1:${server.port}`;
  const html = await (await fetch(base)).text(); expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
  const head = await fetch(`${base}/files/phone-workstudio`, { method: "HEAD" }); expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(data.length)); expect(await head.text()).toBe("");
  const part = await fetch(`${base}/files/phone-workstudio`, { headers: { Range: "bytes=2-5" } }); expect(part.status).toBe(206); expect(await part.text()).toBe(data.subarray(2, 6).toString());
  const suffix = await fetch(`${base}/files/phone-workstudio`, { headers: { Range: "bytes=-4" } }); expect(await suffix.text()).toBe(data.subarray(-4).toString());
  expect((await fetch(`${base}/files/phone-workstudio`, { headers: { Range: "bytes=999-" } })).status).toBe(416);
  for (const path of ["/files/unknown", "/settings.json", "/studio.db", "/files/%2e%2e%2fsettings.json"]) expect((await fetch(base + path)).status).toBe(404);
  expect((await fetch(base, { method: "POST", body: "x" })).status).toBe(405);
  const catalog = await (await fetch(base + "/api/catalog")).text(); expect(catalog).not.toContain(server.root);
});
it("refuses changed or malformed packages instead of publishing unverified bytes", async () => {
  const { server, root, item } = fixture(); await server.catalog();
  writeFileSync(join(root, "files", `${item.sha256}.apk`), Buffer.alloc(item.bytes, 88));
  await expect(server.catalog()).rejects.toThrow("校验失败");
  writeFileSync(join(root, "catalog.json"), JSON.stringify([{ ...item, sha256: "../studio.db" }]));
  await expect(server.catalog()).rejects.toThrow("清单无效");
});
it("rejects file symlinks outside the published directory", async () => {
  const { server, root, item } = fixture(); const target = join(root, "files", `${item.sha256}.apk`);
  const external = join(root, "private.apk"); writeFileSync(external, "private"); rmSync(target); symlinkSync(external, target);
  await expect(server.catalog()).rejects.toThrow("路径无效");
});
