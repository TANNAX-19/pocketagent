# Telegram delivery and archive isolation

The Telegram adapter previously swallowed edit failures. A completed model response could therefore leave a Thinking placeholder visible, and the progress tracker never attempted its new-message fallback. The archive also deduplicated edits by message ID, keeping the initial placeholder rather than the accepted answer.

This change propagates failed edits, retries malformed formatting as plain text, and allows the progress tracker to send a replacement to the same chat and original reply target. A partially delivered long answer carries only its remaining tail into recovery. In-flight progress requests finish before the final edit. Failed turns remove their progress card. Archive failures are reported separately and cannot turn an accepted network send into a duplicate send.

Accepted message edits are append-only journal revisions. Readers collapse revisions by ID while preserving the original message order. Transient progress messages and deletion tombstones are excluded from the history supplied to the model. Revisions cannot replace a different author's record.

New archives live at `messages/<encoded-botId>/<encoded-channel>/<encoded-chatId>.jsonl`. Each component uses a prefixed UTF-8 hex encoding so distinct case-sensitive platform identities cannot collide on Windows and device names/path separators are harmless. Telegram handlers receive their bot's store directly instead of using a module-global store. Album buffers are local to each handler registration and keyed by chat plus album ID.

The history API uses the caller's bot/chat binding when a session header is present, rejects unknown session headers and target mismatches, requires explicit bot and chat for trusted dashboard callers, and never searches an unrelated bot's cloud history. History queries are bounded to 200 messages. Diagnostic edit-failure logs redact known credential formats and do not include message bodies or raw request objects.

## Compatibility and deployment

Existing legacy archives in `messages/<chatId>.jsonl` are retained unchanged. They are not automatically copied into a bot's namespace: an old file alone cannot prove which bot owned each entry. Session history, native model conversations, personas, credentials and long-term memory are unchanged. Existing `/api/chat-history` clients without a session header must provide both `bot_id` and `chat_id`.

Build and deploy this commit before expecting a running gateway to use these fixes. Restart timing is a user decision. Rolling back code leaves both old archives and new namespaced journals on disk; do not combine them automatically.

## Security limits

This is message routing and context hygiene, not a new operating-system sandbox or authenticated multi-tenant administration service. The existing local dashboard/API remains a trusted administrative surface, and the current engine's full filesystem permissions are unchanged. A caller able to execute arbitrary local code can access those surfaces; session headers alone are not a complete security boundary. Chat-scoped and bot-shared long-term memory keep their existing semantics.

Telegram does not offer an exactly-once acknowledgement for a send that times out after remote acceptance. Recovery is bounded, avoids replaying acknowledged prefixes, and preserves the target, but an ambiguous network timeout can still produce a duplicate. The patch does not claim to eliminate that protocol limitation or retroactively repair old poisoned model conversations.

Regression tests cover transport and plain-text fallback failures, successful and failed archive updates, credential redaction, partial-message recovery, progress ordering, namespaces, path traversal, album isolation and history API caller binding.
