import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

/** Host-token authenticated local UI only. No remote-copy forwarding and no archive download endpoint. */
export function companyRoutes(service: HostService): Route[] {
  return [
    route("GET /api/company", () => service.company.snapshot()),
    route("POST /api/company/agents", ({ body }) => service.company.createAgent(body)),
    route("PUT /api/company/agents/:id", ({ params, body }) => service.company.updateAgent(params.id, body)),
    route("POST /api/company/rooms", ({ body }) => service.company.createRoom(body)),
    route("PATCH /api/company/rooms/:id", ({ params, body }) => service.company.updateRoom(params.id, body)),
    route("GET /api/company/rooms/:id/messages", ({ params, query }) => service.company.messages(params.id, query.get("before") ?? undefined, query.get("limit") ?? 50)),
    route("POST /api/company/rooms/:id/messages", ({ params, body }) => service.company.send(params.id, body)),
    route("POST /api/company/rooms/:id/messages/:messageId/retry", ({ params, body }) => service.company.retry(params.id, params.messageId, obj(body).agentId, obj(body).confirmUnknown === true)),
  ];
}
