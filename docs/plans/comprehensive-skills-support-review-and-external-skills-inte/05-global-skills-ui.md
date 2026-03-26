# Milestone 5: Settings UI — Global Skills Registry

## Milestone Goal

Build the Skills management UI in the global Settings panel so users can add, configure, enable/disable, and remove skills from the application-level registry.

## Tasks

---

### Task 5.1: Global Skills LiveQuery Store and Hook

**Agent type:** coder

**Description:**
Create a client-side store and hook for managing the global Skills registry that uses the `skills.list` LiveQuery for real-time updates. Mutations (add, update, remove, setEnabled) go through the CRUD RPC handlers; the LiveQuery subscription automatically receives deltas after each mutation. This follows ADR 0001 — no manual `skills.list` polling.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/lib/skills-store.ts`:
   - Signal-based store: `readonly skills = signal<AppSkill[]>([])`, `readonly isLoading = signal<boolean>(true)`, `readonly error = signal<string | null>(null)`
   - `subscribe()`: issues `liveQuery.subscribe` with `queryName: 'skills.list'`, `params: []`, `subscriptionId: 'skills-global'`
     - Registers `liveQuery.snapshot` handler: sets `skills.value = event.rows` and `isLoading.value = false`
     - Registers `liveQuery.delta` handler: applies `added` / `removed` / `updated` diffs to `skills.value`
     - Registers reconnection handler via `hub.onConnection` to re-subscribe on reconnect
   - `unsubscribe()`: calls `liveQuery.unsubscribe`, clears signal
   - Mutation methods (these trigger LiveQuery deltas automatically):
     - `addSkill(params: CreateSkillParams): Promise<AppSkill>` — calls `skills.add` RPC
     - `updateSkill(id, params): Promise<AppSkill>` — calls `skills.update` RPC
     - `removeSkill(id): Promise<boolean>` — calls `skills.remove` RPC
     - `setEnabled(id, enabled): Promise<AppSkill>` — calls `skills.setEnabled` RPC
   - Export a singleton `skillsStore` instance
3. Create `packages/web/src/hooks/useSkills.ts` — thin hook that calls `skillsStore.subscribe()` on mount / `unsubscribe()` on unmount; returns `{ skills, isLoading, error }` signals.
4. Write unit tests in `packages/web/src/lib/skills-store.test.ts`:
   - Test snapshot sets the skills signal
   - Test delta add/remove/update applies correctly
   - Test that mutations call the correct RPC endpoints
   - Test that reconnection triggers re-subscribe

**Acceptance criteria:**
- Skills are delivered via `liveQuery.subscribe` (not one-shot RPC fetch)
- Snapshot and delta handlers correctly maintain the `skills` signal
- Reconnection re-subscribes automatically
- All four mutation methods call correct RPCs; LiveQuery pushes updates back
- Unit tests pass
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.4: LiveQuery Integration for Skills Tables"]

---

### Task 5.2: Global Skills Registry UI Component

**Agent type:** coder

**Description:**
Build the `SkillsRegistry` component that allows users to view, add, edit, enable/disable, and remove skills from the global registry. This will be embedded in the global Settings panel.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/settings/SkillsRegistry.tsx`:
   - Header with "Skills" title and "Add Skill" button
   - Skill list: each item shows displayName, description, sourceType badge, enabled toggle, edit and delete buttons
   - Empty state: "No skills added yet. Add your first skill."
   - Loading skeleton while `isLoading`
   - Error banner on failure
3. Create `packages/web/src/components/settings/AddSkillDialog.tsx`:
   - Modal dialog for adding a new skill
   - Fields: Display Name, Name (slug, auto-derived from display name), Description, Source Type (radio: Built-in / Plugin / MCP Server)
   - Conditional config fields based on source type:
     - Built-in: command name text field
     - Plugin: plugin directory path field (with a "Browse" tip)
     - MCP Server: dropdown/selector to pick an existing app-level MCP server (populated from `mcp.registry.list` RPC); no separate command/args/env fields — those are managed in the App MCP Servers settings panel
   - Validate required fields before submit
   - Calls `addSkill` from hook
4. Create `packages/web/src/components/settings/EditSkillDialog.tsx`:
   - Same as Add but pre-populated, calls `updateSkill`
   - Shows read-only "ID" and "Created" fields
5. Integrate `SkillsRegistry` into the global settings panel (find the appropriate settings component and add a "Skills" section).
6. Write Vitest tests for `SkillsRegistry`, `AddSkillDialog`, and `EditSkillDialog`.

**Acceptance criteria:**
- Users can view all registered skills in settings
- Users can add skills with correct source-type-specific fields
- Users can edit, delete, and toggle skills
- Component tests pass
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 5.1: Global Skills LiveQuery Store and Hook"]

---

### Task 5.3: E2E Test — Global Skills Registry Management

**Agent type:** coder

**Description:**
Write a Playwright E2E test that exercises adding, enabling/disabling, and removing a skill through the global Settings UI.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/global-skills.e2e.ts`.
3. Test scenarios:
   - Navigate to Settings > Skills
   - Click "Add Skill" — fill in fields for an MCP server skill — submit
   - Verify the new skill appears in the list with correct name and type badge
   - Toggle the skill off — verify the toggle shows disabled state
   - Click Edit — change the description — save — verify description updated
   - Click Delete — confirm — verify skill removed from list
4. All actions through UI clicks/typing; all assertions through DOM state.
5. Run test with `make run-e2e TEST=tests/features/global-skills.e2e.ts`.

**Acceptance criteria:**
- E2E test passes end-to-end
- All four lifecycle actions (add, toggle, edit, delete) verified
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 5.2: Global Skills Registry UI Component"]
