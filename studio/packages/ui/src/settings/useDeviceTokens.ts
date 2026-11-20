import { useMemo, useSyncExternalStore } from "react";
import { TOKEN_STATS_REFRESH_MS, type TokenStats } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

type State = { stats: TokenStats | null; busy: boolean; error: string | null };
/** The footer and settings use the same snapshot and timer, including after a manual refresh. Memory only. */
function meter(link: HostLink) {
  let state: State = { stats: null, busy: false, error: null };
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const load = async (fresh: boolean) => {
    if (!link.url || state.busy) return;
    update({ busy: true, error: null });
    try { update({ stats: await call(link, "GET /api/stats/tokens", {}, undefined, fresh ? { refresh: "1" } : {}) }); }
    catch { update({ error: "本机用量读取失败，可在设置中重新统计。" }); }
    finally { update({ busy: false }); }
  };
  return {
    snapshot: () => state, refresh: () => { void load(true); },
    subscribe(fn: () => void) {
      listeners.add(fn);
      if (listeners.size === 1) {
        void load(false);
        timer = setInterval(() => void load(false), TOKEN_STATS_REFRESH_MS);
      }
      return () => { listeners.delete(fn); if (!listeners.size) clearInterval(timer); };
    },
  };
}
const meters = new WeakMap<HostLink, ReturnType<typeof meter>>();
export function useDeviceTokens(link: HostLink) {
  const m = useMemo(() => {
    let entry = meters.get(link);
    if (!entry) { entry = meter(link); meters.set(link, entry); }
    return entry;
  }, [link]);
  return { ...useSyncExternalStore(m.subscribe, m.snapshot, m.snapshot), refresh: m.refresh };
}
