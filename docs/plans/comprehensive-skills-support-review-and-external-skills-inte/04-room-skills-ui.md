# Milestone 4: Room Settings UI — Per-Room Skill Enablement

## Milestone Goal

Extend the Room Settings panel with a "Skills" section that shows all globally-registered skills and lets users toggle them on/off per room.

## Tasks

---

### Task 4.1: Room Skills LiveQuery Store and Hook

**Agent type:** coder

**Description:**
Add a client-side store and hook `useRoomSkills` that subscribes to the `skills.byRoom` LiveQuery for real-time skill updates (including per-room overrides merged at the DB layer). This follows ADR 0001 — no manual RPC polling for DB-backed state.

**How LiveQuery replaces manual merging:**
The `skills.byRoom` named query (registered in Task 2.4) already JOINs `skills` with `room_skill_overrides` and returns the effective `enabled` state and `overriddenByRoom` flag per skill. The frontend does not need to merge two lists — it receives the pre-merged result from the server and gets live deltas on any change (skill added globally, override changed, skill deleted).

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Add a `roomSkills` signal and subscription logic to `packages/web/src/lib/room-store.ts` (following the same pattern as `goals` and `tasks` subscriptions):
   - Signal: `readonly roomSkills = signal<EffectiveRoomSkill[]>([])`
   - Where `EffectiveRoomSkill = AppSkill & { overriddenByRoom: boolean }` — the `enabled` field on `AppSkill` already carries the effective (merged) value from the `skills.byRoom` LiveQuery JOIN; no separate `effectivelyEnabled` alias needed
   - In `subscribeRoom(roomId)`: generate `skillsSubId = \`skills-byRoom-${roomId}\``
   - Register `liveQuery.snapshot` and `liveQuery.delta` handlers with stale-event guard (check `activeSubscriptionIds`)
   - Issue `liveQuery.subscribe` RPC with `queryName: 'skills.byRoom'`, `params: [roomId]`, `subscriptionId: skillsSubId`
   - Register reconnection handler (`hub.onConnection`) to re-subscribe on reconnect
   - In `unsubscribeRoom(roomId)`: remove `skillsSubId` from `activeSubscriptionIds`, call `liveQuery.unsubscribe`
3. Create `packages/web/src/hooks/useRoomSkills.ts`:
   - Thin hook over `roomStore.roomSkills` signal
   - Returns `{ skills: EffectiveRoomSkill[]; setOverride: (skillId, enabled) => Promise<void>; clearOverride: (skillId) => Promise<void> }`
   - `setOverride` calls `room.setSkillOverride` RPC (update triggers LiveQuery delta automatically)
   - `clearOverride` calls `room.clearSkillOverride` RPC
4. Write unit tests in `packages/web/src/hooks/useRoomSkills.test.ts`:
   - Test that snapshot events populate the skills signal
   - Test that delta events (add/remove/update) are applied correctly
   - Test stale-event guard (events after unsubscribe are discarded)
   - Test `setOverride` and `clearOverride` call correct RPCs

**Acceptance criteria:**
- Room skills are delivered via `liveQuery.subscribe` (not one-shot RPC fetch)
- Snapshot and delta handlers follow the stale-event guard pattern
- Reconnection handler re-subscribes on reconnect
- `setOverride` / `clearOverride` mutate via RPC; LiveQuery pushes the update back automatically
- Unit tests pass
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.4: LiveQuery Integration for Skills Tables", "Task 3.2: Room-Level Skill Enablement Persistence (room_skill_overrides table)"]

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
