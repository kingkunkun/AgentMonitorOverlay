export function CompanyIcon({ kind }: { kind: "rooms" | "agents" | "org" }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "rooms" ? <><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h6" /></> : kind === "agents" ? <><rect x="4" y="6" width="16" height="14" rx="4" /><path d="M12 3v3M8 16h8M2 11v4M22 11v4" /><circle cx="8.5" cy="11" r=".7" /><circle cx="15.5" cy="11" r=".7" /></> : <><rect x="9" y="2" width="6" height="5" rx="1" /><rect x="2" y="17" width="6" height="5" rx="1" /><rect x="16" y="17" width="6" height="5" rx="1" /><path d="M12 7v5M5 17v-5h14v5" /></>}
  </svg>;
}
