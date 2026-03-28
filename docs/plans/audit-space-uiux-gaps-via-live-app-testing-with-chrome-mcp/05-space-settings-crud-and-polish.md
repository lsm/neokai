# Milestone 5: Space Settings CRUD + Polish

## Goal

Complete the space lifecycle management UI (edit, archive, delete) and fix remaining polish issues (padding, emojis, dead components).

## Tasks

### Task 5.1: Add Space Edit, Archive, and Delete UI to SpaceSettings

**Description:** Add inline editing for space name/description and archive/delete actions to SpaceSettings. Currently it displays read-only metadata; the store methods exist but have no UI triggers.

**Agent type:** coder

**Key files to reference:**
- `packages/web/src/components/space/SpaceSettings.tsx` — the file to modify
- `packages/web/src/components/room/RoomSettings.tsx` — pattern to follow (has edit, archive, delete with confirmation)
- `packages/web/src/lib/space-store.ts` — `updateSpace()`, `archiveSpace()`, `deleteSpace()` methods

**Subtasks:**
1. Add an "Edit" button next to the space name/description section. When editing, convert to input/textarea with Save/Cancel buttons
2. Wire Save to `spaceStore.updateSpace({ name, description })`. Add validation: name required (non-empty after trim)
3. Add a "Danger Zone" section at the bottom (matching RoomSettings pattern) with "Archive Space" and "Delete Space" buttons
4. "Archive Space" opens a confirmation modal; calls `spaceStore.archiveSpace()`. "Delete Space" opens a danger confirmation modal; calls `spaceStore.deleteSpace()`
5. Both archive/delete redirect to `/spaces` via `navigateToSpaces()` after success
6. Verify archived spaces are visible under the existing "Archived" filter tab in SpaceContextPanel (filter tabs already exist at lines 254-258)
7. Write unit test covering: edit mode toggle, validation, save, cancel, archive confirmation, delete confirmation
8. Add E2E test: navigate to settings, edit name, save, verify; archive space, verify redirect

**Acceptance criteria:**
- Users can edit space name and description inline
- Save persists changes and shows success toast
- Archive shows confirmation, archives space, redirects to spaces list
- Delete shows danger confirmation, deletes space, redirects to spaces list
- Unit and E2E tests pass

**Dependencies:** None (independent milestone)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 5.2: Fix Padding, Remove Emojis, Remove SpaceNavPanel

**Description:** Fix SpaceAgentList padding inconsistency, remove all emojis from space-related production code, and remove the unused SpaceNavPanel component.

**Agent type:** coder

**Subtasks:**
1. **Fix padding**: In `SpaceIsland.tsx`, wrap `<SpaceAgentList />` in a div with `class="p-6 h-full overflow-y-auto"` to match Dashboard and Settings tabs
2. **Remove emojis**: In `SpaceContextPanel.tsx`, replace the rocket emoji (`🚀`) in the empty state with an SVG icon (e.g., grid/layout icon). In `ContextPanel.tsx`, replace `emptyIcon: '🚀'` on line 207 with an SVG icon. Search `packages/web/src/components/space/` AND `packages/web/src/islands/` for any remaining emojis in production code
3. **Remove SpaceNavPanel**: Delete `packages/web/src/components/space/SpaceNavPanel.tsx` and its test `packages/web/src/components/space/__tests__/SpaceNavPanel.test.tsx`. Remove the export from `packages/web/src/components/space/index.ts`. This component was built for a left-panel layout that was replaced with tabs; it is not rendered anywhere
4. Run `bun run check` to verify no dead exports or lint issues remain
5. Update any affected tests

**Acceptance criteria:**
- SpaceAgentList has consistent padding with other tabs
- No emojis in space component or ContextPanel production code
- SpaceNavPanel.tsx, its test file, and its export are removed
- `bun run check` passes

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 5.3: Add Comprehensive Space Navigation E2E Test

**Description:** Create an E2E test that exercises the full two-layer space navigation flow, verifying the ContextPanel switching, agent chat access, task drill-down, and back navigation.

**Agent type:** coder

**Subtasks:**
1. Create `packages/e2e/tests/features/space-navigation.e2e.ts`
2. Test Level 1 → Level 2 transition: Navigate to Spaces via NavRail → verify SpaceContextPanel shows in sidebar → click a space → verify SpaceDetailPanel shows (with Dashboard and Space Agent pinned items)
3. Test Space Agent: Click "Space Agent" in SpaceDetailPanel → verify ChatContainer renders in content area → verify Space Agent is highlighted in sidebar
4. Test Dashboard: Click "Dashboard" in SpaceDetailPanel → verify tab view returns → verify all 4 tabs are clickable
5. Test Task navigation: Click a task in SpaceDetailPanel → verify full-width task view renders → click back → verify tabs return
6. Test Level 2 → Level 1: Click back button in ContextPanel header → verify SpaceContextPanel returns → verify content shows SpacesPage
7. Test deep link: Navigate directly to `/space/:id/agent` → verify space loads with agent chat
8. Clean up created test data in afterEach

**Acceptance criteria:**
- All two-layer navigation paths work correctly
- ContextPanel switches between levels correctly
- Agent chat, task view, and dashboard all render from ContextPanel navigation
- Deep links work
- E2E test passes

**Dependencies:** Task 1.2, Task 2.3, Task 3.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
