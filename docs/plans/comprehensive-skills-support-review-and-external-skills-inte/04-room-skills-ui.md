# Milestone 4: Room Settings UI — Per-Room Skill Enablement

## Milestone Goal

Extend the Room Settings panel with a "Skills" section that shows all globally-registered skills and lets users toggle them on/off per room.

## Tasks

---

### Task 4.1: Room Skills Store Hook

**Agent type:** coder

**Description:**
Add a client-side hook `useRoomSkills` that fetches the global skill list and the room's skill overrides, merges them into a unified "effective skill list", and provides a setter to update room overrides.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/hooks/useRoomSkills.ts`:
   - Uses `connectionManager` to call `skills.list` RPC to get all global skills
   - Uses `connectionManager` to call `room.getSkillOverrides` RPC to get room-level overrides
   - Returns `{ skills: EffectiveRoomSkill[]; isLoading: boolean; updateOverride: (skillId, enabled) => Promise<void> }`
   - `EffectiveRoomSkill = AppSkill & { effectivelyEnabled: boolean; overriddenByRoom: boolean }`
   - `updateOverride` calls `room.setSkillOverrides` and updates local state
3. Write unit tests in `packages/web/src/hooks/useRoomSkills.test.ts` using mocked connection manager.

**Acceptance criteria:**
- Hook merges global skills with room overrides correctly
- `updateOverride` persists changes via RPC
- Unit tests cover the merge logic
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.3: Skills RPC Handlers", "Task 3.2: Room-Level Skill Enablement Persistence"]

---

### Task 4.2: Room Settings Skills Panel

**Agent type:** coder

**Description:**
Add a "Skills" tab or section to the `RoomSettings.tsx` component that uses `useRoomSkills` to display and manage skill enablement.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/RoomSkillsSettings.tsx`:
   - Uses `useRoomSkills(roomId)` hook
   - Renders a list of skills grouped by source type (built-in, plugin, MCP server)
   - Each row: skill name, description, source type badge, toggle (on/off)
   - Disabled row for built-in skills that are always-on (SDK handles them)
   - "No skills configured" empty state with a link to Global Settings > Skills
3. Integrate `RoomSkillsSettings` into the Room Settings panel in `packages/web/src/components/room/RoomSettings.tsx` (new section after existing sections).
4. Add Vitest tests for `RoomSkillsSettings` in `packages/web/src/components/room/__tests__/RoomSkillsSettings.test.tsx`:
   - Renders skill list correctly
   - Toggle calls `updateOverride`
   - Empty state renders when no skills configured

**Acceptance criteria:**
- Room Settings shows a Skills section with all global skills
- Toggles correctly update room-level overrides via RPC
- Built-in skills are shown but not toggle-able
- Component tests pass (`bunx vitest run`)
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 4.1: Room Skills Store Hook"]

---

### Task 4.3: E2E Test — Room Skills Enablement

**Agent type:** coder

**Description:**
Write a Playwright E2E test that verifies the full room skill enablement flow through the UI.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/room-skills.e2e.ts`.
3. Test scenario:
   - Navigate to a room's settings via the UI
   - Open the Skills section
   - Verify the skill list is visible
   - Toggle a plugin skill off (if any skills are registered) — verify the toggle state persists
   - Toggle it back on — verify it returns to enabled
4. Use `beforeEach`/`afterEach` with `hub.request('room.create', ...)` / `hub.request('room.delete', ...)` for isolation.
5. All assertions must use DOM state (visible text, classes), not internal state.
6. Run test with `make run-e2e TEST=tests/features/room-skills.e2e.ts`.

**Acceptance criteria:**
- E2E test passes end-to-end against a running server
- Test follows E2E rules (UI-only actions, DOM-only assertions)
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 4.2: Room Settings Skills Panel"]
