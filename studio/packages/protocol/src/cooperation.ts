// This fork keeps existing bookmark data but disables the feature at every entry point.
export const BOOKMARKS_ENABLED: boolean = false;
export interface TransferRequest { id: string; taskId: string; peer: string; path: string; createdAt: string }
export interface CooperationState {
  account: { name: string; server: string } | null;
  recentServers: string[];
  relayEnabled: boolean;
  remoteEnabled: boolean;
  syncOwnDevices: boolean;
  server: { running: boolean; lan: boolean; port: number | null; addresses: string[]; invite: string; error: string | null };
  transfers: TransferRequest[];
}
export interface CooperationRoutes {
  "PUT /api/cooperation/own-devices": { req: { enabled: boolean }; res: CooperationState };
  "GET /api/cooperation": { req: never; res: CooperationState };
  "POST /api/cooperation/account": { req: { action: "login" | "register"; server: string; name: string; password: string; passphrase?: string }; res: CooperationState };
  "POST /api/cooperation/logout": { req: never; res: CooperationState };
  "POST /api/cooperation/off": { req: never; res: CooperationState };
  "PUT /api/cooperation/relay": { req: { enabled: boolean }; res: CooperationState };
  "PUT /api/cooperation/server": { req: { enabled: boolean; lan?: boolean }; res: CooperationState };
  "POST /api/cooperation/transfers/:id": { req: { allow: boolean }; res: CooperationState };
}
