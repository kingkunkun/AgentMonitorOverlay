import { inTurn, type Id, type Session, type SessionItem } from "@amo-studio/protocol";
import { newId, type SessionItemInput } from "../../store/store.js";
import { Feature, type FeatureHost } from "../../core/feature.js";
import type { SessionsFeature } from "./service.js";
import { HostError, isRemoteCopy } from "../../core/shared.js";

// 会话收件箱 (2026-11-04, plans/done/message-delivery.md): messages from agents and from Studio itself — a 中转 reply, 值守
// going on in a session, 传话 (task_message), a forwarded mail, session_send, session_start's report — go into the
// conversation at once as a row `delivery: "held"` (「等这一轮结束后送进去」) and are sent once the session is free: not in
// a turn, not waiting on the person, not handed to a terminal. Before, each place called sendMessage as the person's
// messages do: steered into a Codex turn mid-step, queued in memory only for DSH (and lost on an error), and a 中转
// reply that could not go in was lost after the relay had marked it taken. Only session_send waited, in its own kv.
//
// The row is the message (the store keeps it); kv `sessions.inbox` lists the sessions that have some, so a Host
// restart goes on sending. One that cannot go in becomes 没送到 with a line saying why (重新发送 tries again); an
// archived session's become 没送到 too. A copy of a remote session is not held here: its rows are the other computer's.

const INBOX_KEY = "sessions.inbox";
/** session_send's queue before the inbox (2026-11-01..11-04): session id → texts. Moved into the inbox at start. */
const PEER_QUEUE_KEY = "sessions.peer-queue";
/** How long the next held message waits for the turn the first one started to show (see deliver). */
const TURN_SEEN_MS = 3000;
const COMPANY_ACTIVE_KEY = "sessions.company-active";
type CompanyActive = { itemId: Id; seq: number; observed: boolean };
type InboxDelivery = { itemId: Id; state: "sending" | "delivered" | "failed" | "unknown"; error?: string };

export class SessionInbox extends Feature {
  /** Resolve an Agent's selected model only when its held company job is about to enter a new turn. */
  prepareCompany?: (sessionId: Id, itemId: Id) => Promise<void>;
  private companyActiveCache: Record<Id, CompanyActive> | null = null;
  private deliveryListeners = new Set<(event: InboxDelivery) => void>();

  /** Internal callbacks only, never the public Host/remote event stream. Success means the runtime call acknowledged. */
  onDelivery(listener: (event: InboxDelivery) => void): () => void { this.deliveryListeners.add(listener); return () => { this.deliveryListeners.delete(listener); }; }
  private delivery(event: InboxDelivery): void { for (const listener of this.deliveryListeners) listener(event); }
  private companyActive(): Record<Id, CompanyActive> {
    if (!this.companyActiveCache) {
      try { this.companyActiveCache = JSON.parse(this.store.getKv(COMPANY_ACTIVE_KEY)?.value ?? "{}"); } catch { this.companyActiveCache = {}; }
    }
    return this.companyActiveCache!;
  }
  private rememberCompany(): void { this.store.setKv(COMPANY_ACTIVE_KEY, JSON.stringify(this.companyActive())); }
  companyBusy(sessionId: Id): boolean { return !!this.companyActive()[sessionId]; }
  /** Only an explicit, checked retry releases a job whose native outcome was unknown. */
  releaseCompany(itemId: Id): void {
    for (const [id, entry] of Object.entries(this.companyActive())) if (entry.itemId === itemId) delete this.companyActive()[id];
    this.rememberCompany();
  }
  private settleCompany(s: Session): void {
    const entry = this.companyActive()[s.id]; if (!entry) return;
    if (inTurn(s.status)) { if (!entry.observed) { entry.observed = true; this.rememberCompany(); } return; }
    const [turn] = this.store.findItems(s.id, "turn", {}, { newest: true, limit: 1 });
    if (entry.observed || (turn && turn.seq > entry.seq && turn.type === "turn" && turn.state !== "running")) { delete this.companyActive()[s.id]; this.rememberCompany(); }
  }
  constructor(
    host: FeatureHost,
    /** The feature the inbox is part of (it sends through it). */
    private readonly sessions: SessionsFeature,
  ) {
    super(host);
  }

