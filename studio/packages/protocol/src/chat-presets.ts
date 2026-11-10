import type { BuildJobId } from "./build-job.js";
export interface ChatPreset { id: string; phrase: string; prompt: string; job: BuildJobId | null }
export interface ChatPresetsState { presets: ChatPreset[]; filePath: string }
export const DEFAULT_CHAT_PRESETS: readonly ChatPreset[] = [
  { id: "build-ios", phrase: "高配打包机 自动出IOS包", job: "ios", prompt: "使用高配打包机的 SurvivorTD_IOS_Auto 默认参数生成 iOS 包。在当前会话报告排队、执行和成功或失败；失败时展示经过脱敏的关键日志，自动分析原因并提出可执行的修复建议，继续在当前会话沟通。不要自动重复提交打包。" },
  { id: "build-android", phrase: "高配打包机 自动出安卓包", job: "android", prompt: "使用高配打包机的 SurvivorTD_Android_Auto 默认参数生成安卓包。在当前会话报告排队、执行和成功或失败；失败时展示经过脱敏的关键日志，自动分析原因并提出可执行的修复建议，继续在当前会话沟通。不要自动重复提交打包。" },
];
export const presetMessage = (preset: ChatPreset): string => `#${preset.phrase}\n${preset.prompt}`;
export interface ChatPresetRoutes {
  "GET /api/chat-presets": { req: never; res: ChatPresetsState };
  "PUT /api/chat-presets": { req: { presets: ChatPreset[] }; res: ChatPresetsState };
}
