import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { updateCooperation } from "@amo-studio/account";
import { BUILD_JOB_URL, BUILD_JOBS } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "../store/store.js";
import type { HostService } from "../service.js";
import { BuildJob, isBuildCommand } from "./build-job.js";
import { ChatPresets } from "./chat-presets.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of clean.splice(0)) await run(); });
type Relay = ConstructorParameters<typeof BuildJob>[2];
function setup(request: typeof fetch, relay?: Relay) {
  const root = mkdtempSync(join(tmpdir(), "amo-build-job-"));
  const store = new Store(join(root, "studio.db"));
  const secrets = new Map<string, string>();
  const host = { store, options: { credentials: { read: (id: string) => secrets.get(id) ?? null, write: (id: string, secret: string) => secrets.set(id, secret), remove: (id: string) => secrets.delete(id) } }, publish: vi.fn(), cooperation: { taskAllowed: () => true } } as unknown as HostService;
  Object.assign(host, { chatPresets: new ChatPresets(host), sessions: { inbox: { put: vi.fn().mockResolvedValue({ delivered: true, waiting: 0 }) } } });
  const job = new BuildJob(host, request, relay);
  clean.push(async () => { await job.stop(); store.close(); removeTempDir(root); });
  return { job, store, secrets, host, root };
}
/** Jenkins without CSRF protection: the crumb issuer is absent. */
const noCrumb = () => new Response(null, { status: 404 });
const CRUMB = "http://172.16.8.85:8080/crumbIssuer/api/json";

it("only posts the fixed job once, tracks its own queue/build and keeps credentials out of state", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(noCrumb())
    .mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/12/" } }))
    .mockResolvedValueOnce(Response.json({ executable: { url: `${BUILD_JOB_URL}100/` } }))
    .mockResolvedValueOnce(Response.json({ building: false, result: "SUCCESS" }));
  const { job, store } = setup(request);
  await expect(job.run()).rejects.toThrow("尚未开启");
  const saved = job.configure({ username: "builder", token: "test-api-token", enabled: true });
  expect(JSON.stringify(saved)).not.toContain("test-api-token");
  expect((await job.run()).last?.status).toBe("queued");
  await expect(job.run()).rejects.toThrow("已在排队或运行");
  expect((await job.check()).last?.status).toBe("running");
  expect((await job.check()).last).toMatchObject({ status: "success", url: `${BUILD_JOB_URL}100/` });
  expect(request.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([[CRUMB, "GET"], [`${BUILD_JOB_URL}buildWithParameters?delay=0sec`, "POST"], ["http://172.16.8.85:8080/queue/item/12/api/json", "GET"], [`${BUILD_JOB_URL}100/api/json`, "GET"]]);
  for (const [, options] of request.mock.calls) { expect(options?.redirect).toBe("manual"); expect(options?.body).toBeUndefined(); }
  expect(JSON.stringify(store.db.prepare("SELECT * FROM kv").all())).not.toContain("test-api-token");
});

it("sends the CSRF crumb and its session cookie with the POST", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ crumbRequestField: "Jenkins-Crumb", crumb: "c0ffee" }, { headers: { "set-cookie": "JSESSIONID.abc=s1; Path=/; HttpOnly" } }))
    .mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/31/" } }));
  const { job } = setup(request);
  job.configure({ username: "builder", token: "login-password", enabled: true });
  expect((await job.run(undefined, "/打包", "ios_hotfix")).last).toMatchObject({ status: "queued", job: "ios_hotfix" });
  const [url, options] = request.mock.calls[1]!;
  expect(url).toBe(`${BUILD_JOBS.ios_hotfix.url}buildWithParameters?delay=0sec`);
  expect(options?.headers).toMatchObject({ "Jenkins-Crumb": "c0ffee", cookie: "JSESSIONID.abc=s1", authorization: expect.stringMatching(/^Basic /) });
});

