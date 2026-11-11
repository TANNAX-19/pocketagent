import type { OutboundMessage } from "./types.js";

/** A prefix is already visible. Only the remaining text may be sent again. */
export class PartialDeliveryError extends Error {
  constructor(readonly remaining: OutboundMessage, cause: unknown) {
    super("Message was partially delivered", { cause });
  }
}
