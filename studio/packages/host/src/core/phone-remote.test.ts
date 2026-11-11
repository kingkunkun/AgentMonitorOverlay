import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { saveAccount, type Protector } from "@amo-studio/account";
import { removeTempDir } from "@amo-studio/testkit";
import { RelayStore, startRelayServer, type RelayServer } from "@amo-studio/relay";
import type { RemoteTaskSnapshot } from "@amo-studio/protocol";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { CodexRuntime } from "../runtime/codex/codex-runtime.js";
import { FakeServers } from "../runtime/codex/fake-servers.test-support.js";
import { Cooperation } from "./cooperation.js";
import { DeviceLink } from "../features/remote/link.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of clean.splice(0).reverse()) await run(); });
const protector: Protector = { protect: async (x) => Buffer.from(x).toString("base64"), unprotect: async (x) => Buffer.from(x, "base64").toString() };
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "amo-phone-remote-")), env = { AMO_HOME: join(root, "amo") };
  const store = new Store(join(root, "studio.db"));
  const profiles = [{ id: "p", label: "本机模型", runtime: "codex" as const, provider: "x", model: "m" }];
  const servers = new FakeServers(profiles), runtime = new CodexRuntime({ store, servers, profiles }), host = new HostService(store, runtime, profiles);
  const cooperation = new Cooperation(host, 0); Object.defineProperty(host, "cooperation", { value: cooperation });
  const teamStore = new RelayStore(join(root, "team.db")), team = await startRelayServer({ store: teamStore, host: "127.0.0.1", port: 0 });
  const user = teamStore.register("same-name", "team-password-123");
  await saveAccount({ server: team.url, name: user.name, key: user.key }, { env, protector });
  host.teamLink.start({ env, protector }); host.remote.start({ env, protector }); await host.teamLink.settled();
  clean.push(async () => { await cooperation.stop(); host.teamRelay.stop(); host.remote.stop(); host.teamLink.stop(); await team.close(); teamStore.close(); await servers.close(); store.close(); removeTempDir(root); });
  mkdirSync(join(root, "project")); const workspace = store.addWorkspace({ name: "测试项目", path: join(root, "project") });
  const { task, session } = await host.tasks.createTask({ title: "已有本机聊天", workspaceId: workspace.id, firstSession: { profileId: "p" } });
  store.appendItem({ id: "chat-text", sessionId: session!.id, type: "agent", markdown: "手机应该看到的本机聊天", streaming: false, createdAt: new Date().toISOString() });
  return { host, cooperation, runtime, store, task, session: session!, team, teamKey: user.key };
}
async function until<T>(get: () => Promise<T>, match: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 6000;
  while (true) { const v = await get(); if (match(v)) return v; if (Date.now() > end) throw new Error("phone condition timed out"); await new Promise((r) => setTimeout(r, 20)); }
}
async function phone(cooperation: Cooperation, name: string) {
  const base = cooperation.state().server.addresses[0]!;
  const post = async (path: string, body: unknown, key?: string) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const login = await post("/api/login", { name, password: "phone-password-123" }); expect(login.status).toBe(200);
  const key = login.body.key as string, device = "d_test_" + name;
  const online = await until(async () => (await fetch(base + "/api/devices/online?device=" + device, { headers: { authorization: "Bearer " + key } })).json() as Promise<{ devices: Array<{ device: string }> }>, (x) => x.devices.length > 0);
  const peer = { account: name, device: online.devices[0]!.device };
  const link = new DeviceLink({ server: base, key, device: { id: device, name: "测试手机" } }); link.start();
  clean.push(async () => link.stop());
  await until(async () => link.state, (s) => s === "online");
  expect((await post("/api/devices/pair", { device, deviceName: "测试手机", to: name, toDevice: peer.device }, key)).status).toBe(200);
  await until(async () => (await fetch(base + "/api/devices/pairs?device=" + device, { headers: { authorization: "Bearer " + key } })).json() as Promise<{ pairs: unknown[] }>, (x) => x.pairs.length === 1);
  const ask = async (kind: string, body: unknown = {}) => {
    const r = await link.request(peer, kind, body); if (r.kind === "error") throw new Error(JSON.stringify(r.body)); return r.body as any;
  };
  return { base, key, link, peer, post, ask };
}

