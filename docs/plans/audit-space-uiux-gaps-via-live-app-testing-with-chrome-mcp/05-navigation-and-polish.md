# Milestone 5: Navigation and Polish

## Goal

Improve navigation within the space detail view and fix minor polish issues identified in the audit.

## Scope

- Add breadcrumb navigation for space detail
- Fix SpaceAgentList padding consistency (moved from M1 — independent P3 work)
- Remove emojis from SpaceContextPanel and ContextPanel.tsx
- Remove unused SpaceNavPanel component and its tests
- Comprehensive E2E navigation test

## Tasks

### Task 5.1: Add Breadcrumb Navigation for Space Detail

**Description:** When viewing `/space/:id`, there is no visible breadcrumb or back navigation to return to the spaces list. The user must rely on the NavRail ContextPanel to navigate back. Add a breadcrumb bar above the tab bar in SpaceIsland.

**Agent type:** coder

**Subtasks:**
1. In `SpaceIsland.tsx`, add a breadcrumb bar above the tab bar showing: "Spaces" (link to `/spaces`) > Space Name
2. "Spaces" link calls `navigateToSpaces()` on click
3. Space name is read from `spaceStore.space.value?.name`
4. Style: small text, gray color, hover highlight on "Spaces" link, separator chevron
5. Hide breadcrumb when workflow editor is open (same as tab bar)
6. Write unit test verifying breadcrumb renders with space name and navigates on click

**Acceptance criteria:**
- Breadcrumb appears above tabs showing "Spaces > {Space Name}"
- Clicking "Spaces" navigates back to the spaces list
- Breadcrumb hidden during workflow editor mode

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 5.2: Remove Emojis, Fix Padding, and Remove Unused SpaceNavPanel

**Description:** Fix minor polish issues: remove emojis from space-related components (including `ContextPanel.tsx`), fix SpaceAgentList padding inconsistency, and remove the unused SpaceNavPanel component.

**Agent type:** coder

**Subtasks:**
1. In `SpaceContextPanel.tsx`, replace the rocket emoji (`<div class="text-3xl mb-2">🚀</div>`) in the empty state with an SVG icon consistent with the rest of the space UI (e.g., a grid/layout icon or plus-circle icon)
2. In `packages/web/src/islands/ContextPanel.tsx`, replace the rocket emoji on line 207 (`emptyIcon: '🚀'`) with an appropriate SVG icon or text icon matching the spaces section
3. Search all `packages/web/src/components/space/` AND `packages/web/src/islands/` files for remaining emojis in production code (excluding test files) and replace with SVG icons
4. **Fix SpaceAgentList padding**: In `SpaceIsland.tsx`, wrap the `<SpaceAgentList />` render in a div with `class="p-6 h-full overflow-y-auto"` (or add padding directly in SpaceAgentList's root div) to match Dashboard and Settings tabs which use `p-6`
5. **Remove SpaceNavPanel**: Delete `packages/web/src/components/space/SpaceNavPanel.tsx` and its test file `packages/web/src/components/space/__tests__/SpaceNavPanel.test.tsx`. Remove the export from `packages/web/src/components/space/index.ts` line 10. This component was built for a left-panel layout that was replaced with tabs; it is not imported or rendered anywhere.
6. Update any affected tests; run `bun run check` to verify no dead exports remain

**Acceptance criteria:**
- No emojis in space component or ContextPanel production code
- Empty states use SVG icons instead of emoji
- SpaceAgentList has consistent padding with Dashboard and Settings tabs
- SpaceNavPanel.tsx, its test file, and its export are removed
- `bun run check` passes (no dead exports)

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 5.3: Add Comprehensive Space Navigation E2E Test

**Description:** Create an E2E test that exercises the full space navigation flow: spaces list, create space, navigate between tabs, deep link to task, breadcrumb back.

**Agent type:** coder

**Subtasks:**
1. Create `packages/e2e/tests/features/space-navigation.e2e.ts`
2. Test: Navigate to Spaces via NavRail, verify ContextPanel shows space list
3. Test: Create a space, verify navigation to space detail, verify all 4 tabs are clickable and render content
4. Test: Navigate back via breadcrumb, verify return to spaces list
5. Test: Click space in ContextPanel thread list, verify it opens space detail
6. Test: Verify deep link `/space/:id` loads the space directly
7. Clean up created space in afterEach

**Acceptance criteria:**
- All navigation paths work correctly
- Deep links load the correct space
- Breadcrumb navigation works
- E2E test passes

**Dependencies:** Task 5.1, Task 1.2

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
