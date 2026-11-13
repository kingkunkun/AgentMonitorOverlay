import type { SessionStatus } from "@amo-studio/protocol";
import { SESSION_LOOK } from "./status.js";

export function RunIndicator({ status }: { status: SessionStatus | null }) {
  if (!status || status === "idle" || status === "completed") return null;
  const look = SESSION_LOOK[status];
  return <span className={status === "running" ? "run-indicator spinning" : "run-indicator"} role="img" aria-label={look.label} title={look.label} style={{ color: look.dot }}>
    {status === "running" ? <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" opacity=".2" /><path d="M8 2a6 6 0 0 1 6 6" /></svg> : <span className="run-status-dot" />}
  </span>;
}