it("phone accounts are independent of the signed-in team account; chat/options/presets/send work with team remote off", async () => {
  const { host, cooperation, runtime, task, session, teamKey } = await setup();
  cooperation.createPhoneAccount({ name: "same-name", password: "phone-password-123" });
  await cooperation.setServer(true);
  const client = await phone(cooperation, "same-name");
  expect(cooperation.state()).toMatchObject({ account: { name: "same-name" }, remoteEnabled: false, server: { running: true } });
  const denied = await fetch(client.base + "/api/devices/online?device=d_test_invalid", { headers: { authorization: "Bearer " + teamKey } }); expect(denied.status).toBe(401);
  expect((await client.post("/api/register", { name: "outside", password: "outside-password-123" })).status).toBe(403);
  expect((await client.ask("rt.list")).tasks).toContainEqual(expect.objectContaining({ taskId: task.id }));
  expect((await client.ask("rt.items", { sessionId: session.id })).items).toContainEqual(expect.objectContaining({ markdown: "手机应该看到的本机聊天" }));
  expect((await client.ask("rt.presets", { sessionId: session.id })).presets).toHaveLength(2);
  expect((await client.ask("rt.choices", { sessionId: session.id, all: true })).profiles).toContainEqual(expect.objectContaining({ profileId: "p" }));
  await client.ask("rt.options", { sessionId: session.id, options: { effort: "high", permission: "full-auto", fast: true } });
  expect(host.store.getSession(session.id)?.options).toMatchObject({ effort: "high", permission: "full-auto", fast: true });
  const send = vi.spyOn(runtime, "sendMessage").mockResolvedValue({ mode: "start" });
  await client.ask("rt.send", { sessionId: session.id, text: "从手机继续", uploads: [] }); expect(send.mock.calls[0]![1]).toContain("从手机继续");
  const teamAccount = host.teamLink.account;
  await host.remote.setEnabled(true); await host.remote.setEnabled(false);
  expect((await client.ask("rt.task", { taskId: task.id }) as RemoteTaskSnapshot).sessions).toContainEqual(expect.objectContaining({ id: session.id }));
  await cooperation.logout(); expect(host.teamLink.account).toBeNull();
  expect((await client.ask("rt.list")).tasks).toHaveLength(1);
  expect(teamAccount?.key).toBe(teamKey);
  expect(host.store.getKv("remote.grants")).toBeUndefined();
});

it("team inbox becomes a non-running chat and reaches only selected phone accounts; routing revokes immediately", async () => {
  const { cooperation, host, runtime } = await setup();
  cooperation.createPhoneAccount({ name: "selected", password: "phone-password-123", forwardTeamInbox: true });
  cooperation.createPhoneAccount({ name: "ordinary", password: "phone-password-123" });
  await cooperation.setServer(true);
  const selected = await phone(cooperation, "selected"), ordinary = await phone(cooperation, "ordinary");
  cooperation.relay(true);
  const send = vi.spyOn(runtime, "sendMessage").mockResolvedValue({ mode: "start" });
  await cooperation.mirrorInbox("thread-one", "同事", 1, "请查看这条团队消息");
  const inbox = host.store.listTasks().find((t) => t.title.startsWith("中转 ·"))!;
  expect(send).not.toHaveBeenCalled();
  expect((await selected.ask("rt.list")).tasks).toContainEqual(expect.objectContaining({ taskId: inbox.id }));
  expect((await ordinary.ask("rt.list")).tasks).not.toContainEqual(expect.objectContaining({ taskId: inbox.id }));
  const s = host.store.listSessions({ taskId: inbox.id })[0]!;
  expect((await selected.ask("rt.items", { sessionId: s.id })).items).toContainEqual(expect.objectContaining({ message: expect.stringContaining("请查看这条团队消息") }));
  await selected.ask("rt.send", { sessionId: s.id, text: "接管并分析", uploads: [] }); expect(send.mock.calls[0]![1]).toContain("请查看这条团队消息");
  cooperation.updatePhoneAccount("selected", { forwardTeamInbox: false });
  await expect(selected.ask("rt.task", { taskId: inbox.id })).rejects.toThrow();
});

it("reset, disable, delete, server-off and restart revoke old sessions without deleting desktop chats or team login", async () => {
  const { cooperation, host, session, task } = await setup();
  cooperation.createPhoneAccount({ name: "never-started", password: "phone-password-123" });
  cooperation.deletePhoneAccount("never-started");
  expect(cooperation.state().server.accounts).toEqual([]);
  cooperation.createPhoneAccount({ name: "owner", password: "phone-password-123" }); await cooperation.setServer(true);
  const client = await phone(cooperation, "owner");
  cooperation.updatePhoneAccount("owner", { password: "phone-password-new-123" });
  expect((await client.post("/api/login", { name: "owner", password: "phone-password-123" })).status).toBe(401);
  expect((await fetch(client.base + "/api/devices/pairs?device=d_test_owner", { headers: { authorization: "Bearer " + client.key } })).status).toBe(401);
  cooperation.updatePhoneAccount("owner", { enabled: false });
  expect((await client.post("/api/login", { name: "owner", password: "phone-password-new-123" })).status).toBe(403);
  cooperation.deletePhoneAccount("owner"); expect(cooperation.state().server.accounts).toEqual([]);
  expect((await client.post("/api/login", { name: "owner", password: "phone-password-new-123" })).status).toBe(401);
  expect(host.store.getTask(task.id)).toBeDefined(); expect(host.store.getSession(session.id)).toBeDefined();
  await cooperation.setServer(false); expect(cooperation.state().server.running).toBe(false); expect(cooperation.state().account?.name).toBe("same-name");
  await cooperation.setServer(true); expect(cooperation.state().server.accounts).toEqual([]);
});

