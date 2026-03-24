# Milestone 5: Settings UI — Global Skills Registry

## Milestone Goal

Build the Skills management UI in the global Settings panel so users can add, configure, enable/disable, and remove skills from the application-level registry.

## Tasks

---

### Task 5.1: Skills Store and Hook

**Agent type:** coder

**Description:**
Create a client-side store and hook for managing the global Skills registry, used by the Settings UI components.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/lib/skills-store.ts`:
   - Signal-based store with `skills: Signal<AppSkill[]>`, `isLoading: Signal<boolean>`, `error: Signal<string | null>`
   - `loadSkills()`: calls `skills.list` RPC and updates signal
   - `addSkill(params: CreateSkillParams)`: calls `skills.add` RPC, updates store
   - `updateSkill(id, params)`: calls `skills.update` RPC, updates store
   - `removeSkill(id)`: calls `skills.remove` RPC, updates store
   - `setEnabled(id, enabled)`: calls `skills.setEnabled` RPC, updates store
3. Create `packages/web/src/hooks/useSkills.ts` — thin hook over the store for component use.
4. Write unit tests in `packages/web/src/lib/skills-store.test.ts`:
   - Test each action with mocked connection manager
   - Test optimistic updates and error rollback

**Acceptance criteria:**
- Skills store and hook are implemented
- All CRUD operations wire through RPC
- Unit tests pass
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.3: Skills RPC Handlers"]

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
     - MCP Server: command field, args (JSON array), env vars (key-value editor)
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

**depends_on:** ["Task 5.1: Skills Store and Hook"]

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
