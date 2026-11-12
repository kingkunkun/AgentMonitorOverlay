import type { Rectangle } from "electron";

export interface BotFlightOptions {
  url(): string | null;
  preload: string;
  testMode: boolean;
  /** 界面大小: the page is zoomed like every Studio page, the window grows with it. */
  scale(): number;
  /** Clicked: tell Focus. */
  onCaught(): void;
  note(what: string): void;
}

export interface BotFlightControl {
  /** Takes off near `from` (Focus's window), or only changes what it says while flying. */
  fly(message: string, from: Rectangle | null): void;
  land(): void;
  /** The page's parts that take clicks (its own pixels, zoomed); the rest of the window lets clicks through. */
  setShape(sender: Electron.WebContents, rects: Array<{ x: number; y: number; width: number; height: number }>): void;
  /** What it says now (the page asks when it loads). */
  message(): string;
  caught(sender: Electron.WebContents): void;
  /** The workbench closed: the robot goes with it. */
  destroy(): void;
}

// Retain the old IPC contract without creating windows, timers or polling the cursor.
// Old renderers can still send amo:bot-fly during an upgrade; they must never restore the retired animation.
export function setupBotFlight(options: BotFlightOptions): BotFlightControl {
  if (options.testMode) (globalThis as { __amoBotFlight?: unknown }).__amoBotFlight = { flying: false, message: "" };
  return { fly() {}, land() {}, setShape() {}, message: () => "", caught() {}, destroy() {} };
}
