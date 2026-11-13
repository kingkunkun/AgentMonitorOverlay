import type { CompanyAgent, CompanyEvolution, CompanyMessage, CompanyMessagePage, CompanyRoom, CompanyWork } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";

type Row = { body: string };
const decode = <T>(row: unknown): T | undefined => row ? JSON.parse((row as Row).body) as T : undefined;

/** The Host's existing SQLite writer owns these local-only tables. No separate connection or runtime process. */
export class CompanyRepository {
  constructor(private readonly store: Store) {}
  agents(): CompanyAgent[] { return this.store.db.prepare("SELECT body FROM company_agents ORDER BY rowid").all().map((r) => decode<CompanyAgent>(r)!); }
  agent(id: string): CompanyAgent | undefined { return decode(this.store.db.prepare("SELECT body FROM company_agents WHERE id = ?").get(id)); }
  putAgent(a: CompanyAgent): void { this.store.db.prepare("INSERT INTO company_agents(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(a.id, JSON.stringify(a)); }
  rooms(): CompanyRoom[] { return this.store.db.prepare("SELECT body FROM company_rooms ORDER BY rowid").all().map((r) => decode<CompanyRoom>(r)!); }
  room(id: string): CompanyRoom | undefined { return decode(this.store.db.prepare("SELECT body FROM company_rooms WHERE id = ?").get(id)); }
  putRoom(r: CompanyRoom): void { this.store.db.prepare("INSERT INTO company_rooms(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(r.id, JSON.stringify(r)); }
  message(id: string): CompanyMessage | undefined { return decode(this.store.db.prepare("SELECT body FROM company_messages WHERE id = ?").get(id)); }
  duplicate(roomId: string, senderId: string, key: string): CompanyMessage | undefined { return decode(this.store.db.prepare("SELECT body FROM company_messages WHERE room_id=? AND sender_id=? AND client_message_id=?").get(roomId, senderId, key)); }
  add(m: CompanyMessage): void { this.store.db.prepare("INSERT INTO company_messages(id,room_id,sender_id,client_message_id,body) VALUES (?,?,?,?,?)").run(m.id, m.roomId, m.senderId, m.clientMessageId, JSON.stringify(m)); }
  putMessage(m: CompanyMessage): void { this.store.db.prepare("UPDATE company_messages SET body=? WHERE id=?").run(JSON.stringify(m), m.id); }
  page(roomId: string, before: string | undefined, limit: number): CompanyMessagePage {
    const rows = before
      ? this.store.db.prepare("SELECT body FROM company_messages WHERE room_id=? AND seq < (SELECT seq FROM company_messages WHERE id=? AND room_id=?) ORDER BY seq DESC LIMIT ?").all(roomId, before, roomId, limit + 1)
      : this.store.db.prepare("SELECT body FROM company_messages WHERE room_id=? ORDER BY seq DESC LIMIT ?").all(roomId, limit + 1);
    return { messages: rows.slice(0, limit).reverse().map((r) => decode<CompanyMessage>(r)!), hasMore: rows.length > limit };
  }
  forInboxItem(itemId: string): CompanyMessage[] {
    return this.store.db.prepare("SELECT body FROM company_messages WHERE EXISTS (SELECT 1 FROM json_each(body, '$.deliveries') WHERE json_extract(value, '$.inboxItemId') = ?)").all(itemId).map((r) => decode<CompanyMessage>(r)!);
  }
  unsettled(): CompanyMessage[] {
    return this.store.db.prepare("SELECT body FROM company_messages WHERE EXISTS (SELECT 1 FROM json_each(body, '$.deliveries') WHERE json_extract(value, '$.status') IN ('pending', 'queued', 'sending'))").all().map((r) => decode<CompanyMessage>(r)!);
  }
  hasOutstanding(agentId: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM company_messages WHERE EXISTS (SELECT 1 FROM json_each(body, '$.deliveries') WHERE json_extract(value, '$.agentId') = ? AND json_extract(value, '$.status') IN ('pending', 'queued', 'sending', 'unknown')) LIMIT 1").get(agentId);
  }
  replies(parentId: string, senderId: string): CompanyMessage[] {
    return this.store.db.prepare("SELECT body FROM company_messages WHERE sender_id=? AND json_extract(body, '$.replyTo')=?").all(senderId, parentId).map((r) => decode<CompanyMessage>(r)!);
  }
  work(id: string): CompanyWork | undefined { return decode(this.store.db.prepare("SELECT body FROM company_work WHERE id=?").get(id)); }
  workByClient(clientId: string): CompanyWork | undefined { return decode(this.store.db.prepare("SELECT body FROM company_work WHERE client_id=?").get(clientId)); }
  works(): CompanyWork[] { return this.store.db.prepare("SELECT body FROM company_work ORDER BY rowid").all().map((r) => decode<CompanyWork>(r)!); }
  putWork(w: CompanyWork): void { this.store.db.prepare("INSERT INTO company_work(id,client_id,body) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(w.id, w.clientId, JSON.stringify(w)); }
  revisions(agentId: string): CompanyEvolution[] { return this.store.db.prepare("SELECT body FROM company_evolution WHERE agent_id=? ORDER BY seq DESC LIMIT 100").all(agentId).map((r) => decode<CompanyEvolution>(r)!); }
  revision(id: string): CompanyEvolution | undefined { return decode(this.store.db.prepare("SELECT body FROM company_evolution WHERE id=?").get(id)); }
  addRevision(r: CompanyEvolution): void { this.store.db.prepare("INSERT INTO company_evolution(id,agent_id,body) VALUES (?,?,?)").run(r.id, r.agentId, JSON.stringify(r)); }
}
