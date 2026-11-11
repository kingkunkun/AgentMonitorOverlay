import { expect, test } from "@playwright/test";
import type { ProfileChoices, Session, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot } from "../support/studio.js";

test("Codex composer keeps prompts/files, changes actual model/effort/permissions, and stops generation", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
    const created = await studio.api<{ session: Session }>("POST", "/api/tasks", { title: "输入框与正文", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[markdown]]" } });
    await page.getByTestId("task-card").first().click();
    const agent = page.getByTestId("msg-agent").last();
    await expect(agent.locator(".md-table")).toBeVisible({ timeout: 30_000 });
    const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
    await expect(composer).toHaveAttribute("placeholder", "和 WorkStudio 一起工作");
    await expect(page.locator(".chat-bar").getByTestId("hash-presets-open")).toBeVisible();
    await expect(page.getByRole("button", { name: "添加图片或文件", exact: true })).toBeVisible();
    await expect(page.getByTestId("switch-mcp")).toHaveCount(0);
    expect(await agent.locator(".md").evaluate((el) => getComputedStyle(el).fontSize)).toBe("15px");
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-testid="msg-agent"] .md-p' });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.map((f) => f.familyName).join(", ")).not.toMatch(/Serif|Times|SimSun|宋体/i);
    await cdp.detach();
    await screenshot(app, "studio", "codex-chat-typography", page);

    await page.getByTestId("switch-model").click();
    const panel = page.getByTestId("model-effort-popover");
    await expect(panel.getByRole("slider", { name: "思考强度" })).toBeVisible();
    await screenshot(app, "studio", "codex-effort-popover", page);
    await panel.getByRole("slider", { name: "思考强度", exact: true }).focus();
    await page.keyboard.press("Home");
    await expect(page.getByTestId("effort-label")).toHaveText("低");
    await page.getByTestId("switch-model").click();
    await panel.getByRole("button", { name: "思考强度：高", exact: true }).click();
    await expect(page.getByTestId("effort-label")).toHaveText("高");
    if (!(await panel.isVisible())) await page.getByTestId("switch-model").click();
    await panel.getByRole("button", { name: "选择模型", exact: true }).click();
    const choices = await studio.api<ProfileChoices>("GET", "/api/profiles/codex-mock/choices");
    const other = choices.models.at(-1)!;
    await panel.getByRole("searchbox", { name: "搜索模型" }).fill(other.label);
    await expect(panel.getByRole("option")).toHaveCount(1);
    await screenshot(app, "studio", "codex-model-list", page);
    await panel.getByRole("option", { name: new RegExp(other.label) }).click();
    await expect(page.getByTestId("switch-model")).toContainText(other.label);
    await page.getByTestId("switch-model").click();
    await expect(panel.getByTestId("fast-toggle")).toHaveAttribute("aria-pressed", "false");
    await panel.getByTestId("fast-toggle").click();
    await expect(page.getByTestId("options-note")).toContainText("Fast 已开");
    await page.getByTestId("switch-permission").click();
    const permissions = page.getByRole("dialog", { name: "权限", exact: true });
    await permissions.getByRole("button", { name: /逐条询问/ }).click();
    await expect(page.getByTestId("switch-permission")).toContainText("逐条询问");
    await page.getByRole("button", { name: "更多工具", exact: true }).click();
    await expect(page.getByTestId("switch-mcp")).toBeVisible();
    await page.keyboard.press("Escape");
    await composer.fill("options reach runtime");
    await composer.press("Enter");
    await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: options reach runtime");
    const request = studio.mock!.requests.filter((r) => r.lastUserText === "options reach runtime").at(-1)!;
    expect((request.body as { model: string; reasoning: { effort: string } }).model).toBe(other.id);
    expect((request.body as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
    expect((request.body as { service_tier: string }).service_tier).toBe("priority");
    await composer.fill("[[slow]]");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "打断", exact: true })).toBeVisible();
    await expect(page.locator(".round-btn.send")).toHaveCount(0);
    await page.getByRole("button", { name: "打断", exact: true }).click();
    await expect(page.getByRole("button", { name: "正在停止", exact: true })).toHaveCount(0, { timeout: 30_000 });

    await page.getByTestId("nav-new-chat").click();
    await expect(page.getByRole("region", { name: "新聊天", exact: true })).toBeVisible();
    await expect(page.getByTestId("switch-model")).toBeVisible();
    await page.getByTestId("switch-model").click();
    await expect(page.getByRole("slider", { name: "思考强度" })).toBeVisible();
    await page.keyboard.press("Escape");
    await screenshot(app, "studio", "codex-new-composer", page);
  } finally { await studio.close(); }
});

test("Claude can change model and permissions through the compact menus without changing account", async () => {
  const studio = await launchStudio();
  try {
    const { page } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("claude-project") });
    await studio.api("POST", "/api/tasks", { title: "Claude 输入框", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "hello", options: { effort: "high", permission: "plan" } } });
    await page.getByTestId("task-card").first().click();
    await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: hello", { timeout: 30_000 });
    const choices = await studio.api<ProfileChoices>("GET", "/api/profiles/claude-mock/choices");
    const second = choices.models[1]!;
    await page.getByTestId("switch-model").click();
    await expect(page.getByRole("slider", { name: "思考强度", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.getByRole("group", { name: "Mock Claude", exact: true }).getByRole("option", { name: second.label, exact: true }).click();
    await expect(page.getByTestId("switch-model")).toContainText(second.label);
    await page.getByTestId("switch-permission").click();
    await page.getByRole("dialog", { name: "权限", exact: true }).getByRole("button", { name: /全部允许/ }).click();
    await expect(page.getByTestId("switch-permission")).toContainText("完全访问");
    const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
    await composer.fill("after model change");
    await composer.press("Enter");
    await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: after model change", { timeout: 30_000 });
    expect(studio.claudeMock!.requests.filter((r) => r.lastUserText === "after model change").some((r) => (r.body as { model: string }).model === second.id)).toBe(true);
  } finally { await studio.close(); }
});
