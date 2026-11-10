import { expect, test } from "@playwright/test";
import { launchStudio, screenshot } from "../support/studio.js";

test("cooperation opens the relay client without changing remote permissions", async () => {
  const studio = await launchStudio();
  try {
    const { app, page } = studio;
    await page.getByTestId("cooperation-open").click();
    const local = await studio.api<{ server: { addresses: string[]; invite: string } }>("GET", "/api/cooperation");
    await studio.api("POST", "/api/cooperation/account", { action: "register", server: local.server.addresses[0], name: "入口测试", password: "test-password-123", passphrase: local.server.invite });
    await page.getByTestId("cooperation-relay-toggle").click();
    await page.getByRole("button", { name: "打开中转窗口", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __amoRelayOpened?: Array<{ threadId?: string }> }).__amoRelayOpened?.map((r) => r.threadId ?? null))).toEqual([null]);
    expect(await studio.api<{ enabled: boolean }>("GET", "/api/remote")).toMatchObject({ enabled: false });
    await screenshot(app, "studio", "relay-entry", page);
  } finally {
    await studio.api("POST", "/api/cooperation/off");
    await studio.close();
  }
});
