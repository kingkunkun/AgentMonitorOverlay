import { expect, test } from "@playwright/test";
import { launchStudio, screenshot } from "../support/studio.js";

test("cooperation has one non-draggable scroller: wheel, scrollbar and account-management jump remain usable", async () => {
  const studio = await launchStudio();
  try {
    const { app, page } = studio;
    await page.setViewportSize({ width: 1100, height: 720 });
    await studio.api("POST", "/api/cooperation/phone-accounts", { name: "手机测试", password: "phone-password-123" });
    await page.route("**/api/cooperation", async (route) => {
      const response = await route.fetch(); const state = await response.json();
      state.server = { ...state.server, running: true, lan: true, port: 47950, addresses: ["http://127.0.0.1:47950", "http://169.254.10.20:47950", "http://192.168.50.20:47950", "http://172.25.10.1:47950"] };
      await route.fulfill({ response, json: state });
    });
    await page.getByTestId("cooperation-open").click();
    const dialog = page.getByRole("dialog", { name: "合作模式", exact: true });
    expect(await dialog.evaluate((el) => el.closest(".topbar, .titlebar"))).toBeNull();
    expect(await dialog.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
    const metrics = await dialog.evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight, nested: [...el.querySelectorAll("*")].filter((child) => ["auto", "scroll"].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight).length }));
    expect(metrics.full).toBeGreaterThan(metrics.height + 200); expect(metrics.nested).toBe(0);
    const box = (await dialog.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 160);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => dialog.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => dialog.evaluate((el) => el.scrollTop)).toBe(0);
    // A real pointer drag, rather than Playwright's automatic scrollIntoView when clicking a hidden field.
    const bar = await dialog.evaluate((el) => { const r = el.getBoundingClientRect(), border = parseFloat(getComputedStyle(el).borderRightWidth) || 0, width = (el as HTMLElement).offsetWidth - el.clientWidth - border * 2; return { x: r.right - border - Math.max(width, 12) / 2, y: r.top + 18 + (el.clientHeight - 36) * el.clientHeight / el.scrollHeight / 2 }; });
    await page.mouse.move(bar.x, bar.y); await page.mouse.down(); await page.mouse.move(bar.x, bar.y + 160, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => dialog.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    await page.mouse.move(box.x + box.width / 2, box.y + 160); await page.mouse.wheel(0, 10000);
    await expect.poll(() => dialog.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
    // At the very bottom the account row may already have passed above the viewport; reach it using only the wheel.
    await expect(async () => {
      const target = (await dialog.getByRole("button", { name: "重设密码", exact: true }).boundingBox())!;
      if (target.y < box.y + 64) await page.mouse.wheel(0, -120);
      else if (target.y + target.height > box.y + box.height - 8) await page.mouse.wheel(0, 120);
      expect(target.y).toBeGreaterThanOrEqual(box.y + 64);
      expect(target.y + target.height).toBeLessThanOrEqual(box.y + box.height - 8);
    }).toPass({ timeout: 3000, intervals: [100] });
    await expect(dialog.getByRole("button", { name: "重设密码", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByText("手机连接地址（选一个即可）：", { exact: true })).toBeAttached();
    await expect(dialog.locator(".phone-addresses details")).not.toHaveAttribute("open");
    await screenshot(app, "studio", "cooperation-scroll-account-controls", page);
    await dialog.getByRole("button", { name: "重设密码", exact: true }).click();
    await dialog.getByLabel("手机测试 的新密码", { exact: true }).fill("new-phone-password-123");
    await dialog.getByRole("button", { name: "保存新密码并断开旧登录", exact: true }).click();
    await expect(dialog.getByLabel("手机测试 的新密码", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "停用账号", exact: true }).click();
    await expect(dialog.getByTestId("phone-account-row")).toContainText("已停用");
    // Jump to the form without depending on automatic scrolling by the test runner.
    await page.mouse.wheel(0, -400);
    await dialog.getByTestId("phone-manage-accounts").click();
    await expect(dialog.getByLabel("手机账号名称", { exact: true })).toBeInViewport();
    await dialog.getByLabel("手机账号名称", { exact: true }).fill("新手机");
    await dialog.getByLabel("手机账号密码", { exact: true }).fill("new-phone-account-123");
    await dialog.getByRole("button", { name: "创建手机账号", exact: true }).click();
    await expect(dialog.getByTestId("phone-account-row")).toHaveCount(2);
    await screenshot(app, "studio", "cooperation-scroll-account-create", page);
  } finally { await studio.close(); }
});
