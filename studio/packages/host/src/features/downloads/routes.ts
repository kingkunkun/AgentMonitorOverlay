import type { HostService } from "../../service.js";
import { route, type Route } from "../../http/route.js";
export function downloadsRoutes(service: HostService): Route[] {
  return [route("GET /api/tool-downloads", () => service.downloads.snapshot()), route("PUT /api/tool-downloads", ({ body }) => service.downloads.configure(body))];
}