it("full-access phones still cannot import native history or export local files without fresh computer confirmation", async () => {
  const { cooperation, host, store, task, session } = await setup();
  const imported = await host.tasks.createTask({ title: "旧原生导入", firstSession: { profileId: "p" } });
  store.setKv("claude-adopted:legacy-native", imported.session!.id);
  cooperation.createPhoneAccount({ name: "owner", password: "phone-password-123" }); await cooperation.setServer(true);
  const client = await phone(cooperation, "owner");
  expect((await client.ask("rt.list")).tasks).not.toContainEqual(expect.objectContaining({ taskId: imported.task.id }));
  await expect(client.ask("rt.items", { sessionId: imported.session!.id })).rejects.toThrow();
  await client.ask("rt.options", { sessionId: session.id, options: { permission: "full-auto" } });
  const file = join(store.getWorkspace(task.workspaceId)!.path, "private-test.txt"); writeFileSync(file, "only-after-confirmation");
  const denied = client.ask("rt.file", { taskId: task.id, path: file, offset: 0 }).catch((e) => e);
  await until(async () => cooperation.state().transfers, (t) => t.length === 1);
  cooperation.answer(cooperation.state().transfers[0]!.id, false);
  expect(await denied).toBeInstanceOf(Error);
  const allowed = client.ask("rt.file", { taskId: task.id, path: file, offset: 0 });
  await until(async () => cooperation.state().transfers, (t) => t.length === 1);
  cooperation.answer(cooperation.state().transfers[0]!.id, true);
  expect((await allowed).data).toBe(Buffer.from("only-after-confirmation").toString("base64"));
  const afterOff = client.ask("rt.file", { taskId: task.id, path: file, offset: 0 }).catch((e) => e);
  await until(async () => cooperation.state().transfers, (t) => t.length === 1);
  cooperation.updatePhoneAccount("owner", { enabled: false });
  cooperation.answer(cooperation.state().transfers[0]!.id, true);
  expect(await afterOff).toBeInstanceOf(Error);
});

it("a busy phone port cannot prevent the desktop from starting or shutting down normally", async () => {
  const { host, cooperation, task } = await setup();
  const occupiedDb = new RelayStore(":memory:"), occupied = await startRelayServer({ store: occupiedDb, host: "127.0.0.1", port: 0 });
  const blocked = new Cooperation(host, occupied.port);
  clean.push(async () => { await blocked.stop(); await occupied.close(); occupiedDb.close(); });
  await expect(blocked.setServer(true)).rejects.toThrow();
  expect(blocked.state().server).toMatchObject({ running: false, error: expect.stringContaining("EADDRINUSE") });
  await expect(blocked.startDefault()).resolves.toBeUndefined();
  expect(host.store.getTask(task.id)).toBeDefined();
  expect(cooperation.state().account?.name).toBe("same-name");
  await expect(blocked.stop()).resolves.toBeUndefined();
});

it("archived chats are absent from lists/snapshots, direct reads and subsequent content pushes", async () => {
  const { cooperation, host, store, task, session } = await setup();
  const old = await host.tasks.createTask({ title: "归档私密任务", firstSession: { profileId: "p" } });
  store.updateTask(old.task.id, { archivedAt: new Date().toISOString() });
  const archived = store.createSession({ ...session, id: "archived-session", title: "归档私密分支", runtimeRef: null });
  store.archiveSubtree(archived.id);
  cooperation.createPhoneAccount({ name: "owner", password: "phone-password-123" }); await cooperation.setServer(true);
  const client = await phone(cooperation, "owner");
  expect((await client.ask("rt.list")).tasks.map((t: { taskId: string }) => t.taskId)).toEqual([task.id]);
  expect((await client.ask("rt.task", { taskId: task.id })).sessions.map((s: { id: string }) => s.id)).toEqual([session.id]);
  await expect(client.ask("rt.items", { sessionId: archived.id })).rejects.toThrow();
  await expect(client.ask("rt.task", { taskId: old.task.id })).rejects.toThrow();
  const frames: unknown[] = []; client.link.on("event", (e) => { if (e.type === "relay") frames.push(e.body); });
  const row = store.archiveSubtree(session.id)[0]!;
  host.emit("event", { seq: 98, type: "session.upserted", session: row });
  host.emit("event", { seq: 99, type: "item.appended", item: { id: "secret", sessionId: session.id, type: "agent", markdown: "never-push-this-content", streaming: false, createdAt: new Date().toISOString(), seq: 99 } });
  await until(async () => (await client.ask("rt.list")).tasks, (tasks) => tasks.length === 0);
  await expect(client.ask("rt.items", { sessionId: session.id })).rejects.toThrow();
  expect(JSON.stringify(frames)).not.toContain("never-push-this-content");
  expect(store.getSession(archived.id)).toBeDefined(); expect(store.getTask(old.task.id)).toBeDefined();
});
