import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RelayClient, RelayStore, startRelayServer } from "@amo-studio/relay";
import { launchStudio, screenshot } from "../support/studio.js";

test("relay shortcut opens directly and shows server unread counts while the relay window is closed", async () => {
  const studio = await launchStudio();
  const db = new RelayStore(join(studio.root, "test-team.db"));
  const team = await startRelayServer({ store: db, host: "127.0.0.1", port: 0 });
  const recipient = new RelayClient(team.url, db.register("入口测试", "test-password-123").key);
  const teammate = new RelayClient(team.url, db.register("协作测试", "other-password-123").key);
  try {
    const { app, page } = studio;
    const shortcut = page.getByTestId("topbar-relay");
    const badge = page.getByTestId("relay-unread");
    const opened = () => app.evaluate(() => (globalThis as { __amoRelayOpened?: Array<{ threadId?: string; exe: string | null }> }).__amoRelayOpened ?? []);
    const settings = page.getByTestId("cooperation-open");
    await shortcut.click();
    const dialog = page.getByRole("dialog", { name: "合作模式", exact: true });
    await dialog.getByRole("textbox", { name: "服务器地址", exact: true }).fill(team.url);
    await dialog.getByRole("textbox", { name: "账号", exact: true }).fill("入口测试");
    await dialog.getByLabel("密码", { exact: true }).fill("test-password-123");
    await dialog.getByRole("button", { name: "登录账号", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "退出团队账号并关闭团队远程、中转", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "收起窗口" }).click();
    await shortcut.click();
    await expect.poll(opened).toEqual([{ exe: expect.any(String) }]);
    expect(await studio.api("GET", "/api/cooperation")).toMatchObject({ relayEnabled: false, relayAttention: null });
    await expect(dialog).toHaveCount(0);

    await settings.click();
    await dialog.getByTestId("cooperation-relay-toggle").click();
    await expect(dialog.getByTestId("cooperation-relay-toggle")).toHaveText("关闭中转");
    await dialog.getByRole("button", { name: "收起窗口" }).click();
    const chat = await teammate.direct("入口测试");
    await teammate.send(chat.id, { body: "要确认一下明天的安排" });
    await expect(badge).toHaveText("1", { timeout: 15_000 });
    await expect.poll(opened).toHaveLength(1);
    await shortcut.click();
    await expect.poll(async () => (await opened()).at(-1)?.threadId).toBe(`thread:${chat.id}`);
    // Raising a window is not reading the message.
    await expect(badge).toHaveText("1");

    const cowork = await teammate.createCowork({ title: "联调协作", goal: "核对聊天和已读提示", members: ["入口测试"] });
    await teammate.postCowork(cowork.id, { body: "联调准备好了" });
    const unread = (await recipient.threads()).reduce((count, t) => count + t.unread, 0);
    expect(unread).toBeGreaterThan(1);
    await expect(badge).toHaveText(String(unread), { timeout: 15_000 });
    await screenshot(app, "studio", "relay-shortcut-unread", page);
    await shortcut.click();
    await expect.poll(async () => (await opened()).at(-1)?.threadId).toBe(`cowork:${cowork.id}`);

    // Other clients reading the same account are reflected after the long poll refresh.
    await recipient.read(cowork.id);
    await expect(badge).toHaveText("1", { timeout: 16_000 });
    await recipient.read(chat.id);
    await expect(badge).toHaveCount(0, { timeout: 16_000 });
    await teammate.postCowork(cowork.id, { body: "还有一条待查" });
    await expect(badge).toHaveText("1", { timeout: 15_000 });
    await settings.click();
    await dialog.getByTestId("cooperation-relay-toggle").click();
    await expect(badge).toHaveCount(0);
    expect(await studio.api<{ enabled: boolean }>("GET", "/api/remote")).toMatchObject({ enabled: false });
  } finally {
    await team.close();
    db.close();
    await studio.close();
  }
});
