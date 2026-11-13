import type { CompanyMessage, CompanyMessagePage } from "@amo-studio/protocol";
import { mergeMessages } from "./logic.js";

export interface CompanyHistoryState { messages: CompanyMessage[]; loaded: boolean; hasMore: boolean; loadingMore: boolean; error: string }
export const emptyHistory = (): CompanyHistoryState => ({ messages: [], loaded: false, hasMore: false, loadingMore: false, error: "" });

/** One room's requests stay with that room, including requests still in flight when its view is closed. */
export function companyHistory(loadPage: (before?: string) => Promise<CompanyMessagePage>, onChange: (state: CompanyHistoryState) => void) {
  let state = emptyHistory(), live = true, epoch = 0, latest = 0, paged = false;
  const update = (patch: Partial<CompanyHistoryState>) => { if (live) { state = { ...state, ...patch }; onChange(state); } };
  const error = (e: unknown) => e instanceof Error ? e.message : String(e);
  const refresh = async (reset = false) => {
    if (!live) return;
    if (reset) { ++epoch; paged = false; update({ loadingMore: false }); }
    const request = ++latest;
    try {
      const page = await loadPage();
      if (!live || request !== latest) return;
      // A reconnect can miss more than a page. Start again at the newest page rather than conceal a gap.
      const gap = state.messages.length > 0 && page.messages.length > 0 && !page.messages.some((m) => state.messages.some((seen) => seen.id === m.id));
      if (reset || gap) { ++epoch; paged = false; }
      update({ messages: reset || gap ? page.messages : mergeMessages(state.messages, page.messages), loaded: true, hasMore: paged ? state.hasMore : page.hasMore, ...(reset || gap ? { loadingMore: false } : {}), error: "" });
    } catch (e) { if (live && request === latest) update({ error: error(e), loaded: true }); }
  };
  return {
    refresh,
    async loadOlder() {
      if (!live || state.loadingMore || !state.hasMore || !state.messages[0]) return;
      const mine = epoch, before = state.messages[0].id;
      update({ loadingMore: true });
      try {
        const page = await loadPage(before);
        if (!live || mine !== epoch) return;
        paged = true;
        update({ messages: mergeMessages(page.messages, state.messages), hasMore: page.hasMore, error: "" });
      } catch (e) { if (live && mine === epoch) update({ error: error(e) }); }
      finally { if (live && mine === epoch) update({ loadingMore: false }); }
    },
    add(message: CompanyMessage) {
      if (!live) return;
      ++latest;
      update({ messages: mergeMessages(state.messages, [message]) });
      // A dispatch response can race a delivery event. Re-read the server's final state after accepting it.
      void refresh();
    },
    stop() { live = false; ++epoch; ++latest; },
  };
}
