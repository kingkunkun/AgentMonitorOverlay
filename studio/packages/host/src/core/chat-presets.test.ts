import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "../store/store.js";
import { ChatPresets } from "./chat-presets.js";

const clean: Array<() => void> = [];
afterEach(() => clean.splice(0).forEach((run) => run()));
function setup() { const root = mkdtempSync(join(tmpdir(), "amo-hash-presets-")); const store = new Store(join(root, "studio.db")); clean.push(() => { store.close(); removeTempDir(root); }); return { host: { store }, presets: new ChatPresets({ store }) }; }
it("seeds both approved jobs into a local document and preserves personal edits across reloads", () => {
  const { host, presets } = setup();
  const initial = presets.state();
  expect(initial.presets.map((p) => p.job)).toEqual(["ios", "android"]);
  expect(readFileSync(initial.filePath, "utf8")).toContain("默认参数");
  presets.save(initial.presets.map((p) => ({ ...p, prompt: "我自己的默认聊天任务" })));
  const reloaded = new ChatPresets(host);
  expect(reloaded.state().presets[0]!.prompt).toBe("我自己的默认聊天任务");
  expect(reloaded.match("#高配打包机 自动出安卓包\n请执行")?.job).toBe("android");
  expect(reloaded.match("请看一下这行\n#高配打包机 自动出安卓包")).toBeNull();
  expect(reloaded.match("#高配打包机 自动出安卓包 其他内容")).toBeNull();
});
it("rejects ambiguous or arbitrary executable presets and does not overwrite an invalid document", () => {
  const { presets } = setup();
  const initial = presets.state();
  expect(() => presets.save([initial.presets[0], initial.presets[0]])).toThrow("重复");
  expect(() => presets.save([{ ...initial.presets[0], job: "http://other/job" }])).toThrow("已授权");
  writeFileSync(initial.filePath, "broken json");
  expect(() => presets.state()).toThrow("格式无效");
  expect(readFileSync(initial.filePath, "utf8")).toBe("broken json");
});
