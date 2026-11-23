import { useEffect, useState } from "react";
import { readStored, writeStored } from "./stored.js";

// 左下角「本机总 Token 用量」的数值默认显示成 ***（2026-11-23，用户要求），在 设置 → 界面 里打开后才显示真实数值。
const KEY = "amo.deviceTokenVisible";
const EVENT = "amo:device-token-visible";
export const deviceTokenVisible = (): boolean => readStored(KEY) === "1";
export function setDeviceTokenVisible(on: boolean): void { writeStored(KEY, on ? "1" : "0"); window.dispatchEvent(new Event(EVENT)); }
export function useDeviceTokenVisible(): boolean { const [on, setOn] = useState(deviceTokenVisible); useEffect(() => { const read = () => setOn(deviceTokenVisible()); window.addEventListener(EVENT, read); window.addEventListener("storage", read); return () => { window.removeEventListener(EVENT, read); window.removeEventListener("storage", read); }; }, []); return on; }
