import { expect, it, vi } from "vitest";
import { translateText, translationEndpoint } from "./translate.js";
import type { CodexServers } from "./codex-runtime.js";

const invoke = (res: Response) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(res);
  return { fetcher, result: translateText({ url: "http://localhost:10000/v1" }, "gpt-6.2-sol", { target: "en", text: "请检查构建。" }, fetcher) };
};
const reply = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Check the build." }] }] };
it("meters a direct translation just once from its terminal response and does not invent missing usage", async () => {
  const usage = { input_tokens: 70, input_tokens_details: { cached_tokens: 40 }, output_tokens: 10 };
  for (const response of [Response.json({ ...reply, usage }), new Response('data: '+JSON.stringify({type:"response.completed",response:{ ...reply, usage }})+'\n\n', { headers: { "content-type": "text/event-stream" } }), Response.json(reply)]) {
    const present = (await response.clone().text()).includes("input_tokens");
    const meter = vi.fn();
    await translateText({url:"http://localhost"}, "gpt-6.2-sol", {target:"en",text:"示例"}, vi.fn().mockResolvedValue(response), meter);
    expect(meter.mock.calls).toEqual(present ? [[70,40,10]] : []);
  }
});
it("issues exactly one tool-free Responses request and reads only a finished assistant message", async () => {
  const { fetcher, result } = invoke(Response.json(reply));
  expect(await result).toBe("Check the build.");
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe("http://localhost:10000/v1/responses");
  expect(JSON.parse(String(options?.body))).toEqual({ model: "gpt-6.2-sol", tools: [], stream: true, store: false, instructions: expect.stringContaining("English"), input: [{ role: "user", content: [{ type: "input_text", text: "请检查构建。" }] }] });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("handles fragmented SSE, rejects cut-off and incomplete replies, and does not expose provider errors", async () => {
  const stream = (frames: string) => new Response(new ReadableStream({ start(c) { for (const byte of new TextEncoder().encode(frames)) c.enqueue(Uint8Array.of(byte)); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  const delta = 'data: {"type":"response.output_text.delta","delta":"not the complete translation"}\r\n\r\n';
  expect(await invoke(stream(delta + "data: " + JSON.stringify({ type: "response.completed", response: reply }) + "\r\n\r\n")).result).toBe("Check the build.");
  await expect(invoke(stream(delta)).result).rejects.toThrow("提前结束");
  await expect(invoke(Response.json({ ...reply, status: "incomplete" })).result).rejects.toThrow("未完成");
  await expect(invoke(new Response("private input", { status: 403 })).result).rejects.toThrow("HTTP 403");
});
it("does not consult a native login for the loopback provider or run any Claude CLI", async () => {
  const ensure = vi.fn(), servers = { ensure } as unknown as CodexServers, read = vi.fn(), credentials = { read, has: () => false };
  const p = { id: "codex-default", runtime: "codex" as const, provider: "loop", label: "GPT", model: null };
  const providers = { loop: { name: "Loop", wireApi: "responses" as const, envKey: "", auth: "none" as const, baseUrl: "http://127.0.0.1:10100/v1" } };
  expect(await translationEndpoint(p, providers, credentials, servers, {})).toEqual({ url: providers.loop.baseUrl });
  await expect(translationEndpoint({ ...p, runtime: "claude" }, providers, credentials, servers, {})).rejects.toThrow("GPT");
  expect(read).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled();
});
it("only requests native credentials for official routes, and uses the signed-in workspace", async () => {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
  const request = vi.fn().mockResolvedValueOnce({ config: { model_provider: "other" } }).mockResolvedValueOnce({ config: { model_provider: "openai", chatgpt_base_url: "https://chatgpt.com/backend-api/" } }).mockResolvedValueOnce({ authMethod: "chatgpt", authToken: `test.${claims}.test` });
  const p = { id: "codex-default", runtime: "codex" as const, provider: null, label: "GPT", model: null };
  const run = () => translationEndpoint(p, {}, { read: () => null }, { ensure: async () => ({ client: { request } }) } as unknown as CodexServers, {});
  await expect(run()).rejects.toThrow("自定义地址");
  expect(request.mock.calls.map(c => c[0])).toEqual(["config/read"]);
  expect(await run()).toMatchObject({ url: "https://chatgpt.com/backend-api/codex", headers: { "ChatGPT-Account-ID": "test-account" } });
});
