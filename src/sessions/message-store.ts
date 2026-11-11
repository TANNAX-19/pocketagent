import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface StoredMessage {
  id: string;
  ts: number;
  sender: string;
  senderId: string;
  text: string;
  media?: string[];
  transient?: boolean;
  deleted?: boolean;
}

export interface MessageQueryOptions {
  chatId: string;
  since?: number;
  until?: number;
  limit?: number;
  sender?: string;
  search?: string;
}

const DEDUP_WINDOW = 500;

export class MessageStore {
  private dir: string;
  private cursors = new Map<string, string>();
  private recentIds = new Map<string, Set<string>>();

  constructor(private dataDir: string, private scope?: { botId: string; channel: string }) {
    const segment = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");
    this.dir = scope
      ? join(dataDir, "messages", segment(scope.botId), segment(scope.channel))
      : join(dataDir, "messages");
    mkdirSync(this.dir, { recursive: true });
  }

  forBot(botId: string, channel: string): MessageStore {
    if (!botId || !channel) throw new Error("Message store requires bot and channel");
    return new MessageStore(this.dataDir, { botId, channel });
  }

  private pathFor(chatId: string): string {
    if (!chatId) throw new Error("Missing chat identity");
    return join(this.dir, `${encodeURIComponent(chatId).replace(/\./g, "%2E")}.jsonl`);
  }

  private records(chatId: string): StoredMessage[] {
    const filePath = this.pathFor(chatId);
    if (!existsSync(filePath)) return [];
    const latest = new Map<string, StoredMessage>();
    for (const line of readFileSync(filePath, "utf-8").split("\n")) {
      try {
        const msg = JSON.parse(line) as StoredMessage;
        if (typeof msg.id === "string") latest.set(msg.id, msg);
      } catch { /* An incomplete journal tail is ignored. */ }
    }
    return [...latest.values()];
  }

  /** Edit journal: preserve chronology and refuse to replace another author's message. */
  upsert(chatId: string, msg: StoredMessage): void {
    const previous = this.records(chatId).find((m) => m.id === msg.id);
    if (previous && previous.senderId !== msg.senderId) throw new Error("Message author mismatch");
    if (previous?.transient && msg.transient) return;
    const next = previous ? { ...msg, ts: previous.ts } : msg;
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    appendFileSync(this.pathFor(chatId), JSON.stringify(next) + "\n");
  }

  remove(chatId: string, id: string, senderId: string): void {
    const previous = this.records(chatId).find((m) => m.id === id);
    if (previous?.senderId === senderId) this.upsert(chatId, { ...previous, deleted: true });
  }

  advanceCursor(sessionId: string, messageId: string): void {
    this.cursors.set(sessionId, messageId);
  }

  advanceCursorToLatest(chatId: string, sessionId: string): void {
    const latest = this.getRecent(chatId, 1);
    if (latest.length > 0) {
      this.cursors.set(sessionId, latest[0].id);
    }
  }

  append(chatId: string, msg: StoredMessage): boolean {
    let seen = this.recentIds.get(chatId);
    if (!seen) {
      seen = new Set();
      this.recentIds.set(chatId, seen);
    }
    if (seen.has(msg.id)) return false;
    seen.add(msg.id);
    if (seen.size > DEDUP_WINDOW) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }

    const filePath = this.pathFor(chatId);
    appendFileSync(filePath, JSON.stringify(msg) + "\n");
    return true;
  }

  getRecent(chatId: string, limit = 50): StoredMessage[] {
    if (limit <= 0) return [];
    return this.records(chatId).filter((m) => !m.transient && !m.deleted).slice(-limit);
  }

  getSinceCursor(chatId: string, sessionId: string, limit = 20): StoredMessage[] {
    const cursor = this.cursors.get(sessionId);
    const messages = this.getRecent(chatId, 100);
    if (!cursor) {
      return messages.slice(-limit);
    }
    const idx = messages.findIndex((m) => m.id === cursor);
    if (idx === -1) {
      return messages.slice(-limit);
    }
    return messages.slice(idx + 1, idx + 1 + limit);
  }

  query(opts: MessageQueryOptions): StoredMessage[] {
    const all = this.getRecent(opts.chatId, 1000);
    return all.filter((m) => {
      if (opts.since && m.ts * 1000 < opts.since) return false;
      if (opts.until && m.ts * 1000 > opts.until) return false;
      if (opts.sender && !m.sender.toLowerCase().includes(opts.sender.toLowerCase())) return false;
      if (opts.search && !m.text.toLowerCase().includes(opts.search.toLowerCase())) return false;
      return true;
    }).slice(-(opts.limit ?? 50));
  }
}
