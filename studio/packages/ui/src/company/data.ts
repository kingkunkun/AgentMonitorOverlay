import { useEffect, useRef, useState } from "react";
import type { CompanyMessage, CompanySnapshot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { useLiveResource } from "../host/live.js";
import { companyHistory, emptyHistory } from "./history.js";

export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
export function useCompany(link: HostLink) {
  const [error, setError] = useState("");
  const [snapshot, setSnapshot, reload] = useLiveResource<CompanySnapshot | null>({ initial: null, load: async () => { const data = await call(link, "GET /api/company"); setError(""); return data; }, reloadOn: (e) => e.type === "company.changed", reloadDelay: 150, onError: (e) => setError(errorText(e)), reset: true }, [link.url, link.token]);
  return { snapshot, setSnapshot, reload, error };
}

export function useCompanyMessages(link: HostLink, roomId: string) {
  const [state, setState] = useState(emptyHistory);
  const controller = useRef<ReturnType<typeof companyHistory> | null>(null);
  useEffect(() => {
    setState(emptyHistory());
    const history = companyHistory((before) => call(link, "GET /api/company/rooms/:id/messages", { id: roomId }, undefined, { limit: "50", ...(before ? { before } : {}) }), setState);
    controller.current = history;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onHostEvent((e) => { if (e.type === "company.changed") { if (timer) clearTimeout(timer); timer = setTimeout(() => void history.refresh(), 150); } });
    const reconnect = onHostReconnect(() => void history.refresh(true));
    void history.refresh();
    return () => { history.stop(); if (timer) clearTimeout(timer); off(); reconnect(); if (controller.current === history) controller.current = null; };
  }, [link.url, link.token, roomId]);
  return { ...state, loadOlder: async () => { await controller.current?.loadOlder(); }, reload: () => void controller.current?.refresh(), add: (message: CompanyMessage) => controller.current?.add(message) };
}
