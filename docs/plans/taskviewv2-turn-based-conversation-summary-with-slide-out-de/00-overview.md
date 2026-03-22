# TaskViewV2: Turn-Based Conversation Summary with Slide-Out Detail Panels

## Goal

Replace the flat message timeline in task views with a compact turn-based summary view. Each agent turn is rendered as a single block with stats and a live preview. Clicking a block opens a slide-out panel showing the full session chat via the existing ChatContainer component. The current TaskView (V1) remains untouched; a toggle in the header switches between V1 and V2.

## High-Level Approach

1. Build a data layer hook (`useTurnBlocks`) that transforms flat group messages into structured turn blocks, handling multi-agent interleaving and real-time deltas.
2. Create the `TurnSummaryBlock` UI component -- a compact card with agent info, stats badges, fixed-height message preview, and active turn animation.
3. Build a `SlideOutPanel` component that mounts `ChatContainer` by session ID, with transition animation and single-panel-at-a-time behavior.
4. Assemble `TaskViewV2` from the above pieces, render runtime messages inline between turn blocks, add a V1/V2 toggle to the header, and persist preference in localStorage.

## Milestones

1. **Turn Grouping Data Layer** -- `useTurnBlocks` hook + utility types + unit tests
2. **TurnSummaryBlock Component** -- Compact turn card UI with stats, preview, active indicator + unit tests
3. **Slide-Out Panel** -- Right-side panel mounting ChatContainer by session ID + transition + E2E tests
4. **TaskViewV2 Assembly and Toggle** -- Full V2 composition, inline runtime messages, V1/V2 toggle, localStorage persistence + E2E tests

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (needs TurnBlock types and data)
- Milestone 3 is independent of Milestones 1-2 (SlideOutPanel only needs a session ID)
- Milestone 4 depends on all three prior milestones

Milestones 2 and 3 can be developed in parallel after Milestone 1 completes.

## Key Constraints

- Do NOT modify `TaskView.tsx` or `TaskConversationRenderer.tsx` (V1 code)
- All new code goes under `packages/web/src/components/room/` and `packages/web/src/hooks/`
- PR targets the `dev` branch
- ChatContainer already accepts `{ sessionId, readonly? }` props -- reuse directly in the slide-out panel

## Total Estimated Task Count

4 milestones, 8 tasks
