import { useEffect, useState } from "react";
import { readStored, writeStored } from "../lib/stored.js";
import { QUICK_FILTERS, type QuickFilter } from "./timeline.js";

// 按专题分组 (2026-10-19): the board's columns hold their cards under their topics, the ones in none last. On unless
// turned off on the board; stored per install.

const GROUP_KEY = "amo.boardGroupTopics";
const GROUP_EVENT = "amo:board-group-topics";

export const groupByTopic = (): boolean => readStored(GROUP_KEY) !== "off";

export function setGroupByTopic(on: boolean): void {
  writeStored(GROUP_KEY, on ? "on" : "off");
  window.dispatchEvent(new CustomEvent(GROUP_EVENT, { detail: on }));
}

/** Whether the board groups by topic, following changes made in this window or another (storage event). */
export function useGroupByTopic(): boolean {
  const [on, setOn] = useState(groupByTopic);
  useEffect(() => {
    const local = (e: Event) => setOn((e as CustomEvent<boolean>).detail);
    const other = (e: StorageEvent) => e.key === GROUP_KEY && setOn(groupByTopic());
    window.addEventListener(GROUP_EVENT, local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(GROUP_EVENT, local);
      window.removeEventListener("storage", other);
    };
  }, []);
  return on;
}

// 看板时间线 (2026-11-23, plans/board-timeline.md): how the board shows tasks, which folder it shows and the quick
// filter, kept per install. The event name is `amo:pref:` and the key, so a test can set one and tell the window.

interface StoredChoice<T extends string> {
  key: string;
  read(): T;
}

const prefEvent = (key: string) => `amo:pref:${key}`;

function setChoice<T extends string>(choice: StoredChoice<T>, value: T): void {
  writeStored(choice.key, value);
  window.dispatchEvent(new Event(prefEvent(choice.key)));
}

function useChoice<T extends string>(choice: StoredChoice<T>): T {
  const [value, setValue] = useState(choice.read);
  useEffect(() => {
    const local = () => setValue(choice.read());
    const other = (e: StorageEvent) => (e.key === choice.key || e.key === null) && setValue(choice.read());
    window.addEventListener(prefEvent(choice.key), local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(prefEvent(choice.key), local);
      window.removeEventListener("storage", other);
    };
  }, [choice]);
  return value;
}

/** 时间线: every task in one list, newest first (the default); 分列: the four columns. */
export type BoardMode = "timeline" | "columns";
const MODE: StoredChoice<BoardMode> = { key: "amo.boardMode", read: () => (readStored("amo.boardMode") === "columns" ? "columns" : "timeline") };
export const setBoardMode = (mode: BoardMode): void => setChoice(MODE, mode);
export const useBoardMode = (): BoardMode => useChoice(MODE);

/** The folder the board shows: "all", or a folder's key (timeline.folderOf). */
const FOLDER: StoredChoice<string> = { key: "amo.boardFolder", read: () => readStored("amo.boardFolder") || "all" };
export const setBoardFolder = (key: string): void => setChoice(FOLDER, key);
export const useBoardFolder = (): string => useChoice(FOLDER);

const FILTER: StoredChoice<QuickFilter> = {
  key: "amo.boardFilter",
  read: () => {
    const v = readStored("amo.boardFilter");
    return QUICK_FILTERS.find((f) => f === v) ?? "all";
  },
};
export const setBoardFilter = (filter: QuickFilter): void => setChoice(FILTER, filter);
export const useBoardFilter = (): QuickFilter => useChoice(FILTER);
