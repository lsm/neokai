# Milestone 9: Frontend -- Inline "via Neo" Indicators

## Goal

Display subtle attribution indicators in room chats, space workflows, and task views when actions were performed by Neo on behalf of the user.

## Tasks

### Task 9.1: "via Neo" Indicators in Room Chat and Task Views

- **Description**: Add non-intrusive visual indicators to room chat messages and task detail views when they originate from Neo.
- **Agent type**: coder
- **Depends on**: Task 1.4 (origin metadata types and propagation), Task 7.3 (Neo panel)
- **Subtasks**:
  1. **Identify existing components that need modification**: Audit the frontend to find all components that render messages, tasks, or gate approvals. Key files to check:
     - `packages/web/src/components/chat/` — room chat message components
     - Task detail/list components
     - Space workflow/gate components
     - LiveQuery row mappers that need to include the `origin` field in their projections
  2. Create `packages/web/src/components/neo/NeoOriginBadge.tsx`:
     - Small badge component: Neo icon + "via Neo" text
     - Two variants: inline (for message bubbles) and tooltip (shown on hover)
     - Uses subtle styling (muted colors, small font) to be non-intrusive
  3. Update room chat message rendering in `packages/web/src/components/chat/` to:
     - Check message metadata for `origin: 'neo'`
     - Show `NeoOriginBadge` inline (tooltip variant) on hover
  4. Update task detail view to show Neo origin:
     - In the task detail panel, if the task was created by Neo, show origin badge
     - In task status change history, indicate Neo-originated changes
  5. Update gate approval display in space workflow views:
     - If a gate was approved/rejected by Neo, show "via Neo" indicator
  6. Update existing LiveQuery row mappers for room messages and tasks to include the `origin` field in their projections (so the frontend has access to origin data)
  7. Ensure indicators are only shown where confusion is likely (not on every message)
  8. Write unit tests for the badge component and integration points
- **Acceptance criteria**:
  - "via Neo" badge renders correctly in both inline and tooltip variants
  - Room chat messages from Neo show the indicator on hover
  - Task creation/updates by Neo show origin in detail view
  - Gate approvals by Neo show origin indicator
  - Indicators are subtle and non-intrusive
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
