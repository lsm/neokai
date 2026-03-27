# Milestone 6: Origin Metadata

## Goal

Add an `origin` field to messages so the system can distinguish between human-initiated and Neo-initiated actions.

## Scope

- Extend message types with `origin` field
- Propagate origin through message injection pipeline
- Room/space agents receive origin in message metadata

## Tasks

### Task 6.1: Origin Field in Shared Types and Message Pipeline

**Description**: Add the `origin` field to message types and ensure it propagates through the system.

**Subtasks**:
1. Add `origin?: 'human' | 'neo' | 'system'` field to message metadata types in `packages/shared/src/types.ts` (find the appropriate message/metadata interface)
2. Add `origin` column to `sdk_messages` table via migration (nullable TEXT, default NULL treated as `'human'`)
3. Update `SDKMessageRepository` to persist and retrieve the `origin` field
4. Update `SessionManager.injectMessage()` to accept and pass through an `origin` option
5. Update Neo's `send_message_to_room` and `send_message_to_task` tools to set `origin: 'neo'` on injected messages
6. Update `neo.send` RPC handler to mark Neo's own responses with `origin: 'neo'`
7. Ensure backward compatibility: messages without `origin` default to `'human'`
8. Add unit tests for origin propagation through inject and persistence

**Acceptance Criteria**:
- Messages carry `origin` field through the full pipeline
- Neo-originated messages are stored with `origin: 'neo'`
- Backward compatibility preserved (existing messages work without origin)
- Room/space agents can read origin from incoming message metadata
- Unit tests pass

**Dependencies**: Task 1.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
