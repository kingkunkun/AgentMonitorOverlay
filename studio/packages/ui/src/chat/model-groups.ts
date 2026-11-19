import type { ModelOption } from "@amo-studio/protocol";

export interface ComposerModelGroup { profileId: string; label: string; models: readonly ModelOption[]; loading?: boolean; disabledReason?: string }

function rank(group: ComposerModelGroup, model?: ModelOption): number {
  if (/^gorilla(?:[-/]|$)/i.test(model?.id ?? "") || /\bgorilla\b/i.test(group.label)) return 2;
  if (group.profileId === "codex-default" && (!model || !model.id.includes("/") || model.id.startsWith("openai/"))) return 0;
  if (group.profileId === "claude-subscription") return 1;
  return 3;
}

/** A single Codex catalog can contain both first-party and proxied rows. Keep the original profile and model for every pick. */
export function orderedModelGroups(groups: readonly ComposerModelGroup[]) {
  return groups.flatMap(group => {
    const buckets = new Map<number, ModelOption[]>();
    for (const model of group.models) {
      const priority = rank(group, model);
      const bucket = buckets.get(priority);
      if (bucket) bucket.push(model);
      else buckets.set(priority, [model]);
    }
    if (!buckets.size) buckets.set(rank(group), []);
    return [...buckets].map(([priority, models]) => ({
      ...group, priority, models,
      label: priority === 2 && !/\bgorilla\b/i.test(group.label) ? (group.label ? `Gorilla · ${group.label}` : "Gorilla") : group.label,
    }));
  }).sort((a, b) => a.priority - b.priority);
}
