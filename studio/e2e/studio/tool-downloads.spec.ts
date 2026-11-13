import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchStudio, screenshot } from "../support/studio.js";

test("工具下载在设置中显示真实清单，默认不启动公开服务", async () => {
  const studio = await launchStudio({ env: { AMO_STUDIO_PORT: "47977", AMO_STUDIO_PHONE_PORT: "47978" } });
  try {
    const root = join(studio.dataDir, "tool-downloads"), data = Buffer.from("fixture-apk");
    const sha256 = createHash("sha256").update(data).digest("hex");
    mkdirSync(join(root, "files"), { recursive: true });
    writeFileSync(join(root, "files", `${sha256}.apk`), data);
    writeFileSync(join(root, "catalog.json"), JSON.stringify([{ id: "phone-workstudio", title: "手机工作台", version: "0.2.3", versionCode: 7, filename: "WorkStudio-Mobile-0.2.3.apk", bytes: data.length, sha256, publishedAt: "2026-11-13", notes: "模型与权限选择、运行状态。覆盖安装保留账号与草稿。" }]));
    await studio.page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = studio.page.getByRole("dialog", { name: "设置" });
    await dialog.getByRole("tab", { name: "工具下载", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "手机工作台" })).toBeVisible();
    await expect(dialog.getByText("下载服务未运行", { exact: false })).toBeVisible();
    await expect(dialog.getByLabel("开启本机下载服务")).not.toBeChecked();
    await dialog.getByLabel("开启本机下载服务").click();
    await expect(dialog.getByLabel("开启本机下载服务")).toBeChecked();
    await expect(dialog.getByText("服务运行中", { exact: false })).toBeVisible();
    await screenshot(studio.app, "studio/settings", "tool-downloads", studio.page);
    const opened = await studio.app.evaluate(() => (globalThis as { __amoOpenedUrls?: string[] }).__amoOpenedUrls ?? []);
    await dialog.getByRole("button", { name: "打开下载页 ↗" }).click();
    await expect.poll(() => studio.app.evaluate(() => (globalThis as { __amoOpenedUrls?: string[] }).__amoOpenedUrls?.length ?? 0)).toBe(opened.length + 1);
    const result = await studio.api<{ urls: string[] }>("GET", "/api/tool-downloads");
    expect((await fetch(result.urls[0]!)).status).toBe(200);
    await dialog.getByLabel("开启本机下载服务").click();
    await expect(dialog.getByLabel("开启本机下载服务")).not.toBeChecked();
    await expect(dialog.getByText("下载服务未运行", { exact: false })).toBeVisible();
  } finally { await studio.close(); }
});
