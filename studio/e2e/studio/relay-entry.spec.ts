import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RelayStore, startRelayServer } from "@amo-studio/relay";
import { launchStudio, screenshot } from "../support/studio.js";

test("cooperation opens the relay client without changing remote permissions", async () => {
  const studio = await launchStudio();
  const db = new RelayStore(join(studio.root, "test-team.db"));
  const team = await startRelayServer({ store: db, host: "127.0.0.1", port: 0 });
  db.register("入口测试", "test-password-123");
  try {
    const { app, page } = studio;
    await page.getByTestId("cooperation-open").click();
    const dialog = page.getByRole("dialog", { name: "合作模式", exact: true });
    await dialog.getByRole("textbox", { name: "服务器地址", exact: true }).fill(team.url);
    await dialog.getByRole("textbox", { name: "账号", exact: true }).fill("入口测试");
    await dialog.getByLabel("密码", { exact: true }).fill("test-password-123");
    await dialog.getByRole("button", { name: "登录账号", exact: true }).click();
    await page.getByTestId("cooperation-relay-toggle").click();
    await page.getByRole("button", { name: "打开中转窗口", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __amoRelayOpened?: Array<{ threadId?: string; exe: string | null }> }).__amoRelayOpened)).toEqual([{ exe: expect.any(String) }]);
    expect(await studio.api<{ enabled: boolean }>("GET", "/api/remote")).toMatchObject({ enabled: false });
    await screenshot(app, "studio", "relay-entry", page);
  } finally {
    await team.close();
    db.close();
    await studio.close();
  }
});
