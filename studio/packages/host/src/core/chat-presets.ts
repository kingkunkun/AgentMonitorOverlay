import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readJsonFile, writeJsonFile } from "@amo-studio/account";
import { DEFAULT_CHAT_PRESETS, type ChatPreset, type ChatPresetsState } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";
import { HostError } from "./shared.js";

/** Person-maintained local settings document. No MCP writer and no job URL from chat. */
export class ChatPresets {
  constructor(private readonly host: { readonly store: Store }) {}
  get filePath(): string { return join(dirname(this.host.store.path), "chat-presets.json"); }
  state(): ChatPresetsState {
    if (!existsSync(this.filePath)) this.save(DEFAULT_CHAT_PRESETS.map((p) => ({ ...p })));
    const document = readJsonFile<{ presets: unknown }>(this.filePath);
    if (!document || !Array.isArray(document.presets)) throw new HostError("bad_request", `提示词设置文档格式无效：${this.filePath}`);
    return { filePath: this.filePath, presets: this.validate(document.presets) };
  }
  save(value: unknown): ChatPresetsState {
    const presets = this.validate(value);
    writeJsonFile(this.filePath, { version: 1, presets });
    return { filePath: this.filePath, presets };
  }
  match(text: unknown): ChatPreset | null {
    if (typeof text !== "string" || !text.trimStart().startsWith("#")) return null;
    const first = text.trimStart().split(/\r?\n/, 1)[0]!.trim();
    return this.state().presets.find((p) => `#${p.phrase}` === first) ?? null;
  }
  private validate(value: unknown): ChatPreset[] {
    if (!Array.isArray(value) || value.length > 100) throw new HostError("bad_request", "最多保存 100 个 # 提示词");
    const ids = new Set<string>();
    const names = new Set<string>();
    return value.map((raw: unknown) => {
      const p = raw as Partial<ChatPreset> | null;
      if (!p || typeof p.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id)) throw new HostError("bad_request", "提示词编号无效或重复");
      const phrase = typeof p.phrase === "string" ? p.phrase.trim().replace(/ +/g, " ") : "";
      if (!phrase || phrase.length > 100 || /[#\r\n\t]/.test(phrase) || names.has(phrase)) throw new HostError("bad_request", "提示词名称不能为空、不能重复或包含 #、换行");
      if (typeof p.prompt !== "string" || !p.prompt.trim() || p.prompt.length > 12000) throw new HostError("bad_request", "默认聊天任务不能为空，最多 12000 字");
      if (p.job !== null && p.job !== "ios" && p.job !== "android") throw new HostError("bad_request", "自动任务只能选择已授权的 iOS 或安卓 Job");
      ids.add(p.id); names.add(phrase);
      return { id: p.id, phrase, prompt: p.prompt.trim(), job: p.job };
    });
  }
}