  private known: Set<Id> | null = null;
  /** One delivery at a time per session; `again`: something came meanwhile, look once more after it. */
  private readonly flushing = new Map<Id, Promise<void>>();
  private readonly again = new Set<Id>();
  /** Of `again`: the look once more is the person's message ending a pause (withTurn), not to be lost behind a running delivery. */
  private readonly againWithTurn = new Set<Id>();
  /**
   * Sessions the person stopped (2026-11-04, the user): what is held waits for their next message, and goes in with it,
   * or for 立即发送 — a session stopped on purpose is not started again by a reply arriving. Until the Host restarts.
   */
  private readonly paused = new Set<Id>();
  /** Paused sessions already told so in a notice. */
  private readonly told = new Set<Id>();

  /** 停止 by the person: hold what comes until they write again. */
  pause(sessionId: Id): void {
    this.paused.add(sessionId);
    this.told.delete(sessionId);
    if (this.held(sessionId).length) this.tellPaused(sessionId);
  }

  /** The person wrote again: what is held goes in now, with their message (queued or steered as theirs would be). */
  resume(sessionId: Id): void {
    if (!this.paused.delete(sessionId)) return;
    this.told.delete(sessionId);
    void this.flush(sessionId, true).catch(() => undefined);
  }

  private tellPaused(sessionId: Id): void {
    const s = this.store.getSession(sessionId);
    if (!s || this.told.has(sessionId)) return;
    this.told.add(sessionId);
    const message = "你停下了这个会话：别的会话、中转、值守发来的消息先不送进去，等你发下一条消息时，排在它后面一起送进去；想现在送就点它旁边的「立即发送」。";
    this.publish({ type: "item.appended", item: this.store.appendItem(this.row(s, { type: "notice", level: "info", message }, "inbox/paused")) });
  }

