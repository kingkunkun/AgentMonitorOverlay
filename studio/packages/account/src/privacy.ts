import { realpathSync } from "node:fs";
/** Native-client stores are never inputs to WorkStudio forwarding. Resolve links first. */
export function privateClientPath(path: string): boolean {
  let p = path;
  try { p = realpathSync.native(path); } catch { /* nonexistent paths are still checked */ }
  return /(^|[\\/])\.(codex|claude|opencodex)([\\/]|$)|[\\/](openai[\\/]codex|chatgpt|dot)([\\/]|$)|[\\/]AppData[\\/](Roaming|Local)[\\/](Claude|Codex|OpenAI|com\.openai\.chat|com\.openai\.codex|com\.anthropic\.claude)([\\/]|$)/i.test(p);
}
