import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron, expect, test } from "@playwright/test";
import { studioRoot } from "../support/studio.js";
import { removeTempDir } from "@amo-studio/testkit";

test("WorkStudio carries Work中转 with a local UI and a shared platform login", async () => {
  const relay = await import(pathToFileURL(join(studioRoot, "packages/relay/dist/index.js")).href) as typeof import("../../packages/relay/src/index.js");
  const account = await import(pathToFileURL(join(studioRoot, "packages/account/dist/index.js")).href) as typeof import("../../packages/account/src/index.js");
  const root = mkdtempSync(join(tmpdir(), "amo-work-relay-"));
  const store = new relay.RelayStore(":memory:");
  // No publicDir: this server cannot supply any JavaScript. The client must use the bundled UI.
  const server = await relay.startRelayServer({ store, filesDir: join(root, "files"), host: "127.0.0.1", port: 0, name: "隔离测试组" });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const home = join(root, "amo");
    const signed = store.register("入口测试", "test-password-123");
    await account.saveAccount({ server: server.url, name: "入口测试", key: signed.key }, { env: { AMO_HOME: home } });
    account.updateCooperation({ relayEnabled: true }, { AMO_HOME: home });
    app = await _electron.launch({
      executablePath: join(studioRoot, "release/workstudio-integrated/WorkStudio/WorkStudio.exe"),
      args: ["--amo-app=relay"],
      env: { ...process.env, AMO_HOME: home, AMO_RELAY_HOME: join(root, "relay"), AMO_RELAY_TEST: "1" },
    });
    const page = await app.firstWindow();
    await expect(page.locator(".brand-name")).toHaveText("Work中转");
    await expect(page.getByRole("button", { name: "成员", exact: true })).toBeVisible();
    const info = await page.evaluate(() => (window as unknown as { relayShell: { info(): Promise<{ contentVersion: string }> } }).relayShell.info());
    expect(info.contentVersion).toBe("work-bundled");
    await page.getByRole("button", { name: "关闭中转功能", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work中转已关闭" })).toBeVisible();
    await page.getByRole("button", { name: "开启中转", exact: true }).click();
    await expect(page.locator(".brand-name")).toHaveText("Work中转");
    mkdirSync(join(studioRoot, "screenshots/relay"), { recursive: true });
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(join(studioRoot, "screenshots/relay/work-bundled.png"), Buffer.from(png, "base64"));
  } finally {
    await app?.close();
    await server.close();
    store.close();
    removeTempDir(root);
  }
});