it("runs different jobs side by side but refuses the same job twice", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(noCrumb())
    .mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/41/" } }))
    .mockResolvedValueOnce(noCrumb())
    .mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/42/" } }));
  const { job } = setup(request);
  job.configure({ username: "builder", token: "test-api-token", enabled: true });
  await job.run(undefined, "/打包", "ios_hotfix");
  const state = await job.run(undefined, "/打包", "android_hotfix");
  expect(state.runs.ios_hotfix?.status).toBe("queued");
  expect(state.runs.android_hotfix?.status).toBe("queued");
  await expect(job.run(undefined, "/打包", "ios_hotfix")).rejects.toThrow("「出ios热更新资源」已在排队或运行");
  expect(request).toHaveBeenCalledTimes(4);
});

it("routes the Android hash preset to Android and returns a redacted failure tail to the same model conversation once", async () => {
  const base = BUILD_JOBS.android.url;
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(noCrumb())
    .mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/22/" } }))
    .mockResolvedValueOnce(Response.json({ executable: { url: `${base}23/` } }))
    .mockResolvedValueOnce(Response.json({ building: false, result: "FAILURE" }))
    .mockResolvedValueOnce(new Response("ignored prefix", { headers: { "X-Text-Size": "120000" } }))
    .mockResolvedValueOnce(new Response("compiler error CS1002\ntoken=test-api-token\npassword=secret-value"));
  const { job, store, host } = setup(request);
  const ws = store.addWorkspace({ path: "D:/test-project", name: "Test" });
  const task = store.createTask({ title: "Build task", workspaceId: ws.id });
  const s = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: ws.id, title: "", status: "idle", writer: "workbench", runtimeRef: null });
  job.configure({ username: "builder", token: "test-api-token", enabled: true });
  await job.command(s.id, "#高配打包机 自动出安卓包");
  expect(request.mock.calls[1]![0]).toBe(`${base}buildWithParameters?delay=0sec`);
  await job.check();
  const result = await job.check();
  expect(result.last).toMatchObject({ job: "android", status: "failed", sessionId: s.id, analysisQueued: true, notified: "local" });
  expect(result.last?.errorLog).toContain("CS1002");
  expect(JSON.stringify(result)).not.toMatch(/test-api-token|secret-value/);
  expect(request.mock.calls[5]![0]).toBe(`${base}23/logText/progressiveText?start=72000`);
  const analyze = vi.mocked(host.sessions.inbox.put);
  expect(analyze).toHaveBeenCalledWith(s.id, expect.stringContaining("CS1002"));
  expect(analyze).toHaveBeenCalledWith(s.id, expect.stringContaining("不可信"));
  await job.check();
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(store.listItems(s.id).some((i) => i.type === "notice" && i.message.includes("CS1002"))).toBe(true);
});

function failingBuild(job: "ios_hotfix") {
  const base = BUILD_JOBS[job].url;
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(noCrumb())
    .mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/50/" } }))
    .mockResolvedValueOnce(Response.json({ executable: { url: `${base}7/` } }))
    .mockResolvedValueOnce(Response.json({ building: false, result: "FAILURE" }))
    .mockResolvedValueOnce(new Response("[Pipeline] stage\nHybridCLR mismatch mother='8.3.0'"));
}
function relayMock() {
  const direct = vi.fn().mockResolvedValue({ id: "thread-wny" });
  const send = vi.fn().mockResolvedValue({});
  return { direct, send, factory: vi.fn(() => ({ direct, send }) as unknown as ReturnType<NonNullable<Relay>>) };
}
function linkTeam(host: HostService, root: string, name: string, relayEnabled = true) {
  const env = { AMO_HOME: join(root, "amo") };
  updateCooperation({ relayEnabled }, env);
  Object.assign(host, { teamLink: { env, login: () => ({ account: { name, server: "https://relay.test", key: "k" }, deviceId: "d" }) } });
}

