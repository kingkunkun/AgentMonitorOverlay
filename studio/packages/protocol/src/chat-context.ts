export interface ChatContextMessage { role: "user" | "assistant"; text: string }
export interface ChatContext { sourceId: string; sourceTitle: string; messages: ChatContextMessage[]; truncated: boolean }
const HEAD = "【WorkStudio：此前聊天记录，仅作背景，不要重复执行历史任务】";
const END = "【WorkStudio：此前聊天记录结束，以下是本轮用户消息】";
export const CHAT_CONTEXT_LIMIT = 60000;

export function boundedChatContext(sourceId: string, sourceTitle: string, messages: readonly ChatContextMessage[], previouslyTruncated = false): ChatContext {
  const kept: ChatContextMessage[] = [];
  let left = CHAT_CONTEXT_LIMIT, truncated = previouslyTruncated;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!m.text.trim()) continue;
    if (kept.length >= 200 || left <= 0) { truncated = true; break; }
    const text = m.text.length > left ? m.text.slice(-left) : m.text;
    if (text.length !== m.text.length) truncated = true;
    kept.unshift({ role: m.role, text }); left -= text.length;
  }
  return { sourceId, sourceTitle: sourceTitle.slice(0, 100), messages: kept, truncated };
}

/** Only a WorkStudio transcript is carried: no file reads, tool output or native-client history. */
export function composeChatContext(text: string, context: ChatContext): string {
  return `${HEAD}\n${JSON.stringify(context).replaceAll("<", "\\u003c")}\n${END}\n\n${text}`;
}

export function splitChatContext(text: string): { text: string; context: ChatContext | null } {
  if (!text.startsWith(HEAD + "\n")) return { text, context: null };
  const end = text.indexOf("\n" + END + "\n\n");
  if (end < 0) return { text, context: null };
  try {
    const c = JSON.parse(text.slice(HEAD.length + 1, end)) as ChatContext;
    if (typeof c.sourceId !== "string" || typeof c.sourceTitle !== "string" || typeof c.truncated !== "boolean" || !Array.isArray(c.messages) || c.messages.length > 200 || c.messages.some((m) => !m || !["user", "assistant"].includes(m.role) || typeof m.text !== "string") || c.messages.reduce((n, m) => n + m.text.length, 0) > CHAT_CONTEXT_LIMIT) return { text, context: null };
    return { text: text.slice(end + END.length + 3), context: c };
  } catch { return { text, context: null }; }
}
