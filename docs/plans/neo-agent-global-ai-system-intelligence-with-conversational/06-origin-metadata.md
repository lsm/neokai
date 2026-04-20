# Milestone 6: Origin Metadata

## Goal

Add an `origin` field to messages so the system can distinguish between human-initiated and Neo-initiated actions.

## Scope

- Add `origin` column to `sdk_messages` table (DB-level annotation)
- Extend app-level message metadata types with `origin` field
- Set `origin` during message injection pipeline
- **Frontend display only**: The `origin` column powers "via Neo" indicators in M9. It is NOT injected into the SDK message JSON blob -- room/space agents do NOT see `origin` via the SDK API.

### Storage Model

The `sdk_messages` table stores an opaque `sdk_message TEXT` blob (the SDK's internal message format) alongside app-level metadata columns (`session_id`, `created_at`, etc.). The `origin` column is another app-level metadata column -- it sits alongside the blob, not inside it. This is the same pattern used for other app-level columns.

### Origin Propagation Model (Single-Hop, DB-Only)

Origin is a **single-hop, DB-level** attribute:
- When Neo injects a message into Room A, `SessionManager.injectMessage()` sets `origin: 'neo'` on the `sdk_messages` row
- The SDK processes the message content normally -- the SDK itself is unaware of `origin`
- Room A's agent acts on the message content. Any downstream messages from the room agent have no `origin` set (default `NULL` = `'human'`)
- The frontend queries `origin` from `sdk_messages` to render "via Neo" badges

This keeps the model simple. Full causal tracing is a future concern requiring a separate audit trail.

## Tasks

### Task 6.1: Origin Field in Shared Types and Message Pipeline

**Description**: Add the `origin` field to message types and ensure it propagates through the system.

**Subtasks**:
1. Add `MessageOrigin` type (`'human' | 'neo' | 'system'`) and `origin?: MessageOrigin` field to app-level message metadata types in `packages/shared/src/types.ts`
2. Add `origin` column to `sdk_messages` table via migration (nullable TEXT, default NULL treated as `'human'`). This is an app-level metadata column alongside the opaque `sdk_message` blob -- it does NOT modify the SDK message format.
3. Update `SDKMessageRepository` to persist and retrieve the `origin` column
4. Update `SessionManager.injectMessage()` to accept an optional `origin` parameter and write it to the `origin` column when persisting
5. Update Neo's `send_message_to_room` and `send_message_to_task` tools to pass `origin: 'neo'` when calling `injectMessage()`
6. Update `neo.send` RPC handler to set `origin: 'neo'` on Neo's own response rows in `sdk_messages`
7. Ensure backward compatibility: existing messages without `origin` column value default to `NULL` (treated as `'human'` by the frontend)
8. Add unit tests for origin persistence through inject pipeline and retrieval

**Acceptance Criteria**:
- Neo-originated messages are stored with `origin: 'neo'` in the `sdk_messages` table
- Frontend can query `origin` from message rows to power "via Neo" indicators
- Backward compatibility preserved (existing messages without origin work normally)
- The SDK message blob is NOT modified -- `origin` is a DB column only
- Unit tests pass

**Dependencies**: Task 1.1 (DB migration infrastructure). Note: Task 3.4 (`send_message_to_room`) implements messaging without origin initially; this task adds the origin annotation.

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
