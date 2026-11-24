import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect, test, type ElectronApplication } from "@playwright/test";
import { saveAccount } from "@amo-studio/account";
import { RelayStore, startRelayServer } from "@amo-studio/relay";
import { removeTempDir } from "@amo-studio/testkit";
import { packedApp, programLaunch } from "../support/packed.js";
import { launchStudio, studioRoot, withoutDataDir, type Studio } from "../support/studio.js";

test("bundled relay follows the running workbench theme and ignores desktop releases", async () => {
  const root = mkdtempSync(join(tmpdir(), "amo-studio-relay-appearance-"));
  const home = join(root, "amo-home");
  const publicDir = join(root, "public");
  const downloads = join(publicDir, "downloads");
  mkdirSync(downloads, { recursive: true });
  writeFileSync(join(downloads, "AMO-Relay-win.zip"), "only used to advertise a newer desktop release");
  writeFileSync(join(downloads, "AMO-Relay-win.json"), JSON.stringify({ build: "test-newer", sha256: "fixture", size: 45 }));
  const store = new RelayStore(join(root, "relay", "relay.db"));
  let server: Awaited<ReturnType<typeof startRelayServer>> | undefined;
  let relay: ElectronApplication | undefined;
  let studio: Studio | undefined;
  try {
    server = await startRelayServer({ store, publicDir, filesDir: join(root, "files"), host: "127.0.0.1", port: 0, name: "测试组" });
    const env = { AMO_HOME: home, AMO_RELAY_HOME: join(root, "relay-home") };
    const name = "主题测试";
    await saveAccount({ server: server.url, name, key: store.register(name, "test-password").key }, { env });
    studio = await launchStudio({ root, env });
    await studio.api("PUT", "/api/cooperation/relay", { enabled: true });
    const { page, dataDir } = studio;
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const setTheme = (name: string) => page.getByRole("radiogroup", { name: "主题", exact: true }).getByRole("radio", { name, exact: true }).click();
    await setTheme("深色");
    const program = programLaunch("app", join(studioRoot, "packages", "relay-app"));
    const platformBuild = packedApp && (JSON.parse(readFileSync(join(packedApp, "WorkStudio", "resources", "app", "package.json"), "utf8")) as { amoBuild?: { mode?: string } }).amoBuild?.mode === "platform";
    // Smoke-test the packed shortcut's directory lookup, without touching the packed program or the machine's config.
    if (platformBuild) writeFileSync(join(home, "platform.json"), JSON.stringify({ studioDataDir: dataDir }));
    relay = await _electron.launch({
      executablePath: program.executablePath,
      args: [...program.args, packedApp ? "--amo-app=relay" : "--workstudio-bundled-relay"],
      env: { ...withoutDataDir(process.env), ...env, AMO_RELAY_TEST: "1", ...(platformBuild ? {} : { AMO_STUDIO_DATA_DIR: dataDir }), AMO_STUDIO_HOME: join(root, "studio-home") },
    });
    const relayPage = await relay.firstWindow();
    await relayPage.getByRole("button", { name: "成员", exact: true }).click();
    const rootEl = relayPage.locator("html");
    await expect(rootEl).toHaveAttribute("data-theme", "dark");
    await expect(relayPage.locator(".topbar")).toHaveCSS("background-color", "rgb(21, 24, 27)");
    await expect(relayPage.getByText("桌面程序可更新", { exact: true })).toHaveCount(0);
    await setTheme("Codex（默认）");
    await expect(rootEl).toHaveAttribute("data-appearance", "codex");
    await expect(relayPage.locator(".topbar")).toHaveCSS("background-color", "rgb(250, 249, 247)");
    await expect(relayPage.locator(".list-pane")).toHaveCSS("background-color", "rgb(243, 241, 239)");
    const shots = join(studioRoot, "screenshots", "relay");
    mkdirSync(shots, { recursive: true });
    const image = await relay.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(join(shots, "workstudio-theme.png"), Buffer.from(image, "base64"));
    await setTheme("浅色");
    await expect(rootEl).toHaveAttribute("data-theme", "light");
    await expect(rootEl).not.toHaveAttribute("data-appearance");
    await setTheme("跟随系统");
    await expect(rootEl).not.toHaveAttribute("data-theme");
  } finally {
    await relay?.close();
    await studio?.close({ keepData: true });
    await server?.close();
    store.close();
    removeTempDir(root);
  }
});
