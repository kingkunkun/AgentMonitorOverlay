import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { networkInterfaces } from "node:os";
import type { ToolDownload } from "@amo-studio/protocol";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A separate, read-only listener. Only content-addressed APKs in the explicit catalog are public. */
export class ToolDownloadServer {
  private server: Server | null = null;
  private verified = new Map<string, string>();
  port = 47951;
  lan = false;
  constructor(readonly root: string) {}
  get running() { return this.server !== null; }
  urls(): string[] {
    if (!this.running) return [];
    const interfaces = Object.entries(networkInterfaces()).sort(([a], [b]) => Number(/vethernet|virtual|wsl|docker/i.test(a)) - Number(/vethernet|virtual|wsl|docker/i.test(b)));
    const hosts = ["127.0.0.1", ...(this.lan ? interfaces.flatMap(([, v]) => (v ?? []).filter((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")).map((a) => a.address)) : [])];
    return [...new Set(hosts)].map((host) => `http://${host}:${this.port}/`);
  }
  private file(item: ToolDownload): string {
    const base = realpathSync(join(this.root, "files"));
    if (dirname(base) !== realpathSync(this.root)) throw new Error("安装包目录无效");
    const file = realpathSync(join(base, `${item.sha256}.apk`));
    if (dirname(file) !== base) throw new Error("安装包路径无效");
    return file;
  }
  async catalog(): Promise<ToolDownload[]> {
    const manifest = join(this.root, "catalog.json");
    if (!existsSync(manifest)) return [];
    const raw: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (!Array.isArray(raw) || raw.length > 20) throw new Error("安装包清单无效");
    const items: ToolDownload[] = [];
    const ids = new Set<string>();
    for (const row of raw) {
      const a = row as ToolDownload;
      if (!a || !/^[a-z0-9-]{1,64}$/.test(a.id) || ids.has(a.id) || !/^[a-f0-9]{64}$/.test(a.sha256) || !/^[a-zA-Z0-9._-]+\.apk$/.test(a.filename) || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || !Number.isSafeInteger(a.versionCode) || ![a.title, a.version, a.publishedAt, a.notes].every((s) => typeof s === "string" && s.length <= 4000)) throw new Error("安装包清单无效");
      ids.add(a.id);
      const file = this.file(a), stat = statSync(file);
      if (!stat.isFile() || stat.size !== a.bytes) throw new Error("安装包大小不匹配");
      const key = `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (this.verified.get(a.id) !== key) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        if (hash.digest("hex") !== a.sha256) throw new Error("安装包校验失败");
        this.verified.set(a.id, key);
      }
      items.push({ id: a.id, title: a.title, version: a.version, versionCode: a.versionCode, filename: a.filename, bytes: a.bytes, sha256: a.sha256, publishedAt: a.publishedAt, notes: a.notes });
    }
    return items;
  }
  async start(lan: boolean, port = 47951): Promise<void> {
    await this.close();
    const server = createServer(async (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
      try {
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path !== "/" && path !== "/api/catalog" && !/^\/files\/[a-z0-9-]{1,64}$/.test(path)) { res.writeHead(404).end(); return; }
        const items = await this.catalog();
        if (path === "/" || path === "/api/catalog") {
          const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorkStudio 工具下载</title><style>body{font:16px system-ui;background:#f6f5f3;color:#262626;max-width:760px;margin:48px auto;padding:0 24px}article{background:white;border:1px solid #e5e3df;border-radius:16px;padding:24px;margin:20px 0}p{line-height:1.7;white-space:pre-wrap}small{color:#777;overflow-wrap:anywhere}a{display:inline-block;background:#202020;color:white;text-decoration:none;padding:12px 20px;border-radius:9px}</style><h1>工具下载</h1><p>WorkStudio 手机工作台与工具安装包</p>${items.length ? items.map((a) => `<article><h2>${escape(a.title)}</h2><p>${escape(a.version)} · ${(a.bytes / 1048576).toFixed(1)} MB · ${escape(a.publishedAt.slice(0, 10))}</p><p>${escape(a.notes)}</p><a href="/files/${a.id}">下载 Android APK</a><p><small>SHA-256: ${a.sha256}</small></p></article>`).join("") : "<p>还没有发布安装包。</p>"}<p><small>手机和电脑需处于同一局域网。安装包下载不需要工作台账号，连接工作台仍需手机账号登录。</small></p></html>`;
          const payload = path === "/" ? html : JSON.stringify(items);
          res.writeHead(200, { "Content-Type": path === "/" ? "text/html; charset=utf-8" : "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(payload) });
          res.end(req.method === "HEAD" ? undefined : payload); return;
        }
        const item = items.find((a) => path === `/files/${a.id}`);
        if (!item) { res.writeHead(404).end(); return; }
        let start = 0, end = item.bytes - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) { res.writeHead(416, { "Content-Range": `bytes */${item.bytes}` }).end(); return; }
          start = match[1] ? Number(match[1]) : Math.max(0, item.bytes - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (!Number.isSafeInteger(start) || start > end || start < 0) { res.writeHead(416, { "Content-Range": `bytes */${item.bytes}` }).end(); return; }
        }
        res.writeHead(req.headers.range ? 206 : 200, { "Content-Type": "application/vnd.android.package-archive", "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Content-Disposition": `attachment; filename="${item.filename}"`, "ETag": `"${item.sha256}"`, ...(req.headers.range ? { "Content-Range": `bytes ${start}-${end}/${item.bytes}` } : {}) });
        if (req.method === "HEAD") { res.end(); return; }
        const stream = createReadStream(this.file(item), { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      } catch { if (!res.headersSent) res.writeHead(503).end("安装包暂不可用"); else res.destroy(); }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    this.server = server; this.lan = lan;
    this.port = (server.address() as { port: number }).port;
  }
  async close(): Promise<void> {
    const server = this.server; this.server = null;
    if (server) await new Promise<void>((resolve) => {
      const limit = setTimeout(() => server.closeAllConnections(), 5000).unref();
      server.close(() => { clearTimeout(limit); resolve(); }); server.closeIdleConnections();
    });
  }
}
