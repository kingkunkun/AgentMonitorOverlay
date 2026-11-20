import { expect, it } from "vitest";
import { orderedModelGroups } from "./model-groups.js";

it("sorts numeric versions within each source and keeps equal-version variants and their original routes", () => {
  const group = (profileId: string, label: string, ...ids: string[]) => ({
    profileId, label, models: ids.map(id => ({ id, label: id, efforts: [] })), disabledReason: "busy",
  });
  const groups = orderedModelGroups([
    group("other", "GLM", "glm"),
    group("claude-subscription", "Claude", "opus", "claude-fable-5-2"),
    group("codex-default", "GPT", "gorilla/gpt", "gpt-6", "gorilla-claude/fable", "gpt-6.2-sol", "other/model", "gpt-5.6-sol", "gpt-6.2-astra", "gpt-6.10-sol", "gpt-6.1-sol"),
  ]);
  expect(groups.map(g => [g.profileId, g.models.map(m => m.id)])).toEqual([
    ["codex-default", ["gpt-6.10-sol", "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6", "gpt-5.6-sol"]],
    ["claude-subscription", ["claude-fable-5-2", "opus"]],
    ["codex-default", ["gorilla/gpt", "gorilla-claude/fable"]],
    ["other", ["glm"]],
    ["codex-default", ["other/model"]],
  ]);
  expect(groups[2]).toMatchObject({ label: "Gorilla · GPT", disabledReason: "busy" });
});
