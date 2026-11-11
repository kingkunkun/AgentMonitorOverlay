import { useEffect, useState } from "react";
import type { AccountUsage } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

/** Use cached account limits; a general subscription limit must never be labelled a Fast-only balance. */
export function FastUsageHint({ link, profileId }: { link: HostLink; profileId: string }) {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  useEffect(() => { let live = true; void call(link, "GET /api/usage").then((list) => { if (live) setUsage(list.find((u) => u.profileId === profileId && u.account?.current !== false) ?? null); }).catch(() => undefined); return () => { live = false; }; }, [link, profileId]);
  const fast = usage?.windows.filter((w) => /fast|加速/i.test(w.label)) ?? [];
  const windows = fast.length ? fast : usage?.windows ?? [];
  const known = windows.filter((w) => w.usedPercent !== null);
  return <div className="fast-usage-hint" data-testid="fast-usage-hint">
    <b>Fast 用量提示</b>
    <span>Fast 可能更快消耗额度或额外计费，以当前渠道规则为准。</span>
    {known.length > 0 && <span>{fast.length ? "Fast 剩余" : "当前账号剩余"}：{known.map((w) => `${w.label} ${Math.max(0, Math.round(100 - w.usedPercent!))}%`).join(" · ")}</span>}
    {!fast.length && <span>当前渠道未提供独立的 Fast 剩余额度。</span>}
  </div>;
}
