import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolDownloadsState } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";
import { ToolDownloadServer } from "./server.js";

export class DownloadsFeature extends Feature {
  private listener: ToolDownloadServer | null = null;
  private error: string | null = null;
  private changing = false;
  private get root() { return join(dirname(this.store.path), "tool-downloads"); }
  private config() {
    try { const a = JSON.parse(readFileSync(join(this.root, "settings.json"), "utf8")); return { enabled: a.enabled === true, lan: a.lan === true }; }
    catch { return { enabled: false, lan: false }; }
  }
  async snapshot(): Promise<ToolDownloadsState> {
    const c = this.config();
    const server = this.listener ?? new ToolDownloadServer(this.root);
    let items: ToolDownloadsState["items"] = [], error = this.error;
    try { items = await server.catalog(); } catch (e) { error = String(e); }
    return { ...c, running: server.running, port: server.port, urls: server.urls(), items, error };
  }
  async startDefault() {
    const c = this.config();
    if (!c.enabled) return;
    this.listener ??= new ToolDownloadServer(this.root);
    try { await this.listener.start(c.lan); this.error = null; }
    catch (e) { this.error = String(e); this.log(`工具下载服务未启动: ${this.error}`); }
  }
  async configure(value: unknown): Promise<ToolDownloadsState> {
    const v = value as { enabled?: unknown; lan?: unknown } | null;
    if (!v || typeof v.enabled !== "boolean" || typeof v.lan !== "boolean") throw new HostError("bad_request", "下载服务开关无效");
    if (this.changing) throw new HostError("conflict", "正在切换下载服务，请稍后重试");
    this.changing = true;
    try {
      await this.close();
      mkdirSync(this.root, { recursive: true });
      writeFileSync(join(this.root, "settings.json.tmp"), JSON.stringify({ enabled: v.enabled, lan: v.lan }));
      renameSync(join(this.root, "settings.json.tmp"), join(this.root, "settings.json"));
      this.error = null;
      await this.startDefault();
      return await this.snapshot();
    } finally { this.changing = false; }
  }
  async close() { await this.listener?.close(); }
}
