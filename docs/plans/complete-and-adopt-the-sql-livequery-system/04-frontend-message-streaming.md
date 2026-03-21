# Milestone 4 — Frontend Message Streaming: LiveQuery for Session-Group Messages

**Agent:** coder
**Depends on:** Milestone 2

## Overview

`TaskConversationRenderer.tsx` already has a real-time path via `state.groupMessages.delta` events.
This milestone replaces it with the standardized `liveQuery.subscribe` protocol (protocol
consolidation, not a new capability).

The daemon emits `state.groupMessages.delta` from two sites, **both in `room-runtime.ts`**
(search for `state.groupMessages.delta` in the file). Note: `human-message-routing.ts` does **not**
emit this event (the file is only ~77 lines).

**Key design constraint — append-only invariant:** `session_group_messages` is an append-only table.
The delta handler only processes the `added` array; `updated` and `removed` are ignored.

**Retain `task.getGroupMessages` RPC endpoint** — it may be used by external tooling or tests.

---

## Task 4.1 — Create LiveQuery subscription hook for group messages

**Agent:** coder

- [ ] Create a hook or component-level subscription manager for `sessionGroupMessages.byGroup`
- [ ] On task/group selection: call `liveQuery.subscribe` with the group ID
- [ ] Handle `liveQuery.snapshot`: replace message list entirely
  (with stale-subscriptionId guard for rapid task switching)
- [ ] Handle `liveQuery.delta`: append new messages from `added` array only;
  ignore `updated`/`removed` (append-only invariant)
  (with stale-subscriptionId guard)
- [ ] Unsubscribe on component unmount or task deselection
- [ ] Vitest tests for the hook/subscription lifecycle

**Acceptance criteria:**
- Messages load via LiveQuery snapshot on group selection
- New messages appear via delta without polling
- Stale events from prior group subscriptions are discarded

---

## Task 4.2 — Remove old `state.groupMessages.delta` frontend listener

**Agent:** coder

- [ ] Remove `state.groupMessages.delta` event listener from `TaskConversationRenderer.tsx`
  (search for `state.groupMessages.delta` in the file)
- [ ] Remove the stale JSDoc comment referencing `state.groupMessages.delta`
  (search for the comment near the top of the file)

**Acceptance criteria:**
- No `state.groupMessages.delta` references remain in `TaskConversationRenderer.tsx`

---

## Task 4.3 — Remove daemon-side `state.groupMessages.delta` emissions and reconnect support

**Agent:** coder

- [ ] Remove both `state.groupMessages.delta` emission sites in `room-runtime.ts`
  (search for `state.groupMessages.delta` — both hits are in this single file)
- [ ] Implement reconnect re-subscribe: after WebSocket reconnect (general `connected` transition),
  re-issue `liveQuery.subscribe` for the active group
  - Do NOT call `liveQuery.unsubscribe` before re-subscribing (old handles disposed server-side)
- [ ] Handle resulting snapshot to resync message state

**Acceptance criteria:**
- Both daemon emission sites removed
- After reconnect, messages resync via snapshot
- No `state.groupMessages.delta` emissions remain anywhere in daemon code

---

## Task 4.4 — Migrate existing tests and add E2E coverage

**Agent:** coder

- [ ] Migrate existing tests in `packages/web/src/components/room/TaskConversationRenderer.test.tsx`
  that mock `state.groupMessages.delta` events — rewrite to use `liveQuery.snapshot`/`liveQuery.delta`
- [ ] E2E test: new message from agent appears in TaskView without manual refresh
- [ ] E2E test: switching between tasks shows correct messages for each task

**Acceptance criteria:**
- All migrated Vitest tests pass
- E2E tests pass
- Subscription disposed on component unmount
