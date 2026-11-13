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
  model?: string | null;
  autonomous?: boolean;
  allowEvolution?: boolean;
  instructionsVersion?: number;
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

export type CompanyAgentInput = Partial<Pick<CompanyAgent, "name" | "role" | "managerId" | "description" | "instructions" | "profileId" | "workspaceId" | "taskId" | "sessionId" | "machine" | "enabled" | "model" | "autonomous" | "allowEvolution">> & { expectedInstructionsVersion?: number };
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
  /** Host-created work report receipt; clients cannot set it through group send. */
  workId?: Id;
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

export type CompanyWorkPriority = "low" | "medium" | "high";
export type CompanyWorkStatus = "queued" | "dispatching" | "running" | "blocked" | "done" | "cancelled";
/** A picture or file handed over with the objective; agents read it by its local path. */
export interface CompanyWorkAttachment { id: Id; name: string; mime: string; size: number; path: string }
export interface CompanyWork {
  id: Id;
  title: string;
  description: string;
  acceptance: string;
  priority: CompanyWorkPriority;
  agentId: Id;
  roomId: Id;
  status: CompanyWorkStatus;
  report: string;
  messageId: Id | null;
  attempt: number;
  handoffs: number;
  createdAt: string;
  updatedAt: string;
  clientId: string;
  manualStart?: boolean;
  outcomeUnknown?: boolean;
  /** Pictures and files sent along with the objective; the dispatch lists each path. */
  attachments?: CompanyWorkAttachment[];
  /** `agent`: the Agent's own bound conversation (default). `new`: a fresh chat task for this work. */
  sessionMode?: "agent" | "new";
}
export interface CompanyWorkInput { title: string; description?: string; acceptance?: string; priority: CompanyWorkPriority; agentId: Id; roomId: Id; clientId: string; attachments?: CompanyWorkAttachment[]; sessionMode?: "agent" | "new" }
export interface CompanyWorkUpdate { title?: string; description?: string; acceptance?: string; priority?: CompanyWorkPriority; agentId?: Id; attachments?: CompanyWorkAttachment[]; sessionMode?: "agent" | "new" }
export interface CompanyWorkAction { action: "start" | "retry" | "cancel"; confirmUnknown?: boolean }
export interface CompanyWorkReport { action: "progress" | "done" | "blocked" | "handoff"; report: string; agentId?: Id; clientMessageId: string }
export interface CompanyEvolution { id: Id; agentId: Id; before: string; after: string; version: number; reason: string; workId: Id | null; actorId: Id; createdAt: string }
export interface CompanyEvolutionInput { workId: Id; instructions: string; reason: string; expectedVersion: number }

export interface CompanyRoutes {
  "GET /api/company": { req: void; res: CompanySnapshot };
  "POST /api/company/agents": { req: CompanyAgentInput; res: CompanyAgent };
  "PUT /api/company/agents/:id": { req: CompanyAgentInput; res: CompanyAgent };
  "POST /api/company/rooms": { req: CompanyRoomInput; res: CompanyRoom };
  "PATCH /api/company/rooms/:id": { req: Partial<CompanyRoomInput>; res: CompanyRoom };
  "GET /api/company/rooms/:id/messages": { req: void; res: CompanyMessagePage };
  "POST /api/company/rooms/:id/messages": { req: CompanyMessageInput; res: CompanyMessage };
  "POST /api/company/rooms/:id/messages/:messageId/retry": { req: { agentId: Id; confirmUnknown?: boolean }; res: CompanyMessage };
  "GET /api/company/work": { req: void; res: CompanyWork[] };
  "POST /api/company/work": { req: CompanyWorkInput; res: CompanyWork };
  "PATCH /api/company/work/:id": { req: CompanyWorkUpdate; res: CompanyWork };
  "POST /api/company/work/:id/action": { req: CompanyWorkAction; res: CompanyWork };
  "GET /api/company/agents/:id/evolution": { req: void; res: CompanyEvolution[] };
  "POST /api/company/agents/:id/evolution/:revisionId/rollback": { req: { expectedVersion: number }; res: CompanyAgent };
}

/** Explicit local one-time handoff; no runtime ever searches native conversation directories. */
export interface CompanyBootstrap {
  version: 1;
  agents: Array<{
    id: Id;
    name?: string;
    profileId?: Id;
    workspaceId?: Id;
    model?: string;
    matchTaskId?: Id;
    matchSessionId?: Id;
    archives?: CompanyArchive[];
  }>;
}
