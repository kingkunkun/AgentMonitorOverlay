import { expect, test } from "@playwright/test";
import type { Session, SessionItem, StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot } from "../support/studio.js";

test("Fast is visible with honest quota information and the shell uses chat/Focus labels without history arrows", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("project") });
    await studio.api("POST", "/api/tasks", { title: "Fast 提示", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hello", options: { fast: true } } });
    await page.getByTestId("task-card").first().click();
    await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello", { timeout: 30000 });
    await expect(page.getByTestId("fast-active")).toBeVisible();
    await page.getByTestId("switch-model").click();
    await expect(page.getByTestId("fast-usage-hint")).toContainText("Fast 用量提示");
    await expect(page.getByTestId("fast-usage-hint")).toContainText("未提供独立");
    await screenshot(app, "studio", "fast-quota-hint", page);
    await page.keyboard.press("Escape");
    await page.getByTestId("fast-active").click();
    await expect(page.getByTestId("fast-active")).toHaveCount(0);
    await expect(page.getByTestId("scope-all")).toContainText("全部聊天");
    await expect(page.getByRole("combobox", { name: "搜索聊天记录", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "在 Focus 中置顶", exact: true })).toContainText("Focus");
    await expect(page.getByTestId("nav-back")).toHaveCount(0);
    await expect(page.getByTestId("nav-forward")).toHaveCount(0);
  } finally { await studio.close(); }
});

test("a finished Claude chat can select Codex, carry its WorkStudio text and draft, and keep the original record", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("cross-channel") });
    const original = await studio.api<{ session: Session }>("POST", "/api/tasks", { title: "跨渠道接续", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "Remember the orange robot." } });
    await page.getByTestId("task-card").first().click();
    await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: Remember the orange robot.", { timeout: 30000 });
    const before = await studio.api<SessionItem[]>("GET", `/api/sessions/${original.session.id}/items`);
    const input = page.getByRole("textbox", { name: "输入消息", exact: true });
    await input.fill("Continue with the robot.");
    await page.getByTestId("switch-model").click();
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await expect(page.getByRole("option", { name: "Mock Model", exact: true })).toBeVisible();
    await screenshot(app, "studio", "all-channel-models", page);
    await page.getByRole("option", { name: "Mock Model", exact: true }).click();
    await expect(page.getByTestId("switch-model")).toContainText("Mock Model");
    await expect(input).toHaveValue("Continue with the robot.");
    expect(studio.mock!.requests).toHaveLength(0);
    const state = await studio.api<StateSnapshot>("GET", "/api/state");
    expect(state.tasks).toHaveLength(1);
    expect(state.sessions).toHaveLength(2);
    const next = state.sessions.find((s) => s.id !== original.session.id)!;
    expect(next).toMatchObject({ profileId: "codex-mock", taskId: original.session.taskId });
    await input.press("Enter");
    await expect(page.getByTestId("msg-user").last()).toContainText("Continue with the robot.");
    await expect(page.getByTestId("carried-context")).toContainText("已携带此前聊天文本");
    await expect.poll(() => studio.mock!.requests.some((r) => r.lastUserText.includes("Continue with the robot.") && r.lastUserText.includes("Remember the orange robot."))).toBe(true);
    const after = await studio.api<SessionItem[]>("GET", `/api/sessions/${original.session.id}/items`);
    for (const item of before.filter((i) => i.type === "user" || i.type === "agent")) expect(after).toContainEqual(item);
    await screenshot(app, "studio", "continued-chat-context", page);
  } finally { await studio.close(); }
});
