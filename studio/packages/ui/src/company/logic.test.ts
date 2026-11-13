import { describe, expect, it } from "vitest";
import type { CompanyAgent, CompanyMessage } from "@amo-studio/protocol";
import { mentionAt, mergeMessages, organizationRoots, recipients } from "./logic.js";

const agent = (id: string, name: string, managerId: string | null = null) => ({ id, name, managerId } as CompanyAgent);
const high = agent("high", "高配打包Agent");
const low = agent("low", "低配打包Agent");

describe("company mentions identify only explicitly addressed room members", () => {
  it("opens at a word boundary and follows the caret, without recognizing an email address", () => {
    expect(mentionAt("请 @高配 准备", 5)).toEqual({ start: 2, query: "高配" });
    expect(mentionAt("a@example.com", 13)).toBeNull();
    expect(mentionAt("@高配\n继续", 7)).toBeNull();
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  });
  it("resolves a fully typed name with punctuation and does not match its prefix", () => {
    expect(recipients("@高配打包Agent，请整理结果。 @低配打包Agent 验证。", [], [high, low])).toEqual(["high", "low"]);
    expect(recipients("@高配打包Agent2 准备", [], [high, low])).toEqual([]);
    expect(recipients("普通群消息", [], [high, low])).toEqual([]);
    expect(recipients("给 somebody@高配打包Agent 发邮件", [], [high, low])).toEqual([]);
  });
  it("keeps the selected identity across renames but removes it when deleted from the text or the room", () => {
    const chosen = [{ id: "high", name: high.name }];
    expect(recipients("@高配打包Agent 请准备", chosen, [agent("high", "新名字")])).toEqual(["high"]);
    expect(recipients("请准备", chosen, [high])).toEqual([]);
    expect(recipients("@高配打包Agent 请准备", chosen, [low])).toEqual([]);
  });
  it("requires selection for duplicate names and handles regex characters literally", () => {
    const members = [agent("a", "Agent (1)"), agent("b", "Agent (1)")];
    expect(recipients("@Agent (1) 执行", [], members)).toEqual([]);
    expect(recipients("@Agent (1) 执行", [{ id: "b", name: "Agent (1)" }], members)).toEqual(["b"]);
  });
});

describe("company history", () => {
  const message = (id: string, date: string, status: "queued" | "delivered") => ({ id, createdAt: date, deliveries: [{ agentId: "high", status }] } as CompanyMessage);
  it("deduplicates repeated pages and updates delivery without losing earlier messages", () => {
    const old = message("old", "2026-11-12T00:00:00Z", "delivered");
    const pending = message("new", "2026-11-13T00:00:00Z", "queued");
    const delivered = message("new", pending.createdAt, "delivered");
    expect(mergeMessages([old, pending], [delivered])).toEqual([old, delivered]);
    expect(mergeMessages([delivered], [old, delivered])).toEqual([old, delivered]);
  });
  it("keeps server insertion order when timestamps are equal", () => {
    const first = message("z", "same", "queued"), second = message("a", "same", "queued");
    expect(mergeMessages([first], [first, second]).map((m) => m.id)).toEqual(["z", "a"]);
  });
});

describe("organization", () => {
  it("shows missing-manager members and a cyclic component once without losing valid roots", () => {
    const ceo = agent("ceo", "CEO"), product = agent("product", "产品", "ceo"), orphan = agent("orphan", "未分组", "gone"), a = agent("a", "A", "b"), b = agent("b", "B", "a");
    expect(organizationRoots([ceo, product, orphan, a, b]).map((x) => x.id)).toEqual(["ceo", "orphan", "a"]);
  });
});
