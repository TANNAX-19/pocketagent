import { describe, it, expect } from "vitest";
import { parseConfig, resolveBots } from "../config/loader.js";
import { checkGroupMention } from "../channels/telegram/handlers.js";
import type { Context } from "grammy";
import type { InboundMessage } from "../channels/types.js";

describe("Trigger Words Feature", () => {
  describe("Config loading", () => {
    it("parses triggerWords at bot level and group level", () => {
      const yaml = `
bots:
  - name: "tayama-bot"
    token: "8686742836:AAGZORD"
    channel: telegram
    triggerWords:
      - "田山"
      - "山田"
    groups:
      "-1003691068764":
        enabled: true
        triggerWords:
          - "小田"
`;
      const config = parseConfig(yaml);
      const bots = resolveBots(config);

      expect(bots.length).toBe(1);
      expect(bots[0].triggerWords).toEqual(["田山", "山田"]);
      expect(bots[0].groups["-1003691068764"].triggerWords).toEqual(["小田"]);
    });
  });

  describe("checkGroupMention", () => {
    const mockInbound: InboundMessage = {
      channelType: "telegram",
      chatId: "-1003691068764",
      senderId: "5098840772",
      senderName: "User",
      messageId: "123",
      text: "hello",
      isGroup: true,
      timestamp: 1234567890,
    };

    it("returns null when no mention, no reply, and no trigger word", () => {
      const ctx = {
        me: { id: 999, username: "test_bot" },
        message: {},
      } as unknown as Context;

      const result = checkGroupMention(ctx, mockInbound, "今天天气怎么样", ["田山", "山田"]);
      expect(result).toBeNull();
    });

    it("triggers and keeps full text when trigger word is present", () => {
      const ctx = {
        me: { id: 999, username: "test_bot" },
        message: {},
      } as unknown as Context;

      const result = checkGroupMention(ctx, mockInbound, "田山，今天天气怎么样", ["田山", "山田"]);
      expect(result).toBe("田山，今天天气怎么样");
    });

    it("triggers case-insensitively for English trigger words", () => {
      const ctx = {
        me: { id: 999, username: "test_bot" },
        message: {},
      } as unknown as Context;

      const result = checkGroupMention(ctx, mockInbound, "Hello Tayama, how are you?", ["tayama"]);
      expect(result).toBe("Hello Tayama, how are you?");
    });

    it("strips bot username when bot is @mentioned", () => {
      const ctx = {
        me: { id: 999, username: "test_bot" },
        message: {},
      } as unknown as Context;

      const result = checkGroupMention(ctx, mockInbound, "@test_bot 查下这个", ["田山"]);
      expect(result).toBe("查下这个");
    });

    it("keeps full text when message is a reply to the bot", () => {
      const ctx = {
        me: { id: 999, username: "test_bot" },
        message: {
          reply_to_message: {
            from: { id: 999 },
          },
        },
      } as unknown as Context;

      const result = checkGroupMention(ctx, mockInbound, "接着说", ["田山"]);
      expect(result).toBe("接着说");
    });
  });
});
