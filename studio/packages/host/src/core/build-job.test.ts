import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BUILD_JOB_URL } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "../store/store.js";
import type { HostService } from "../service.js";
import { BuildJob, isBuildCommand } from "./build-job.js";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of clean.splice(0)) await run(); });
function setup(request: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "amo-build-job-"));
  const store = new Store(join(root, "studio.db"));
  const secrets = new Map<string, string>();
  const host = { store, options: { credentials: { read: (id: string) => secrets.get(id) ?? null, write: (id: string, secret: string) => secrets.set(id, secret), remove: (id: string) => secrets.delete(id) } }, publish: vi.fn(), cooperation: { taskAllowed: () => true } } as unknown as HostService;
  const job = new BuildJob(host, request);
  clean.push(async () => { await job.stop(); store.close(); removeTempDir(root); });
  return { job, store, secrets };
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
