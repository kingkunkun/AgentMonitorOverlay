import { expect, test } from "@playwright/test";
import type { CooperationState } from "@amo-studio/protocol";
import { launchStudio, screenshot } from "../support/studio.js";

test("cooperation controls are independent, imports and bookmarks stay hidden, and off signs out", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    await expect(page.getByTestId("topbar-marks")).toHaveCount(0);
    await page.getByTestId("build-open").click();
    const buildDialog = page.getByRole("dialog", { name: "iOS 打包", exact: true });
    await expect(buildDialog).toContainText("SurvivorTD_IOS_Auto");
    await expect(buildDialog.getByTestId("build-run")).toBeDisabled();
    await screenshot(app, "studio", "build-job", page);
    await buildDialog.getByRole("button", { name: "收起窗口", exact: true }).click();
    await page.getByTestId("cooperation-open").click();
    const dialog = page.getByRole("dialog", { name: "合作模式", exact: true });
    await expect(dialog).toBeVisible();
    const initial = await studio.api<CooperationState>("GET", "/api/cooperation");
    expect(initial.account).toBeNull();
    expect(initial.server.running).toBe(true);
    await dialog.getByRole("textbox", { name: "服务器地址", exact: true }).fill(initial.server.addresses[0]!);
    await dialog.getByRole("textbox", { name: "账号", exact: true }).fill("合作测试");
    await dialog.getByLabel("密码", { exact: true }).fill("test-password-123");
    await dialog.getByRole("textbox", { name: "注册邀请码", exact: true }).fill(initial.server.invite);
    await dialog.getByRole("button", { name: "创建账号并登录", exact: true }).click();
    await expect(dialog).toContainText("合作测试");
    await expect(dialog.getByTestId("cooperation-remote-toggle")).toHaveText("开启远程");
    await expect(dialog.getByTestId("cooperation-relay-toggle")).toHaveText("开启中转");
    await dialog.getByTestId("cooperation-relay-toggle").click();
    await expect(dialog.getByTestId("cooperation-relay-toggle")).toHaveText("关闭中转");
    expect((await studio.api<CooperationState>("GET", "/api/cooperation")).remoteEnabled).toBe(false);
    await screenshot(app, "studio", "cooperation-controls", page);
    await dialog.getByTestId("cooperation-off").click();
    await expect(dialog.getByRole("button", { name: "登录账号", exact: true })).toBeVisible();
    expect(await studio.api<CooperationState>("GET", "/api/cooperation")).toMatchObject({ account: null, relayEnabled: false, remoteEnabled: false, server: { running: false } });
    await screenshot(app, "studio", "cooperation-off", page);
    await expect(dialog.getByRole("textbox", { name: "服务器地址", exact: true })).toHaveValue(initial.server.addresses[0]!);
    await dialog.getByRole("textbox", { name: "服务器地址", exact: true }).fill("");
    await dialog.getByRole("textbox", { name: "账号", exact: true }).fill("合作测试");
    await dialog.getByLabel("密码", { exact: true }).fill("test-password-123");
    await expect(dialog.getByRole("button", { name: "登录账号", exact: true })).toBeDisabled();
    await expect(dialog).toContainText("请先填写或选择服务器地址");
    await dialog.getByRole("button", { name: initial.server.addresses[0]!, exact: true }).click();
    // One-click off stopped our personal server too: explicitly start it again before logging in.
    await dialog.getByRole("button", { name: "启动手机服务", exact: true }).click();
    const reopened = await studio.api<CooperationState>("GET", "/api/cooperation");
    await dialog.getByRole("textbox", { name: "服务器地址", exact: true }).fill(reopened.server.addresses[0]!);
    await dialog.getByRole("button", { name: "登录账号", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "退出账号并关闭远程、中转", exact: true })).toBeVisible();
    expect(await studio.api<CooperationState>("GET", "/api/cooperation")).toMatchObject({ account: { name: "合作测试" }, relayEnabled: false, remoteEnabled: false });
    await studio.api("POST", "/api/cooperation/off");
  } finally { await studio.close(); }
});
