export interface ToolDownload {
  id: string;
  title: string;
  version: string;
  versionCode: number;
  filename: string;
  bytes: number;
  sha256: string;
  publishedAt: string;
  notes: string;
}
export interface ToolDownloadsState {
  enabled: boolean;
  lan: boolean;
  running: boolean;
  port: number;
  urls: string[];
  items: ToolDownload[];
  error: string | null;
}
export interface ToolDownloadsRoutes {
  "GET /api/tool-downloads": { req: undefined; res: ToolDownloadsState };
  "PUT /api/tool-downloads": { req: { enabled: boolean; lan: boolean }; res: ToolDownloadsState };
}
