import { useEffect, useState } from "react";
import { readStored, writeStored } from "./stored.js";
const KEY = "amo.topicsVisible";
const EVENT = "amo:topics-visible";
export const topicsVisible = (): boolean => readStored(KEY) === "1";
export function setTopicsVisible(on: boolean): void { writeStored(KEY, on ? "1" : "0"); window.dispatchEvent(new Event(EVENT)); }
export function useTopicsVisible(): boolean { const [on, setOn] = useState(topicsVisible); useEffect(() => { const read = () => setOn(topicsVisible()); window.addEventListener(EVENT, read); window.addEventListener("storage", read); return () => { window.removeEventListener(EVENT, read); window.removeEventListener("storage", read); }; }, []); return on; }
