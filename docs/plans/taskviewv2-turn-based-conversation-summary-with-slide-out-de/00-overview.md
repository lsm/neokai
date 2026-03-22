# TaskViewV2: Turn-Based Conversation Summary with Slide-Out Detail Panels

## Goal

Replace the flat message timeline in task views with a compact turn-based summary view. Each agent turn is rendered as a single block with stats and a live preview. Clicking a block opens a slide-out panel showing the full session chat via a standalone `ReadonlySessionChat` component. The current TaskView (V1) remains untouched; a toggle in the header switches between V1 and V2.

## High-Level Approach

1. **Refactor shared logic out of V1** — Extract shared data-fetching hook (`useTaskViewData`), shared sub-components (dialogs, input area, review bar, header actions), shared constants (`ROLE_COLORS`), and the `parseGroupMessage()` utility into separate files. Update V1 imports to use the extracted modules. This is a safe refactor that does not change V1 behavior. **Note**: `useGroupMessages` has already been extracted into `packages/web/src/hooks/useGroupMessages.ts` (using LiveQuery — snapshot + delta) — no further extraction needed for it.
2. Build a data layer hook (`useTurnBlocks`) that consumes `SessionGroupMessage[]` (from the existing `useGroupMessages` hook), parses them via `parseGroupMessage()`, and produces structured turn blocks, handling multi-agent interleaving and real-time deltas.
3. Create the `TurnSummaryBlock` UI component — a compact card with agent info, stats badges, fixed-height message preview, and active turn animation.
4. Build a `SlideOutPanel` component with a standalone `ReadonlySessionChat` that fetches messages independently (without `sessionStore`), with transition animation and single-panel-at-a-time behavior.
5. Assemble `TaskViewV2` from the above pieces, render runtime messages inline between turn blocks, add a V1/V2 toggle to the header, and persist preference in localStorage.

## Codebase Changes Since Plan Creation

The following refactors landed in `dev` (PR #720) after the initial plan was written and affect Task 1.1 scope:

- **`useGroupMessages` hook already extracted** to `packages/web/src/hooks/useGroupMessages.ts`. Uses LiveQuery pattern (`liveQuery.subscribe` with snapshot + delta events), NOT the old RPC+cursor pagination. Returns `{ messages: SessionGroupMessage[], isLoading, isReconnecting }`.
- **`SessionGroupMessage` interface already exported** from the hook file with fields: `id`, `groupId`, `sessionId`, `role`, `messageType`, `content`, `createdAt`.
- **`TaskConversationRenderer.tsx` already refactored** to use the hook (now ~466 lines). It still contains `ROLE_COLORS`, `parseGroupMessage()`, and the rendering logic.
- **No pagination in the LiveQuery hook** — the server handles windowing; all messages are streamed via snapshot + delta. `isAtTail` is effectively always `true`.

## Milestones

1. **Shared Logic Extraction + Turn Grouping Data Layer** — Extract shared hooks/components/utilities from V1, build `useTurnBlocks` hook + utility types + unit tests
2. **TurnSummaryBlock Component** — Compact turn card UI with stats, preview, active indicator + unit tests
3. **Slide-Out Panel** — Right-side panel with standalone `ReadonlySessionChat` (independent of `sessionStore`) + transition + unit tests
4. **TaskViewV2 Assembly and Toggle** — Full V2 composition, inline runtime messages, V1/V2 toggle, localStorage persistence + E2E tests

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (needs TurnBlock types and data)
- Milestone 3 is independent of Milestones 1-2 (SlideOutPanel only needs a session ID)
- Milestone 4 depends on all three prior milestones

Milestones 2 and 3 can be developed in parallel after Milestone 1 completes.

## Key Constraints

- Do NOT change V1 **behavior** — refactoring V1 to import from shared modules is allowed, but the rendered output and logic must remain identical
- Do NOT change the rendered output of `TaskConversationRenderer.tsx` — refactoring its internals (extracting `parseGroupMessage()`, `ROLE_COLORS`) is allowed and expected
- All new V2 code goes under `packages/web/src/components/room/` and `packages/web/src/hooks/`
- PR targets the `dev` branch
- `ChatContainer` cannot be reused in the slide-out panel because `sessionStore` is a global singleton that only holds one session's data. The slide-out panel uses a standalone `ReadonlySessionChat` component that fetches messages independently (see Milestone 3).

## Total Estimated Task Count

4 milestones, 11 tasks (M1: 3, M2: 2, M3: 2, M4: 4)
