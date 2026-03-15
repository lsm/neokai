# Task 5: UI Terminology -- Goal to Mission Copy Rename

**Agent**: `coder`
**Priority**: `normal`
**Dependencies**: [Task 1](./task-1-schema-types.md)

## Description

Rename all user-facing "Goal" text to "Mission" in the frontend. No new UI features — just terminology. Can run in parallel with backend tasks.

### 1. Terminology rename in UI copy only

- All user-visible text: "Goal" -> "Mission" (labels, headings, buttons, tooltips)
- Component names can optionally rename (e.g., `GoalList` -> `MissionList`) but this is cosmetic
- RoomStore signals keep `goal` naming internally; event subscriptions stay `goal.*`
- Import `Mission` type alias from shared types

## Acceptance Criteria

- All user-visible "Goal" text replaced with "Mission"
- Backend event subscriptions still use `goal.*` (no backend changes)
- Existing UI functionality unchanged
- E2E test verifying mission terminology is displayed correctly
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
