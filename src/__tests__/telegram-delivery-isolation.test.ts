import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { TelegramAdapter } from "../channels/telegram/adapter.js";
import { PartialDeliveryError } from "../channels/delivery.js";
import { ProgressTracker } from "../progress/progress.js";
import { MessageStore } from "../sessions/message-store.js";
import { registerHandlers } from "../channels/telegram/handlers.js";
import { ApiServer } from "../api/server.js";

const log = pino({ level: "silent" });
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pa-delivery-")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function adapter(store?: MessageStore) {
  const a = Object.create(TelegramAdapter.prototype) as any;
  a.token = "1:offline-placeholder";
  a.botName = "test";
  a.log = log;
  a.messageStore = store;
  a.bot = { api: { editMessageText: vi.fn(async () => ({})), sendMessage: vi.fn(async () => ({ message_id: 11 })),
    deleteMessage: vi.fn(async () => ({})) } };
  return a;
}
const message = (id: string, text: string, senderId = "1") => ({ id, text, senderId, sender: "test", ts: 100 });

describe("delivery failures and edit archive", () => {
  it.each([undefined, "plain answer"])("propagates transport failure with fallback=%s", async (plain) => {
    const a = adapter();
    a.bot.api.editMessageText.mockRejectedValue(new Error("network unavailable"));
    await expect(a.editMessage("-1", "9", "answer", undefined, "HTML", plain)).rejects.toThrow("network unavailable");
    expect(a.bot.api.editMessageText).toHaveBeenCalledTimes(1);
  });
  it("propagates failure of the plain-text formatting fallback", async () => {
    const a = adapter();
    a.bot.api.editMessageText.mockRejectedValueOnce(new Error("can't parse entities")).mockRejectedValueOnce(new Error("forbidden"));
    await expect(a.editMessage("-1", "9", "<b>answer", undefined, "HTML", "answer")).rejects.toThrow("forbidden");
  });
  it("hides spinners, archives accepted edits once, and preserves original order", async () => {
    const store = new MessageStore(dir).forBot("bot", "telegram");
    const a = adapter(store);
    store.upsert("-1", { ...message("9", "Thinking"), transient: true });
    store.append("-1", message("10", "new question", "user"));
    expect(store.getRecent("-1").map(m => m.id)).toEqual(["10"]);
    await a.editMessage("-1", "9", "answer", undefined, "HTML");
    await a.editMessage("-1", "9", "answer", undefined, "HTML");
    expect(store.getRecent("-1").map(m => [m.id, m.text])).toEqual([["9", "answer"], ["10", "new question"]]);
    await a.deleteMessage("-1", "9");
    expect(store.getRecent("-1").map(m => m.id)).toEqual(["10"]);
  });
  it("does not archive a failed edit and recognizes idempotent not-modified responses", async () => {
    const store = new MessageStore(dir).forBot("bot", "telegram");
    const a = adapter(store);
    a.bot.api.editMessageText.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(a.editMessage("-1", "9", "answer")).rejects.toThrow();
    expect(store.getRecent("-1")).toEqual([]);
    a.bot.api.editMessageText.mockRejectedValueOnce(new Error("message is not modified"));
    await a.editMessage("-1", "9", "answer");
    expect(store.getRecent("-1")[0]?.text).toBe("answer");
  });
  it("does not turn a local archive failure into a transport retry", async () => {
    const a = adapter({ upsert() { throw new Error("disk full"); } } as any);
    await expect(a.editMessage("-1", "9", "accepted")).resolves.toBeUndefined();
    expect(a.bot.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(a.bot.api.sendMessage).not.toHaveBeenCalled();
  });
  it("redacts credentials from failure logs without logging message text", async () => {
    const a = adapter();
    a.log = { warn: vi.fn() };
    const credential = "123456789:AA" + "a".repeat(33);
    a.bot.api.editMessageText.mockRejectedValue(new Error("failure at " + credential));
    await expect(a.editMessage("-1", "9", "PRIVATE MESSAGE CONTENT")).rejects.toThrow();
    const logged = JSON.stringify(a.log.warn.mock.calls);
    expect(logged).not.toContain(credential);
    expect(logged).not.toContain("PRIVATE MESSAGE CONTENT");
    expect(logged).toContain("REDACTED");
  });
  it("reports only the unsent tail after a partially delivered long reply", async () => {
    const a = adapter();
    a.bot.api.sendMessage.mockRejectedValue(new Error("rate limited"));
    const first = "a".repeat(4000);
    try {
      await a.editMessage("-1", "9", first + "\n" + "tail".repeat(200), undefined, "HTML");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(PartialDeliveryError);
      expect((err as PartialDeliveryError).remaining).toMatchObject({ chatId: "-1", text: "tail".repeat(200) });
    }
    expect(a.bot.api.editMessageText).toHaveBeenCalledTimes(1);
  });
  it("sends the replacement to the same chat then removes the old spinner", async () => {
    const channel: any = { type: "telegram", editMessage: vi.fn(async () => { throw new Error("deleted"); }),
      send: vi.fn(async () => "new"), deleteMessage: vi.fn(async () => {}) };
    const t = new ProgressTracker(channel, "-group", "question");
    (t as any).messageId = "spinner";
    await t.finish("answer");
    expect(channel.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "-group", replyToMessageId: "question", text: "answer" }));
    expect(channel.deleteMessage).toHaveBeenCalledWith("-group", "spinner");
    expect(channel.send.mock.invocationCallOrder[0]).toBeLessThan(channel.deleteMessage.mock.invocationCallOrder[0]);
  });
  it("recovers end to end through the real adapter and archives only the accepted replacement", async () => {
    const store = new MessageStore(dir).forBot("bot", "telegram");
    const a = adapter(store);
    a.bot.api.sendMessage.mockResolvedValueOnce({ message_id: 9 }).mockResolvedValueOnce({ message_id: 11 });
    const spinner = await a.send({ chatId: "-1", text: "Thinking", transient: true });
    a.bot.api.editMessageText.mockRejectedValueOnce(new Error("message to edit not found"));
    const t = new ProgressTracker(a, "-1", "7");
    (t as any).messageId = spinner;
    // Object.create bypasses the instance field initializer used in production.
    Object.defineProperty(a, "type", { value: "telegram" });
    await t.finish("final answer");
    expect(a.bot.api.sendMessage).toHaveBeenLastCalledWith("-1", "final answer", expect.objectContaining({
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
    }));
    expect(store.getRecent("-1").map(m => [m.id, m.text])).toEqual([["11", "final answer"]]);
  });
  it("does not repeat a successfully delivered prefix", async () => {
    const channel: any = { type: "telegram", editMessage: vi.fn(async () => { throw new PartialDeliveryError({ chatId: "-g", text: "tail" }, new Error("offline")); }),
      send: vi.fn(async () => "new"), deleteMessage: vi.fn() };
    const t = new ProgressTracker(channel, "-g", "q");
    (t as any).messageId = "spinner";
    await t.finish("prefix\ntail");
    expect(channel.send).toHaveBeenCalledExactlyOnceWith({ chatId: "-g", text: "tail", replyToMessageId: "q" });
    expect(channel.deleteMessage).not.toHaveBeenCalled();
  });
  it("waits for a late in-flight progress update before publishing the final reply", async () => {
    let release!: () => void;
    const channel: any = { type: "telegram", send: vi.fn(async () => "new"), editMessage: vi.fn(async () => {}) };
    const t = new ProgressTracker(channel, "-g");
    (t as any).flushInFlight = new Promise<void>(r => { release = r; });
    const done = t.finish("answer");
    await Promise.resolve(); await Promise.resolve();
    expect(channel.send).not.toHaveBeenCalled();
    release(); await done;
    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});

describe("archive namespaces", () => {
  it("keeps bot, channel and chat namespaces separate and never guesses legacy ownership", () => {
    const root = new MessageStore(dir);
    root.append("42", message("1", "legacy"));
    const a = root.forBot("a", "telegram"), b = root.forBot("b", "telegram"), c = root.forBot("a", "discord");
    a.append("42", message("1", "A")); b.append("42", message("1", "B")); c.append("42", message("1", "C"));
    expect([a, b, c].map(s => s.getRecent("42")[0].text)).toEqual(["A", "B", "C"]);
    expect(a.getRecent("43")).toEqual([]);
    expect(new MessageStore(dir).forBot("a", "telegram").getRecent("42")[0].text).toBe("A");
    expect(root.getRecent("42")[0].text).toBe("legacy");
  });
  it("refuses author replacement and encodes path segments", () => {
    const store = new MessageStore(dir).forBot("../a", "telegram");
    store.upsert("../../escape", message("1", "original"));
    expect(() => store.upsert("../../escape", message("1", "replacement", "other"))).toThrow("author mismatch");
    expect(existsSync(join(dir, "escape.jsonl"))).toBe(false);
    expect(store.getRecent("../../escape")[0].text).toBe("original");
  });
});

describe("album isolation", () => {
  it("does not combine identical album IDs across bots or chats", async () => {
    vi.useFakeTimers();
    const setup = () => {
      const events: Record<string, (ctx: any) => void> = {};
      const handler = vi.fn(async () => {});
      registerHandlers({ command() {}, on(k: string, f: any) { events[k] = f; } } as any, handler, new Map(), log);
      return { events, handler };
    };
    const a = setup(), b = setup();
    const ctx = (chat: number, file: string) => ({ message: { message_id: 1, date: 1, chat: { id: chat, type: "private" },
      from: { id: chat, first_name: "U" }, media_group_id: "shared", photo: [{ file_id: file }] } });
    a.events["message:photo"](ctx(1, "a1")); a.events["message:photo"](ctx(2, "a2"));
    b.events["message:photo"](ctx(1, "b1"));
    await vi.advanceTimersByTimeAsync(600);
    expect(a.handler.mock.calls.map((c: any) => c[0].attachments[0].fileId)).toEqual(["a1", "a2"]);
    expect(b.handler.mock.calls.map((c: any) => c[0].attachments[0].fileId)).toEqual(["b1"]);
  });
});

describe("history API binding", () => {
  it("rejects cross-chat, cross-bot and unknown session requests; reads only the bound store", async () => {
    const store = new MessageStore(dir);
    store.forBot("a", "telegram").append("42", message("1", "A"));
    store.forBot("b", "telegram").append("42", message("1", "B"));
    const api = new ApiServer({ port: 0, dataDir: dir, log, messageStore: store, getBotTelegram: () => undefined,
      getBotsInfo: () => [{ botId: "a", channel: "telegram" }, { botId: "b", channel: "telegram" }] as any,
      resolveSession: id => id === "valid" ? { botId: "a", chatId: "42", channelType: "telegram" } : undefined });
    await api.start();
    const base = `http://127.0.0.1:${(api as any).server.address().port}`;
    const get = (query: string, session = "valid") => fetch(base + "/api/chat-history?" + query, { headers: { "X-PocketAgent-Session": session } });
    try {
      expect((await get("bot_id=b&chat_id=42")).status).toBe(403);
      expect((await get("bot_id=a&chat_id=43")).status).toBe(403);
      expect((await get("bot_id=a&chat_id=42", "unknown")).status).toBe(403);
      const body = await (await get("")).json() as any;
      expect(body.messages.map((m: any) => m.text)).toEqual(["A"]);
      expect((await fetch(base + "/api/chat-history?chat_id=42")).status).toBe(400);
    } finally { await api.stop(); }
  });
});
