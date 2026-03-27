# Milestone 5: Navigation and Polish

## Goal

Improve navigation within the space detail view and fix minor polish issues identified in the audit.

## Scope

- Add breadcrumb navigation for space detail
- Remove emoji from SpaceContextPanel empty state
- Clean up unused SpaceNavPanel component or integrate it

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

### Task 5.2: Remove Emoji and Fix Minor Polish Issues

**Description:** Fix minor issues identified in the audit: remove emoji from SpaceContextPanel, evaluate SpaceNavPanel usage.

**Agent type:** coder

**Subtasks:**
1. In `SpaceContextPanel.tsx`, replace the rocket emoji (`<div class="text-3xl mb-2">🚀</div>`) in the empty state with an SVG icon consistent with the rest of the space UI
2. Add a suitable SVG icon (e.g., a space/grid icon or the same plus-circle icon used elsewhere)
3. Evaluate `SpaceNavPanel.tsx` — if it is not imported or used anywhere, add a comment noting it as a reserved component for future left-panel layout, or remove it if it duplicates SpaceContextPanel functionality
4. Verify no other emojis exist in space component files (excluding test files)
5. Update any affected tests

**Acceptance criteria:**
- No emojis in space component production code
- Empty state in SpaceContextPanel uses an SVG icon instead
- SpaceNavPanel has a clear status (documented or removed)

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
