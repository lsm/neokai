# Milestone 2: TurnSummaryBlock Component

## Goal

Create the compact turn card UI component that renders a single agent turn with stats, preview, and active indicator.

## Tasks

### Task 2.1: Implement TurnSummaryBlock component

**Agent type:** coder

**Description:**
Build the `TurnSummaryBlock` component that renders a single turn block as a compact card. This is the core visual element of the V2 view.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/TurnSummaryBlock.tsx` with the following structure:
   - **Props**: `{ turn: TurnBlock; onClick: (turn: TurnBlock) => void; isSelected?: boolean }`
   - **Title bar** (top row):
     - Agent name with role color — import `ROLE_COLORS` from `packages/web/src/lib/task-constants.ts` (extracted in Task 1.1). The label is a plain role name without model info. `ROLE_COLORS` has entries for: `planner`, `coder`, `general`, `leader`, `human`, `system`, `craft`, `lead` — all must be supported.
     - Last action badge (e.g., "Read", "Edit", "Bash") — extracted from `turn.lastAction`
     - Turn duration: format as `startTime - endTime` using relative time (e.g., "2m 30s") or "running..." if `endTime` is null
   - **Stats badges** (second row):
     - Tool calls count with wrench icon
     - Thinking blocks count with brain/thought icon
     - Assistant messages count with chat icon
     - Use small pill-shaped badges with muted colors
     - Zero counts: hide the badge entirely (don't show "0")
   - **Fixed-height preview area** (bottom):
     - Max height ~80px with `overflow-y-auto`
     - Render `turn.previewMessage` using `SDKMessageRenderer`. The full `SDKMessageRenderer` in `TaskConversationRenderer` takes `toolResultsMap`, `toolInputsMap`, `subagentMessagesMap`, `sessionId`, `pendingQuestion`, `resolvedQuestions`, `onQuestionResolved`, and `taskContext` props. For the compact preview, pass **empty maps** `{}` for `toolResultsMap`, `toolInputsMap`, `subagentMessagesMap`, pass `taskContext={true}`, and omit question-related props. This means tool_result previews won't show correlated tool_use inputs — this is intentional for the compact preview (full tool correlation is available in the slide-out panel).
     - If turn is active, show the live-streaming last message
     - If turn ended with error, show error message in red styling
     - If turn ended successfully, show last assistant message
   - **Active turn indicator**:
     - Pulsing left border or subtle glow animation when `turn.isActive` is true
     - Use Tailwind `animate-pulse` on the border or a custom animation
   - **Selected state**:
     - When `isSelected` is true, highlight the card (e.g., blue border) to indicate its slide-out panel is open
   - **Click handler**: Call `onClick(turn)` when the card is clicked
   - **`data-testid` attributes** (required for E2E):
     - `data-testid="turn-block"` on the root card element
     - `data-testid="turn-block-agent-name"` on the agent name span
     - `data-testid="turn-block-stats"` on the stats badge row
     - `data-testid="turn-block-preview"` on the preview area
     - `data-testid="turn-block-active"` on the active indicator (only rendered when active)
3. Style the component with the dark theme (bg-dark-800, border-dark-700, etc.) matching existing room components.
4. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- Component renders all turn data: agent name with color, last action, duration, stats badges, preview.
- Active turns show a pulsing animation.
- Selected turns show a highlighted border.
- Preview area has fixed max-height with overflow scroll.
- Error turns display the error message with appropriate styling.
- Click events fire correctly.
- Zero-count stats badges are hidden.
- All `data-testid` attributes are present for E2E targeting.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 1.1 (needs `ROLE_COLORS` from shared constants), Task 1.2 (needs `TurnBlock` type)

---

### Task 2.2: Unit tests for TurnSummaryBlock

**Agent type:** coder

**Description:**
Write unit tests for the TurnSummaryBlock component covering rendering and interaction.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/__tests__/TurnSummaryBlock.test.tsx`.
3. Mock `SDKMessageRenderer` (following the pattern in `TaskConversationRenderer.test.tsx`).
4. Write test cases:
   - **Basic rendering**: Verify agent name, role color class, stats badges, and duration are rendered.
   - **Active turn**: Verify pulsing animation class is present when `isActive: true`.
   - **Inactive turn**: Verify no animation when `isActive: false`.
   - **Error turn**: Verify error styling and error message are displayed.
   - **Selected state**: Verify highlighted border when `isSelected: true`.
   - **Click handler**: Verify `onClick` is called with the turn data when card is clicked.
   - **Last action badge**: Verify last action text is displayed.
   - **Stats display**: Verify correct counts for tool calls, thinking, and assistant messages.
   - **Zero stats**: Verify badges with zero counts are hidden (not rendered).
   - **data-testid attributes**: Verify all required `data-testid` attributes are present.
   - **Human turn**: Verify rendering of a turn with `agentRole: 'human'` and label "Human".
5. Run tests and verify all pass.
6. Commit and push to the same feature branch, update PR.

**Acceptance Criteria:**
- All test cases pass.
- Tests verify both visual states (active, error, selected) and user interaction (click).
- SDKMessageRenderer is properly mocked.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 2.1
