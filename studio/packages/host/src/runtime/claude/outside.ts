import type { OutsideSession, OutsideSessionPreview, Workspace } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import type { ClaudeHome } from "./claude-env.js";

// Keep compatibility with old metadata, but no SDK call or filesystem scanner may enumerate native history.
export const adoptedKey = (ref: string) => `claude-adopted:${ref}`;
export async function listOutsideSessions(_home: ClaudeHome, _store: Store, _workspaces: readonly Workspace[]): Promise<OutsideSession[]> { return []; }
export async function previewOutsideSession(_home: ClaudeHome, _ref: string): Promise<OutsideSessionPreview | null> { return null; }
export function isCompactSummary(message: { type: string; message: unknown }): boolean { return message.type === "user" && typeof message.message === "string" && message.message.startsWith("This session is being continued from a previous conversation"); }
