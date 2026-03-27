# Milestone 9: Inline "via Neo" Indicators

## Goal

Show subtle attribution badges in the UI where Neo has taken actions, so users can distinguish Neo-initiated actions from direct human actions.

## Scope

- "via Neo" badge on messages in room chat that were sent by Neo
- Indicator on gate approvals in space workflow views
- Indicator on tasks created/updated by Neo in task detail views

## Tasks

### Task 9.1: Via Neo Badge Component and Room Chat Integration

**Description**: Create a reusable "via Neo" badge and integrate it into room chat messages.

**Subtasks**:
1. Create `packages/web/src/components/neo/ViaNeoIndicator.tsx`:
   - Small, non-intrusive badge/icon (e.g., sparkle icon + "via Neo" text)
   - Shown on hover or as subtle metadata (configurable via prop)
   - Dark theme styling consistent with the app
2. Update room chat message rendering (`packages/web/src/components/chat/` area):
   - Check message `origin` field
   - If `origin === 'neo'`, render `ViaNeoIndicator` alongside the message
   - Show on hover to keep the UI clean
3. Update space workflow gate approval view:
   - If a gate was approved/rejected by Neo (check origin metadata), show indicator
4. Update task detail view:
   - If a task was created or status-changed by Neo, show indicator in the task detail header or metadata section
5. All indicators are non-intrusive: visible but not distracting
6. Add component unit test for `ViaNeoIndicator`

**Acceptance Criteria**:
- "via Neo" indicator appears on messages originated by Neo
- Indicator appears on Neo-approved gates
- Indicator appears on Neo-modified tasks
- All indicators are subtle and non-intrusive
- Unit test passes

**Dependencies**: Task 6.1 (origin metadata must be available)

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
