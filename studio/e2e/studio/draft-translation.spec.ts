import { expect, test } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import type { Route } from "@playwright/test";
import { launchStudio, screenshot } from "../support/studio.js";
import { selectAndRightClick } from "../support/selection.js";

test("translation replaces only the requesting draft; undo, edits, navigation and reading a user message", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("WorkStudio") });
    const source = "The build is ready for testing.", chinese = "构建已完成，可以开始测试。";
    await studio.api("POST", "/api/tasks", { title: "发布前检查", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: source } });
    await page.getByTestId("task-card").first().click();
    const user = page.getByTestId("msg-user").first();
    await expect(user).toContainText(source);
    const pending: Route[] = [];
    await page.route("**/api/translate", r => { pending.push(r); });
    async function answer(text: string, target: string, translated: string) {
      await expect.poll(() => pending.length).toBe(1);
      const route = pending.shift()!;
      expect(route.request().postDataJSON()).toEqual({ text, target });
      await route.fulfill({ json: { model: "gpt-6.2-sol", text: translated } });
    }
    const original = page.getByLabel("输入消息");
    await original.fill(chinese);
    await page.getByRole("button", { name: "译成英文", exact: true }).click();
    await answer(chinese, "en", source);
    await expect(original).toHaveValue(source);
    await expect(original).toBeFocused();
    await screenshot(app, "studio", "translated-chat-draft", page);
    await page.getByRole("button", { name: "撤销翻译" }).click();
    await expect(original).toHaveValue(chinese);
    await selectAndRightClick(page, user.locator(".msg-text"), "ready for testing");
    await page.getByRole("menuitem", { name: "翻译成中文" }).click();
    await answer("ready for testing", "zh", "可以开始测试");
    const dialog = page.getByRole("dialog", { name: "选段翻译" });
    await expect(dialog.getByLabel("译文")).toHaveText("可以开始测试");
    await dialog.getByText("查看原文").click();
    await screenshot(app, "studio", "translate-selected-text", page);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "译成英文", exact: true }).click();
    await expect.poll(() => pending.length).toBe(1);
    await page.getByTestId("nav-new-chat").click();
    const first = page.getByLabel("第一句话");
    await first.fill("请检查发布说明。");
    await answer(chinese, "en", source);
    await expect(first).toHaveValue("请检查发布说明。");
    await page.getByRole("button", { name: "译成英文", exact: true }).click();
    await expect.poll(() => pending.length).toBe(1);
    await first.fill("请检查本次发布说明。");
    await answer("请检查发布说明。", "en", "Please check the release notes.");
    await expect(first).toHaveValue("请检查本次发布说明。");
    await page.getByRole("button", { name: "译成英文", exact: true }).click();
    await answer("请检查本次发布说明。", "en", "Please check the notes for this release.");
    await expect(first).toHaveValue("Please check the notes for this release.");
    await page.getByRole("button", { name: "撤销翻译" }).click();
    await expect(first).toHaveValue("请检查本次发布说明。");
    await page.getByRole("button", { name: "译成英文", exact: true }).click();
    await expect.poll(() => pending.length).toBe(1);
    await pending.shift()!.fulfill({ status: 400, json: { error: { code: "bad_request", message: "翻译超时，请重试" } } });
    await expect(page.getByRole("alert").filter({ hasText: "翻译超时" })).toBeVisible();
    await expect(first).toHaveValue("请检查本次发布说明。");
    expect((await studio.api<{ tasks: unknown[] }>("GET", "/api/state")).tasks).toHaveLength(1);
  } finally { await studio.close(); }
});

test("translation settings show native GPT first, exclude Claude routes and remember the saved model", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    let model = "gpt-6.2-sol";
    await page.route("**/api/settings/translation", r => {
      if (r.request().method() === "PUT") model = r.request().postDataJSON().model;
      return r.fulfill({ json: { model } });
    });
    const ids = ["gorilla/gpt-6.2-astra", "gpt-6.2-sol", "gorilla-claude/opus", "gpt-6.2-astra"];
    await page.route("**/api/profiles/codex-default/choices", r => r.fulfill({ json: { profileId: "codex-default", models: ids.map(id => ({ id, label: id.includes("/") ? id : id === "gpt-6.2-sol" ? "GPT-6.2 Sol" : "GPT-6.2 Astra", efforts: [] })), permissions: [], defaultPermission: "", source: "cli" } }));
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByRole("tab", { name: "模型", exact: true }).click();
    const nav = settings.getByRole("button", { name: "翻译", exact: true });
    await nav.click();
    const picker = settings.getByRole("combobox", { name: "默认翻译模型" });
    await expect(picker).toHaveValue(model);
    await expect(picker.locator("option")).toHaveCount(3);
    expect(await picker.locator("option").evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).toEqual(["gpt-6.2-sol", "gpt-6.2-astra", "gorilla/gpt-6.2-astra"]);
    await screenshot(app, "studio", "translation-model-settings", page);
    await picker.selectOption("gpt-6.2-astra");
    await expect(picker).toHaveValue("gpt-6.2-astra");
    await settings.getByRole("button", { name: "常用预设", exact: true }).click();
    await nav.click();
    await expect(picker).toHaveValue("gpt-6.2-astra");
  } finally { await studio.close(); }
});
