import { afterEach, expect, it, vi } from "vitest";
const { windows, readImage } = vi.hoisted(() => ({ windows: vi.fn(), readImage: vi.fn(() => Buffer.from("test-art")) }));
vi.mock("node:fs", () => ({ readFileSync: readImage }));
vi.mock("electron", () => ({
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  BrowserWindow: windows,
}));
import { BREAK_DURATION_MS, BREAK_INTERVAL_MS, setupBreakReminder } from "./break-reminder.js";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it("appears every 15 minutes, passes clicks through without focus, and closes automatically", async () => {
  vi.useFakeTimers(); let destroyed = false;
  const w = { isDestroyed: () => destroyed, destroy: vi.fn(() => { destroyed = true; }), setIgnoreMouseEvents: vi.fn(), setAlwaysOnTop: vi.fn(), once: vi.fn(), showInactive: vi.fn(), loadURL: vi.fn(async () => {}), webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() } };
  windows.mockImplementation(function () { destroyed = false; return w; });
  const reminder = setupBreakReminder({ image: "owned-test-image.png", testMode: false, enabled: () => true, owner: () => null });
  reminder.start(); await vi.advanceTimersByTimeAsync(BREAK_INTERVAL_MS - 1); expect(windows).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(windows).toHaveBeenCalledTimes(1); expect(windows).toHaveBeenCalledWith(expect.objectContaining({ focusable: false, skipTaskbar: true }));
  expect(w.setIgnoreMouseEvents).toHaveBeenCalledWith(true); expect(w.showInactive).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(BREAK_DURATION_MS); expect(w.destroy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(BREAK_INTERVAL_MS - BREAK_DURATION_MS); expect(windows).toHaveBeenCalledTimes(2);
  reminder.stop(); await vi.advanceTimersByTimeAsync(BREAK_INTERVAL_MS * 2); expect(windows).toHaveBeenCalledTimes(2);
});
it("does not show or read artwork while disabled", async () => {
  vi.useFakeTimers(); const reminder = setupBreakReminder({ image: "owned.png", testMode: false, enabled: () => false, owner: () => null });
  reminder.start(); await reminder.show(); await vi.advanceTimersByTimeAsync(BREAK_INTERVAL_MS * 4);
  expect(windows).not.toHaveBeenCalled(); expect(readImage).not.toHaveBeenCalled(); reminder.stop();
});
