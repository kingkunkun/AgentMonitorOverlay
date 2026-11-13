import type { Id } from "./entities.js";

/** Local company identities outlive any one model conversation. Never included in task/phone sharing. */
export interface CompanyArchive {
  id: Id;
  title: string;
  source: "workstudio" | "codex";
  manifestPath: string;
  transcriptPath: string;
  messageCount: number;
  sha256: string;
  localOnly: true;
}

export type CompanyAgentStatus = "human" | "disabled" | "unconfigured" | "ready" | "running" | "waiting" | "error";
export interface CompanyAgent {
  id: Id;
  name: string;
  role: string;
  kind: "human" | "agent";
  managerId: Id | null;
  description: string;
  instructions: string;
  profileId: Id | null;
  workspaceId: Id | null;
  taskId: Id | null;
  sessionId: Id | null;
  /** Display/documentation only. It is never interpreted as a shell command or a connection target. */
  machine: { label: string; address: string; capacity: "high" | "low" | "other" } | null;
  /** One conversation at a time; incoming work waits behind an existing turn. */
  concurrency: 1;
  enabled: boolean;
  archives: CompanyArchive[];
  status: CompanyAgentStatus;
  createdAt: string;
  updatedAt: string;
}

export type CompanyAgentInput = Partial<Pick<CompanyAgent, "name" | "role" | "managerId" | "description" | "instructions" | "profileId" | "workspaceId" | "taskId" | "sessionId" | "machine" | "enabled">>;
export interface CompanyRoom {
  id: Id;
  name: string;
  description: string;
  memberIds: Id[];
  createdAt: string;
  updatedAt: string;
}
export type CompanyRoomInput = Pick<CompanyRoom, "name" | "memberIds"> & Partial<Pick<CompanyRoom, "description">>;
export interface CompanyDelivery {
  agentId: Id;
  status: "pending" | "queued" | "sending" | "delivered" | "failed" | "unknown";
  sessionId: Id | null;
  taskId: Id | null;
  inboxItemId?: Id;
  error?: string;
}
export interface CompanyMessage {
  id: Id;
  roomId: Id;
  senderId: Id;
  text: string;
  mentions: Id[];
  replyTo: Id | null;
  clientMessageId: string;
  createdAt: string;
  /** Automatic agent chains are capped; a new human message starts at zero. */
  hop: number;
  deliveries: CompanyDelivery[];
}
export interface CompanyMessageInput {
  text: string;
  mentions?: Id[];
  replyTo?: Id | null;
  clientMessageId: string;
}
export interface CompanyMessagePage { messages: CompanyMessage[]; hasMore: boolean }
export interface CompanySnapshot { agents: CompanyAgent[]; rooms: CompanyRoom[]; bootstrapWarnings?: string[] }

export interface CompanyRoutes {
  "GET /api/company": { req: void; res: CompanySnapshot };
  "POST /api/company/agents": { req: CompanyAgentInput; res: CompanyAgent };
  "PUT /api/company/agents/:id": { req: CompanyAgentInput; res: CompanyAgent };
  "POST /api/company/rooms": { req: CompanyRoomInput; res: CompanyRoom };
  "PATCH /api/company/rooms/:id": { req: Partial<CompanyRoomInput>; res: CompanyRoom };
  "GET /api/company/rooms/:id/messages": { req: void; res: CompanyMessagePage };
  "POST /api/company/rooms/:id/messages": { req: CompanyMessageInput; res: CompanyMessage };
  "POST /api/company/rooms/:id/messages/:messageId/retry": { req: { agentId: Id; confirmUnknown?: boolean }; res: CompanyMessage };
}

/** Explicit local one-time handoff; no runtime ever searches native conversation directories. */
export interface CompanyBootstrap {
  version: 1;
  agents: Array<{
    id: Id;
    name?: string;
    profileId?: Id;
    workspaceId?: Id;
    matchTaskId?: Id;
    matchSessionId?: Id;
    archives?: CompanyArchive[];
  }>;
}
