import { expect, it } from "vitest";
import { orderedModelGroups } from "./model-groups.js";

it("splits a mixed Codex catalog, preserves native order and keeps the route of every row", () => {
  const group = (profileId: string, label: string, ...ids: string[]) => ({
    profileId, label, models: ids.map(id => ({ id, label: id, efforts: [] })), disabledReason: "busy",
  });
  const groups = orderedModelGroups([
    group("other", "GLM", "glm"),
    group("claude-subscription", "Claude", "opus", "claude-fable-5-2"),
    group("codex-default", "GPT", "gorilla/gpt", "gpt-6", "gorilla-claude/fable", "gpt-6.2", "other/model"),
  ]);
  expect(groups.map(g => [g.profileId, g.models.map(m => m.id)])).toEqual([
    ["codex-default", ["gpt-6", "gpt-6.2"]],
    ["claude-subscription", ["opus", "claude-fable-5-2"]],
    ["codex-default", ["gorilla/gpt", "gorilla-claude/fable"]],
    ["other", ["glm"]],
    ["codex-default", ["other/model"]],
  ]);
  expect(groups[2]).toMatchObject({ label: "Gorilla · GPT", disabledReason: "busy" });
});
