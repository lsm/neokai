# Milestone 4: Task View and Agent Messages

## Goal

Harden the task detail view: unified thread shows all agents' messages with visual differentiation, clicking an agent name opens an overlay chat (not full-page navigation).

## Scope

Happy paths 6 (Task view with agent messages) and 7 (Agent overlay chat).

## Tasks

### Task 4.1: Verify unified thread renders all agent messages with color differentiation

**Description:** The `SpaceTaskUnifiedThread` component should render messages from all agents (task agent + node agents) with visual differentiation via colored side rails. Verify this works and add missing test coverage.

**Subtasks:**
1. Read `packages/web/src/components/space/SpaceTaskUnifiedThread.tsx` for message rendering logic.
2. Read `packages/web/src/components/space/thread/` directory for thread sub-components.
3. Check how agent identity is associated with messages (session ID -> agent mapping).
4. Verify color-coded side rails are implemented per agent.
5. Check existing Vitest tests in `packages/web/src/components/space/__tests__/SpaceTaskUnifiedThread.test.tsx`.
6. Add Vitest tests for: messages from different agents render with distinct colors, task agent messages are visually distinct from node agent messages, message ordering is chronological across agents.
7. Run `cd packages/web && bunx vitest run src/components/space/__tests__/SpaceTaskUnifiedThread*` to verify.

**Acceptance Criteria:**
- Unified thread correctly differentiates messages by agent via colored side rails.
- Vitest tests verify multi-agent message rendering.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 3.4

**Agent type:** coder

### Task 4.2: Implement agent overlay chat panel

**Description:** Currently clicking an agent name navigates to a full-page `ChatContainer` via `navigateToSpaceSession`. Change this to open an overlay/slide-over panel that shows the agent's messages while keeping the task view visible underneath.

**Subtasks:**
1. Read `packages/web/src/islands/SpaceIsland.tsx` to understand the current sessionViewId-based full-page navigation.
2. Read `packages/web/src/components/space/SpaceTaskPane.tsx` for where agent session links are rendered.
3. Read `packages/web/src/islands/SpaceDetailPanel.tsx` for agent session click handling.
4. Design an overlay chat component that renders as a slide-over panel from the right side, showing `ChatContainer` content in a constrained width.
5. Create `packages/web/src/components/space/AgentOverlayChat.tsx` -- a slide-over panel that wraps `ChatContainer` with close button and agent name header.
6. Update `SpaceTaskPane.tsx` and `SpaceDetailPanel.tsx` to open the overlay instead of navigating to a full-page session view.
7. Add Vitest tests for the new overlay component: renders with session ID, close button works, agent name displayed.
8. Run tests to verify.

**Acceptance Criteria:**
- Clicking an agent name from task view opens an overlay panel, not a full-page navigation.
- Overlay shows agent messages in a slide-over panel with close functionality.
- Task view remains visible underneath the overlay.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 4.1

**Agent type:** coder

### Task 4.3: Verify activity members list in task pane

**Description:** The task pane header shows activity members (task agent + node agents) with their states. Verify this renders correctly and clicking a member opens their overlay chat.

**Subtasks:**
1. Read `packages/web/src/components/space/SpaceTaskPane.tsx` for activity member rendering.
2. Read `packages/web/src/lib/space-store.ts` for `taskActivity` signal.
3. Verify activity members show correct states: active, queued, idle, completed, etc.
4. Update member click handling to open the new overlay chat (from Task 4.2).
5. Add Vitest tests for activity member list: renders all members, shows correct states, click opens overlay.
6. Run tests to verify.

**Acceptance Criteria:**
- Activity members list shows all agents with their current states.
- Clicking a member opens the overlay chat panel.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 4.2

**Agent type:** coder
