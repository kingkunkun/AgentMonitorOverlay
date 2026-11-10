import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { ChatPresetsState, Topic } from "@amo-studio/protocol";
import { launchStudio, screenshot } from "../support/studio.js";

test("hash presets complete into task/session composers, persist editable defaults, and topics/canvas remain hidden", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    const topic = await studio.api<Topic>("POST", "/api/topics", { title: "保留但不展示的旧专题" });
    await studio.api("POST", "/api/tasks", { title: "旧专题里的任务仍在看板", topicId: topic.id });
    await expect(page.getByRole("navigation", { name: "范围" }).getByRole("region", { name: "专题" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "画布", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("board-group-topics")).toHaveCount(0);
    await expect(page.getByTestId("task-card").filter({ hasText: "旧专题里的任务仍在看板" })).toBeVisible();
    const initial = await studio.api<ChatPresetsState>("GET", "/api/chat-presets");
    expect(initial.presets.map((p) => p.job)).toEqual(["ios", "android"]);
    await page.getByTestId("hash-presets-open").click();
    const dialog = page.getByRole("dialog", { name: "# 提示词", exact: true });
    await dialog.getByRole("button", { name: "#高配打包机 自动出安卓包", exact: true }).click();
    await dialog.getByRole("textbox", { name: "默认聊天任务", exact: true }).fill("打包失败时请分析编译错误，并在当前会话解释原因。");
    await dialog.getByRole("button", { name: "保存提示词", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("已保存");
    expect(readFileSync(initial.filePath, "utf8")).toContain("分析编译错误");
    await screenshot(app, "studio", "hash-presets-settings", page);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await studio.api("PUT", "/api/chat-presets", { presets: [...(await studio.api<ChatPresetsState>("GET", "/api/chat-presets")).presets, { id: "explain", phrase: "解释任务", prompt: "请解释 2 加 2 的结果。", job: null }] });
    await page.getByTestId("nav-new-chat").click();
    await expect(page.getByText("专题", { exact: true })).toHaveCount(0);
    const first = page.getByRole("textbox", { name: "第一句话", exact: true });
    await first.fill("#");
    await first.press("End");
    const suggestions = page.getByTestId("suggest");
    await expect(suggestions.getByRole("option", { name: /高配打包机 自动出IOS包/ })).toBeVisible();
    await suggestions.getByRole("option", { name: /高配打包机 自动出安卓包/ }).click();
    await expect(first).toHaveValue("#高配打包机 自动出安卓包\n打包失败时请分析编译错误，并在当前会话解释原因。");
    await screenshot(app, "studio", "hash-preset-new-task", page);
    // A text-only preset still goes through the current model, without invoking Jenkins.
    await first.fill("#解释");
    await first.press("End");
    await suggestions.getByRole("option", { name: /解释任务/ }).click();
    await page.getByTestId("draft-start").click();
    await expect(page.getByTestId("msg-agent").last()).toContainText("2 加 2", { timeout: 30_000 });
    await expect(page.getByTestId("task-topic")).toHaveCount(0);
    const composer = page.getByLabel("输入消息", { exact: true });
    await composer.fill("#");
    await composer.press("End");
    await expect(suggestions.getByRole("option", { name: /高配打包机 自动出IOS包/ })).toBeVisible();
    await screenshot(app, "studio", "hash-presets-chat", page);
  } finally { await studio.close(); }
});