it("tells WNY about a failed build through 中转, marked as WorkStudio's AI", async () => {
  const relay = relayMock();
  const { job, host, root } = setup(failingBuild("ios_hotfix"), relay.factory);
  linkTeam(host, root, "builder-account");
  job.configure({ username: "builder", token: "test-api-token", enabled: true });
  await job.run(undefined, "/打包", "ios_hotfix");
  await job.check();
  const state = await job.check();
  expect(relay.factory).toHaveBeenCalledWith("https://relay.test", "k");
  expect(relay.direct).toHaveBeenCalledWith("WNY");
  expect(relay.send).toHaveBeenCalledWith("thread-wny", expect.objectContaining({ kind: "text", mentions: ["WNY"], via: { kind: "ai", client: "WorkStudio" }, body: expect.stringContaining("HybridCLR mismatch") }));
  expect(relay.send.mock.calls[0]![1].body).toMatch(/^@WNY 【构建失败】出ios热更新资源（SurvivorTD_IOS_Hotfix）/);
  expect(relay.send.mock.calls[0]![1].body).not.toContain("[Pipeline]");
  expect(state.runs.ios_hotfix).toMatchObject({ status: "failed", notified: "relay", message: expect.stringContaining("已通过中转通知 @WNY") });
});

it("keeps the failure notice local on WNY's own computer, with 中转 off, or when sending fails", async () => {
  for (const [name, enabled, broken] of [["WNY", true, false], ["builder-account", false, false], ["builder-account", true, true]] as const) {
    const relay = relayMock();
    if (broken) relay.direct.mockRejectedValue(new Error("offline"));
    const { job, host, root } = setup(failingBuild("ios_hotfix"), relay.factory);
    linkTeam(host, root, name, enabled);
    job.configure({ username: "builder", token: "test-api-token", enabled: true });
    await job.run(undefined, "/打包", "ios_hotfix");
    await job.check();
    const state = await job.check();
    expect(relay.send).not.toHaveBeenCalled();
    expect(state.runs.ios_hotfix).toMatchObject({ status: "failed", notified: "local", message: expect.stringContaining("只在本机显示") });
  }
});

it("rejects a different job's build URL even on the approved Jenkins origin", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(noCrumb()).mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/22/" } })).mockResolvedValueOnce(Response.json({ executable: { url: `${BUILD_JOB_URL}23/` } }));
  const { job } = setup(request);
  job.configure({ username: "builder", token: "test-api-token", enabled: true });
  await job.run(undefined, "/build", "android");
  expect((await job.check()).last?.status).toBe("unknown");
  expect(request).toHaveBeenCalledTimes(3);
});

it("does not follow a foreign queue URL or retry a POST with an unknown result", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(noCrumb()).mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "https://untrusted.example/queue/item/1/" } }));
  const { job } = setup(request);
  job.configure({ username: "builder", token: "test-api-token", enabled: true });
  expect((await job.run()).last?.status).toBe("unknown");
  await job.check();
  expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValueOnce(noCrumb()).mockRejectedValueOnce(new Error("timeout"));
  expect((await job.run()).last?.message).toContain("不会自动重试");
  await job.check();
  expect(request).toHaveBeenCalledTimes(4);
  expect(isBuildCommand("/打包")).toBe(true);
  expect(isBuildCommand("请帮我看看 /打包")).toBe(false);
  expect(isBuildCommand("/打包 http://other/job")).toBe(false);
});

it("submits nothing when Jenkins refuses the login at the crumb step", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
  const { job } = setup(request); job.configure({ username: "builder", token: "wrong", enabled: true });
  expect((await job.run(undefined, "/打包", "android_base")).last).toMatchObject({ status: "unknown", message: expect.stringContaining("Jenkins 拒绝登录") });
  expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});

it("uses job defaults on the parameterized endpoint and never retries an HTTP 400", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(noCrumb()).mockResolvedValue(new Response("parameter rejection", { status: 400 }));
  const { job } = setup(request); job.configure({ username: "builder", token: "test-api-token", enabled: true });
  expect((await job.run(undefined, "/打包", "android")).last).toMatchObject({ status: "unknown", message: expect.stringContaining("HTTP 400") });
  await job.check(); expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]).toEqual([`${BUILD_JOBS.android.url}buildWithParameters?delay=0sec`, expect.objectContaining({ method: "POST", redirect: "manual" })]);
  expect(request.mock.calls[1]![1]?.body).toBeUndefined();
});