  /**
   * A message from an agent or from Studio into `sessionId`: shown at once, sent now when the session is free, else
   * when it is. `delivered`: it went in now; `waiting`: how many of the session's are still held.
   */
  async put(sessionId: Id, text: string, options: { onQueued?: (itemId: Id) => void; separateTurn?: boolean } = {}): Promise<{ delivered: boolean; waiting: number; itemId?: Id }> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt || s.writer === "archived") throw new HostError("read_only", "这个会话已归档，不能再往里发消息");
    if (s.kind === "sub") throw new HostError("read_only", "子 agent 不能单独接收消息");
    if (!text.trim()) throw new HostError("bad_request", "text is required");
    if (isRemoteCopy(s)) {
      await this.sessions.sendMessage(sessionId, text);
      return { delivered: true, waiting: 0 };
    }
    const role = this.sessions.roleUpdate(sessionId);
    // Company delivery records share this transaction, so a crash cannot lose the association and resend the work.
    const item = this.store.transaction(() => {
      const row = this.append(s, this.sessions.withRole(text, role.lines), options.separateTurn ? "user/company-inbox" : "user/inbox");
      options.onQueued?.(row.id);
      role.told();
      this.remember(sessionId);
      return row;
    });
    if (this.paused.has(sessionId)) this.tellPaused(sessionId);
    await this.flush(sessionId);
    const now = this.store.getItem(item.id);
    return { delivered: !(now?.type === "user" && now.delivery === "held"), waiting: this.held(sessionId).length, itemId: item.id };
  }

  /** 立即发送 on a held row: it goes now — into the running turn as the person's would, which then gives way to it. */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.sessionId !== sessionId || item.delivery !== "held") return;
    const rt = this.runtime;
    if (!rt.resend) throw new HostError("bad_request", "this Host cannot send a held message");
    await this.wrap(() => rt.resend!(sessionId, itemId, [], { now: true }));
  }

  /** Watches sessions get free; sends what the last Host left held, and moves session_send's old queue in. */
  watch(): void {
    this.migratePeerQueue();
    this.host.on("event", (e) => {
      if (e.type === "session.upserted") {
        this.settleCompany(e.session);
        if (this.ids().has(e.session.id)) void this.flush(e.session.id).catch(() => undefined);
      }
    });
    for (const id of Object.keys(this.companyActive())) { const s = this.store.getSession(id); if (s) this.settleCompany(s); }
    for (const id of this.ids()) void this.flush(id).catch(() => undefined);
  }

  /** The session's held rows, oldest first. */
  held(sessionId: Id): SessionItem[] {
    return this.store.findItems(sessionId, "user", { delivery: "held" });
  }

  /** `withTurn`: also into a turn already running (the person's message that ended a pause). */
  flush(sessionId: Id, withTurn = false): Promise<void> {
    const running = this.flushing.get(sessionId);
    if (running) {
      this.again.add(sessionId);
      if (withTurn) this.againWithTurn.add(sessionId);
      return running;
    }
    const p = this.deliver(sessionId, withTurn).finally(() => {
      this.flushing.delete(sessionId);
      const turn = this.againWithTurn.delete(sessionId);
      if (this.again.delete(sessionId)) void this.flush(sessionId, turn).catch(() => undefined);
    });
    this.flushing.set(sessionId, p);
    return p;
  }

  private async deliver(sessionId: Id, withTurn = false): Promise<void> {
    const s = this.store.getSession(sessionId);
    const held = s ? this.held(sessionId) : [];
    if (!s || !held.length) return this.forget(sessionId);
    if (s.archivedAt || s.writer === "archived") {
      for (const it of held) this.mark(it.id, "unsent");
      return this.forget(sessionId);
    }
    if (this.paused.has(sessionId)) return;
    if (this.companyActive()[sessionId]) return;
    if (!free(s) && !(withTurn && s.status === "running" && writable(s))) return;
    // Behind the person's message (2026-11-08): marked so the row says it goes in by itself (see `withPerson`). Not by
    // status: a Codex session shows `running` only once turn/started comes back, after the person's send has returned.
    const behindPerson = withTurn;
    const rt = this.runtime;
    // The first starts a turn; the others follow it at once (queued at the CLI, steered in, or DSH's next turn) — once
    // the turn is seen to run: Codex tells it (turn/started) only after its turn/start, and a second turn/start before
    // that would not be a steer.
    let before: number | null = null;
    let startedCompany = false;
    for (const it of held) {
      const current = this.store.getItem(it.id);
      if (current?.type !== "user" || current.delivery !== "held") continue;
      // Company assignments are separate jobs. A second job waits for the turn just started to finish, even when
      // generic inbox messages would normally be steered into that new turn together.
      if (before !== null && (startedCompany || current.raw?.method === "user/company-inbox")) break;
      if (current.raw?.method === "user/company-inbox" && inTurn(this.store.getSession(sessionId)?.status ?? "idle")) break;
      if (before !== null) await this.turnSeen(sessionId, before);
      before = current.seq;
      startedCompany = current.raw?.method === "user/company-inbox";
      try {
        if (!rt.resend) throw Object.assign(new Error("this Host cannot send a held message"), { deliveryNotAttempted: true });
        if (startedCompany && this.prepareCompany) {
          try { await this.prepareCompany(sessionId, current.id); }
          catch (err) { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { deliveryNotAttempted: true }); }
        }
        // Model discovery can await I/O. A human may start a turn or stop the session during that wait.
        if (startedCompany && (!free(this.requireSession(sessionId)) || this.paused.has(sessionId))) break;
        this.store.transaction(() => {
          if (startedCompany) { this.companyActive()[sessionId] = { itemId: current.id, seq: current.seq, observed: false }; this.rememberCompany(); }
          this.delivery({ itemId: current.id, state: "sending" });
        });
        // Set before sending: the runtime keeps the item's other fields when it changes its delivery.
        if (behindPerson) this.publish({ type: "item.updated", item: this.store.replaceItem({ ...current, withPerson: true }) });
        await rt.resend(sessionId, it.id, []);
        this.delivery({ itemId: current.id, state: "delivered" });
      } catch (err) {
        this.mark(it.id, "unsent");
        const why = err instanceof Error ? err.message : String(err);
        const notAttempted = !!(err && typeof err === "object" && "deliveryNotAttempted" in err && err.deliveryNotAttempted);
        if (startedCompany && notAttempted) this.releaseCompany(current.id);
        this.delivery({ itemId: current.id, state: notAttempted ? "failed" : "unknown", error: why });
        this.publish({ type: "item.appended", item: this.store.appendItem(this.row(s, { type: "notice", level: "warning", message: `这条消息没能送进会话：${why}。可以点它下面的「重新发送」再试。` }, "inbox/failed")) });
      }
    }
    if (!this.held(sessionId).length) this.forget(sessionId);
  }

  /**
   * Until the turn the message at `afterSeq` started shows: the session in a turn, or a turn row after the message (a
   * short turn may be over already) — or TURN_SEEN_MS passed (none started).
   */
  private async turnSeen(sessionId: Id, afterSeq: number): Promise<void> {
    const end = Date.now() + TURN_SEEN_MS;
    while (Date.now() < end) {
      const s = this.store.getSession(sessionId);
      if (!s || inTurn(s.status)) return;
      const [turn] = this.store.findItems(sessionId, "turn", {}, { newest: true, limit: 1 });
      if (turn && turn.seq > afterSeq) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private append(s: Session, text: string, method = "user/inbox"): SessionItem {
    const item = this.store.appendItem(this.row(s, { type: "user", text, delivery: "held" }, method));
    this.publish({ type: "item.appended", item });
    return item;
  }

  /** A row of Studio's own in the session; in the turn running now, if one is (the transcript groups rows by turn). */
  private row(s: Session, body: Record<string, unknown>, method: string): SessionItemInput {
    const [turn] = this.store.findItems(s.id, "turn", { state: "running" }, { newest: true, limit: 1 });
    const turnId = turn?.type === "turn" ? turn.turnId : undefined;
    return { ...body, id: newId("i"), sessionId: s.id, createdAt: new Date().toISOString(), raw: { runtime: s.runtime, method, ...(turnId ? { turnId } : {}) } } as SessionItemInput;
  }

  private mark(itemId: Id, delivery: "unsent"): void {
    const it = this.store.getItem(itemId);
    if (it?.type !== "user" || it.delivery !== "held") return;
    this.publish({ type: "item.updated", item: this.store.replaceItem({ ...it, delivery }) });
  }

  private ids(): Set<Id> {
    if (!this.known) {
      try {
        const list = JSON.parse(this.store.getKv(INBOX_KEY)?.value ?? "[]") as unknown;
        this.known = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
      } catch {
        this.known = new Set();
      }
    }
    return this.known;
  }

  private remember(sessionId: Id): void {
    const ids = this.ids();
    if (ids.has(sessionId)) return;
    ids.add(sessionId);
    this.store.setKv(INBOX_KEY, JSON.stringify([...ids]));
  }

  private forget(sessionId: Id): void {
    const ids = this.ids();
    if (!ids.delete(sessionId)) return;
    this.store.setKv(INBOX_KEY, JSON.stringify([...ids]));
  }

  /** session_send's own queue (kv `sessions.peer-queue`), left by a Host before the inbox: its texts become held rows. */
  private migratePeerQueue(): void {
    const kv = this.store.getKv(PEER_QUEUE_KEY);
    if (!kv?.value) return;
    let queue: Record<Id, string[]> = {};
    try {
      queue = JSON.parse(kv.value) as Record<Id, string[]>;
    } catch {
      // Unreadable: nothing to move.
    }
    for (const [sessionId, texts] of Object.entries(queue)) {
      const s = this.store.getSession(sessionId);
      if (!s || s.archivedAt || !Array.isArray(texts)) continue;
      for (const text of texts) if (typeof text === "string" && text.trim()) this.append(s, text);
      this.remember(sessionId);
    }
    this.store.setKv(PEER_QUEUE_KEY, "");
  }
}

/** Free for a message of an agent's: not in a turn or waiting on the person, and Studio may write to it. */
function free(s: Session): boolean {
  return !inTurn(s.status) && writable(s);
}

function writable(s: Session): boolean {
  return s.writer === "workbench" || s.writer === "terminal-shared";
}
