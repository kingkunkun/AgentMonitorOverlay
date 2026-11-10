import { expect, it, vi } from "vitest";
import { ClaudeRuntime } from "./claude-runtime.js";

// Native history import was removed by the user's privacy policy (2026-11-10).
// These entry points must refuse before resolving a native config directory or reading its files.
it("never lists, previews, resumes or checks an outside Claude conversation", async () => {
  const runtime = Object.create(ClaudeRuntime.prototype) as ClaudeRuntime;
  const outsideHome = vi.fn(() => { throw new Error("native history must not be opened"); });
  Object.assign(runtime, { outsideHome });
  expect(await runtime.outsideSessions()).toMatchObject({ sessions: [], unavailable: expect.stringContaining("隐私") });
  expect(await runtime.outsidePreview("native-session")).toBeNull();
  await expect(runtime.checkResume("claude", "native-session")).rejects.toThrow("隐私");
  expect(outsideHome).not.toHaveBeenCalled();
});
