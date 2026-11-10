import type { HostService } from "../../service.js";
import { route, type Route, obj, str } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function configRoutes(service: HostService): Route[] {
  return [
    route("GET /api/build-job", () => service.buildJob.state()),
    route("PUT /api/build-job", ({ body }) => { const b = obj(body); if (typeof b.enabled !== "boolean" || typeof b.username !== "string") throw new Error("打包配置参数无效"); return service.buildJob.configure({ username: b.username, ...(typeof b.token === "string" ? { token: b.token } : {}), enabled: b.enabled, clear: b.clear === true }); }),
    route("POST /api/build-job/run", () => service.buildJob.run()),
    route("POST /api/build-job/check", () => service.buildJob.check()),
    route("GET /api/cooperation", () => service.cooperation.state()),
    route("PUT /api/cooperation/own-devices", ({ body }) => { const b = obj(body); if (typeof b.enabled !== "boolean") throw new Error("开关参数无效"); return service.cooperation.syncOwn(b.enabled); }),
    route("POST /api/cooperation/account", ({ body }) => { const b = obj(body); return service.cooperation.account({ action: str(b.action, "action"), server: str(b.server, "server"), name: str(b.name, "name"), password: str(b.password, "password"), ...(typeof b.passphrase === "string" ? { passphrase: b.passphrase } : {}) }); }),
    route("POST /api/cooperation/logout", () => service.cooperation.logout()),
    route("POST /api/cooperation/off", () => service.cooperation.off()),
    route("PUT /api/cooperation/relay", ({ body }) => { const b = obj(body); if (typeof b.enabled !== "boolean") throw new Error("enabled 必须是布尔值"); return service.cooperation.relay(b.enabled); }),
    route("PUT /api/cooperation/server", ({ body }) => { const b = obj(body); if (typeof b.enabled !== "boolean" || (b.lan !== undefined && typeof b.lan !== "boolean")) throw new Error("开关参数无效"); return service.cooperation.setServer(b.enabled, b.lan === true); }),
    route("POST /api/cooperation/transfers/:id", ({ params, body }) => { const b = obj(body); if (typeof b.allow !== "boolean") throw new Error("allow 必须是布尔值"); return service.cooperation.answer(params.id!, b.allow); }),
    route("GET /api/settings", () => service.config.settings()),
    route("GET /api/usage", ({ query }) => service.config.usage(query.get("refresh") === "1")),
    route("PUT /api/settings", ({ body }) => service.config.updateSettings(obj(body))),
    route("GET /api/profiles/:id/choices", ({ params }) => service.config.choices(params.id!)),
    route("GET /api/credentials", () => service.config.credentials()),
    route("PUT /api/credentials/:id", ({ params, body }) => service.config.saveCredential(params.id!, obj(body).secret)),
    route("DELETE /api/credentials/:id", ({ params }) => service.config.removeCredential(params.id!)),
  ];
}
