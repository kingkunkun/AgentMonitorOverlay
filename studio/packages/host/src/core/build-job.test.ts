import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BUILD_JOB_URL, BUILD_JOBS } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "../store/store.js";
import type { HostService } from "../service.js";
import { BuildJob, isBuildCommand } from "./build-job.js";
import { ChatPresets } from "./chat-presets.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of clean.splice(0)) await run(); });
function setup(request: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "amo-build-job-"));
  const store = new Store(join(root, "studio.db"));
  const secrets = new Map<string, string>();
  const host = { store, options: { credentials: { read: (id: string) => secrets.get(id) ?? null, write: (id: string, secret: string) => secrets.set(id, secret), remove: (id: string) => secrets.delete(id) } }, publish: vi.fn(), cooperation: { taskAllowed: () => true } } as unknown as HostService;
  Object.assign(host, { chatPresets: new ChatPresets(host), sessions: { inbox: { put: vi.fn().mockResolvedValue({ delivered: true, waiting: 0 }) } } });
  const job = new BuildJob(host, request);
  clean.push(async () => { await job.stop(); store.close(); removeTempDir(root); });
  return { job, store, secrets, host };
}
it("only posts the fixed job once, tracks its own queue/build and keeps credentials out of state", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/12/" } }))
    .mockResolvedValueOnce(Response.json({ executable: { url: `${BUILD_JOB_URL}100/` } }))
    .mockResolvedValueOnce(Response.json({ building: false, result: "SUCCESS" }));
  const { job, store } = setup(request);
  await expect(job.run()).rejects.toThrow("尚未开启");
  const saved = job.configure({ username: "builder", token: "test-api-token", enabled: true });
  expect(JSON.stringify(saved)).not.toContain("test-api-token");
  expect((await job.run()).last?.status).toBe("queued");
  await expect(job.run()).rejects.toThrow("已有打包");
  expect((await job.check()).last?.status).toBe("running");
  expect((await job.check()).last).toMatchObject({ status: "success", url: `${BUILD_JOB_URL}100/` });
  expect(request.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([[`${BUILD_JOB_URL}build?delay=0sec`, "POST"], ["http://172.16.8.85:8080/queue/item/12/api/json", "GET"], [`${BUILD_JOB_URL}100/api/json`, "GET"]]);
  for (const [, options] of request.mock.calls) { expect(options?.redirect).toBe("manual"); expect(options?.body).toBeUndefined(); }
  expect(JSON.stringify(store.db.prepare("SELECT * FROM kv").all())).not.toContain("test-api-token");
});
it("routes the Android hash preset to Android and returns a redacted failure tail to the same model conversation once", async () => {
  const base = BUILD_JOBS.android.url;
  const request = vi.fn<typeof fetch>()
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
  expect(request.mock.calls[0]![0]).toBe(`${base}build?delay=0sec`);
  await job.check();
  const result = await job.check();
  expect(result.last).toMatchObject({ job: "android", status: "failed", sessionId: s.id, analysisQueued: true });
  expect(result.last?.errorLog).toContain("CS1002");
  expect(JSON.stringify(result)).not.toMatch(/test-api-token|secret-value/);
  expect(request.mock.calls[4]![0]).toBe(`${base}23/logText/progressiveText?start=72000`);
  const analyze = vi.mocked(host.sessions.inbox.put);
  expect(analyze).toHaveBeenCalledWith(s.id, expect.stringContaining("CS1002"));
  expect(analyze).toHaveBeenCalledWith(s.id, expect.stringContaining("不可信"));
  await job.check();
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(store.listItems(s.id).some((i) => i.type === "notice" && i.message.includes("CS1002"))).toBe(true);
});
it("rejects a different job's build URL even on the approved Jenkins origin", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "http://172.16.8.85:8080/queue/item/22/" } })).mockResolvedValueOnce(Response.json({ executable: { url: `${BUILD_JOB_URL}23/` } }));
  const { job } = setup(request);
  job.configure({ username: "builder", token: "test-api-token", enabled: true });
  await job.run(undefined, "/build", "android");
  expect((await job.check()).last?.status).toBe("unknown");
  expect(request).toHaveBeenCalledTimes(2);
});
it("does not follow a foreign queue URL or retry a POST with an unknown result", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 201, headers: { location: "https://untrusted.example/queue/item/1/" } }));
  const { job } = setup(request);
  job.configure({ username: "builder", token: "test-api-token", enabled: true });
  expect((await job.run()).last?.status).toBe("unknown");
  await job.check();
  expect(request).toHaveBeenCalledTimes(1);
  request.mockRejectedValueOnce(new Error("timeout"));
  expect((await job.run()).last?.message).toContain("不会自动重试");
  await job.check();
  expect(request).toHaveBeenCalledTimes(2);
  expect(isBuildCommand("/打包")).toBe(true);
  expect(isBuildCommand("请帮我看看 /打包")).toBe(false);
  expect(isBuildCommand("/打包 http://other/job")).toBe(false);
});
