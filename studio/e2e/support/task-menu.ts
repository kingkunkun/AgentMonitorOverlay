import type { Page } from "@playwright/test";

/**
 * The task head keeps only a ⋯ button since 2026-11-18 (the Codex layout): pin, new session,
 * Review, 书签, 会话列表, 侧栏 and 归档 live in its menu. Tests open that menu before reaching them.
 */
export async function openTaskMenu(page: Page): Promise<void> {
  const menu = page.getByTestId("task-menu");
  if (await menu.isVisible()) return;
  await page.getByTestId("task-more").click();
  await menu.waitFor({ state: "visible" });
}

export async function closeTaskMenu(page: Page): Promise<void> {
  const menu = page.getByTestId("task-menu");
  if (!(await menu.isVisible())) return;
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
}
