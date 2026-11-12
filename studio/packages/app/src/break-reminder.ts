import { BrowserWindow, screen } from "electron";
import { readFileSync } from "node:fs";

export const BREAK_INTERVAL_MS = 15 * 60_000;
export const BREAK_DURATION_MS = 30_000;

/** Local artwork and CSS only: no preload, network, cursor reads or keyboard/mouse hooks. */
export function breakReminderHtml(image: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'"><title>WorkStudio 活动提醒</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:'Microsoft YaHei',sans-serif}.tip{position:absolute;left:0;top:0;width:35.7vh;animation:roam 12s linear infinite;filter:drop-shadow(0 5px 10px #0003)}img{display:block;height:50vh;width:auto;max-width:100%;margin:auto;border-radius:24px}.text{margin:8px -24px 0;padding:12px 16px;border-radius:18px;background:#fffef3f5;border:2px solid #f8bb54;color:#332416;font-weight:700;font-size:clamp(20px,3vh,38px);text-align:center;white-space:nowrap}.hint{font-size:clamp(12px,1.6vh,20px);font-weight:400;margin-top:6px}@keyframes roam{0%,100%{transform:translate(4vw,4vh)}25%{transform:translate(calc(96vw - 35.7vh),12vh)}50%{transform:translate(calc(90vw - 35.7vh),35vh)}75%{transform:translate(5vw,30vh)}}@media(prefers-reduced-motion:reduce){.tip{animation:none;left:calc(50vw - 17.85vh);top:15vh}}</style>
<div class="tip"><img alt="活动提醒图片" src="data:image/png;base64,${image}"><div class="text">站起来，活动下！<div class="hint">休息一下 · 30 秒后自动收起</div></div></div>`;
}

export function setupBreakReminder(options: { image: string; testMode: boolean; enabled(): boolean; owner(): BrowserWindow | null }) {
  let interval: ReturnType<typeof setInterval> | null = null;
  let dismiss: ReturnType<typeof setTimeout> | null = null;
  let win: BrowserWindow | null = null;
  const hide = () => { if (dismiss) clearTimeout(dismiss); dismiss = null; if (win && !win.isDestroyed()) win.destroy(); win = null; };
  const show = async () => {
    if (win || !options.enabled()) return;
    const owner = options.owner();
    const area = (owner && !owner.isDestroyed() ? screen.getDisplayMatching(owner.getBounds()) : screen.getPrimaryDisplay()).workArea;
    const w = new BrowserWindow({ ...area, ...(options.testMode ? { x: -32000, y: -32000 } : {}), title: "WorkStudio 活动提醒", frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win = w;
    w.setIgnoreMouseEvents(true); // No forwarding hook; every click goes straight to the underlying app.
    w.setAlwaysOnTop(true, "screen-saver");
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (event) => event.preventDefault());
    w.once("closed", () => { if (win === w) win = null; });
    try {
      await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(breakReminderHtml(readFileSync(options.image).toString("base64"))));
      if (win !== w || w.isDestroyed() || !options.enabled()) return;
      w.showInactive(); dismiss = setTimeout(hide, BREAK_DURATION_MS); dismiss.unref();
    } catch { hide(); }
  };
  return {
    start() { if (interval) clearInterval(interval); interval = null; hide(); if (options.enabled() && !options.testMode) { interval = setInterval(() => void show(), BREAK_INTERVAL_MS); interval.unref(); } },
    show, hide,
    stop() { if (interval) clearInterval(interval); interval = null; hide(); },
  };
}
