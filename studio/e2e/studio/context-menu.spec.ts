import { expect, test } from "@playwright/test";
import type { Annotation, Session, Task, Workspace } from "@amo-studio/protocol";
import { selectAndRelease, selectAndRightClick } from "../support/selection.js";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openMarkdownReply(s: Studio) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "审阅",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[markdown]]" },
  });
  await s.page.getByTestId("task-card").first().click();
  const reply = s.page.getByTestId("msg-agent").last();
  await expect(reply.locator("table.md-table")).toBeVisible({ timeout: 30_000 });
  return { reply, session: created.session };
}

test("selection bar: follow up, quote and copy; right-click translates just the selection", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { reply, session } = await openMarkdownReply(studio);
  const bar = page.getByTestId("selection-bar");

  // 批注: the bubble by the selection shows the quote; saving stores it with its source range and context.
  await selectAndRelease(reply, "发现 3 张表");
  await expect(bar.getByRole("button")).toHaveText(["追问", "引用", "翻译", "复制"]);
  await screenshot(studio.app, "studio", "follow-up-selection", page);
  await bar.getByRole("button", { name: "追问" }).click();
  await expect(bar).toHaveCount(0);
  const draft = page.getByTestId("annotation-bubble");
  await expect(draft).toContainText("发现 3 张表");
  await draft.getByLabel("追问内容").fill("这里应该说明是哪三张");
  await draft.getByRole("button", { name: "保存" }).click();
  await expect(draft).toHaveCount(0);
  const [saved] = await studio.api<Annotation[]>("GET", `/api/sessions/${session.id}/annotations`);
  expect(saved).toMatchObject({ quote: "发现 3 张表", note: "这里应该说明是哪三张", sentAt: null });
  const item = (await studio.api<Array<{ id: string; type: string; markdown?: string }>>("GET", `/api/sessions/${session.id}/items`)).find((i) => i.id === saved!.itemId)!;
  expect(item.markdown!.slice(saved!.start, saved!.end)).toBe("发现 **3** 张表");

  // 引用
  await selectAndRelease(reply, "先修正概率");
  await bar.getByRole("button", { name: "引用" }).click();
  await expect(page.getByLabel("输入消息")).toHaveValue("> 先修正概率\n\n");

  // 复制: the bar stays and says so a moment.
  await selectAndRelease(reply, "Boss_Lv20");
  await page.getByTestId("selection-copy").click();
  // Test mode records copies instead of overwriting the user's clipboard.
  await expect.poll(() => studio!.app.evaluate(() => (globalThis as { __amoCopied?: string[] }).__amoCopied?.at(-1))).toBe("Boss_Lv20");
  await expect(page.getByTestId("selection-copy")).toHaveText("已复制");
  await expect(page.getByTestId("selection-copy")).toHaveText("复制");

  const requests: unknown[] = [];
  await page.route("**/api/translate", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { model: "gpt-6.2-sol", text: "首领等级 20" } });
  });
  await selectAndRightClick(page, reply, "Boss_Lv20");
  await page.getByRole("menuitem", { name: "翻译成中文" }).click();
  const dialog = page.getByRole("dialog", { name: "选段翻译" });
  await expect(dialog.getByLabel("译文")).toHaveText("首领等级 20");
  await dialog.getByText("查看原文").click();
  expect(requests).toEqual([{ text: "Boss_Lv20", target: "zh" }]);
  await screenshot(studio.app, "studio", "conversation-translation", page);
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("输入消息")).toHaveValue("> 先修正概率\n\n");
});
