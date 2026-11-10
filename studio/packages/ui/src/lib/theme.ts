import { readStored, writeStored } from "./stored.js";

// UI theme: Codex (default), light, dark, or following the system. Stored per install (this window profile's localStorage, which the
// workbench and Focus windows share); applied as data-theme on <html>, which app.css reads.

export type ThemePref = "codex" | "system" | "light" | "dark";

const KEY = "amo.theme.v2";

export function themePref(): ThemePref {
  const v = readStored(KEY);
  return v === "light" || v === "dark" || v === "system" || v === "codex" ? v : "codex";
}

export function applyTheme(pref: ThemePref = themePref()): void {
  if (pref === "codex") document.documentElement.dataset.appearance = "codex";
  else delete document.documentElement.dataset.appearance;
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref === "codex" ? "light" : pref;
}

export function setThemePref(pref: ThemePref): void {
  writeStored(KEY, pref);
  applyTheme(pref);
}

/** Keeps a window in step when another window (workbench ↔ Focus) changes the theme. */
export function followThemeChanges(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) applyTheme();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export const THEME_LABELS: Record<ThemePref, string> = { codex: "Codex（默认）", system: "跟随系统", light: "浅色", dark: "深色" };
