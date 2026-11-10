import { expect, test } from "@playwright/test";
import { launchStudio, screenshot } from "../support/studio.js";

test("top bar opens the relay client without changing remote permissions", async () => {
  const studio = await launchStudio();
  try {
    const { app, page } = studio;
    await expect(page.getByTestId("topbar-relay")).toBeVisible();
    await page.getByTestId("topbar-relay").click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __amoRelayOpened?: Array<{ threadId?: string }> }).__amoRelayOpened?.map((r) => r.threadId ?? null))).toEqual([null]);
    expect(await studio.api<{ enabled: boolean }>("GET", "/api/remote")).toMatchObject({ enabled: false });
    await screenshot(app, "studio", "relay-entry", page);
  } finally {
    await studio.close();
  }
});
