import type { CompanyAgent, CompanyAgentStatus, CompanyMessage } from "@amo-studio/protocol";

export const AGENT_STATUS: Record<CompanyAgentStatus, string> = { human: "你", disabled: "已停用", unconfigured: "待配置", ready: "可接任务", running: "运行中", waiting: "待处理", error: "出错" };
export interface Mention { id: string; name: string }
export interface CompanyDraft { text: string; mentions: Mention[]; clientMessageId: string; replyTo: string | null }

/** Only an @ at a word boundary opens the chooser; typing an email does not address an agent. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s（(])@([^@\n]{0,50})$/.exec(before);
  return match ? { start: before.lastIndexOf("@"), query: match[1]! } : null;
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text: string, name: string) => new RegExp(`(?:^|[\\s（(])@${escape(name)}(?=$|[\\s，。！？、,:;!?）)])`).test(text);

/** Chosen mentions keep their identity through renames. Plain names only resolve when unambiguous in this room. */
export function recipients(text: string, chosen: readonly Mention[], members: readonly CompanyAgent[]): string[] {
  const ids = new Set(chosen.filter((m) => members.some((a) => a.id === m.id) && named(text, m.name)).map((m) => m.id));
  for (const a of members) if (named(text, a.name) && !chosen.some((m) => m.name === a.name) && members.filter((b) => b.name === a.name).length === 1) ids.add(a.id);
  return [...ids];
}

/** The newest delivery state wins, while loaded history stays in chronological order. */
export function mergeMessages(older: readonly CompanyMessage[], newer: readonly CompanyMessage[]): CompanyMessage[] {
  const byId = new Map(older.map((m) => [m.id, m]));
  for (const m of newer) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Defensive roots also keep a stale/missing manager visible; cycles never recurse forever. */
export function organizationRoots(agents: readonly CompanyAgent[]): CompanyAgent[] {
  const roots = agents.filter((a) => !a.managerId || !agents.some((b) => b.id === a.managerId));
  const seen = new Set<string>();
  const visit = (id: string) => { if (seen.has(id)) return; seen.add(id); for (const a of agents) if (a.managerId === id) visit(a.id); };
  roots.forEach((a) => visit(a.id));
  for (const a of agents) if (!seen.has(a.id)) { roots.push(a); visit(a.id); }
  return roots;
}
