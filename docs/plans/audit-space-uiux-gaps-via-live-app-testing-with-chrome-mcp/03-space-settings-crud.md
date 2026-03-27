# Milestone 3: Space Settings CRUD

## Goal

Allow users to edit space metadata (name, description) and delete/archive spaces from the Settings tab, completing the space lifecycle management UI.

## Scope

- Add inline editing for space name and description in SpaceSettings
- Add archive and delete actions with confirmation modals
- Handle navigation after archive/delete (redirect to /spaces)

## Tasks

### Task 3.1: Add Space Edit UI to SpaceSettings

**Description:** Add inline editing capability for space name and description in the SpaceSettings component. Currently it displays read-only metadata; the `spaceStore.updateSpace()` method exists but has no UI trigger.

**Agent type:** coder

**Subtasks:**
1. In `SpaceSettings.tsx`, add an "Edit" button next to the space name/description section
2. When editing, convert name to an input field and description to a textarea, with Save/Cancel buttons
3. Wire Save to `spaceStore.updateSpace({ name, description })` RPC call
4. Show success toast on save; revert to read-only mode
5. Add validation: name required (non-empty after trim)
6. Write unit test covering: edit mode toggle, validation, save success, cancel

**Acceptance criteria:**
- Users can click Edit to modify space name and description
- Save persists changes via RPC and updates the UI
- Cancel reverts to original values
- Empty name shows validation error

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

### Task 3.2: Add Space Archive and Delete UI

**Description:** Add archive and delete actions to SpaceSettings with proper confirmation modals and post-action navigation.

**Agent type:** coder

**Subtasks:**
1. In `SpaceSettings.tsx`, add a "Danger Zone" section at the bottom with "Archive Space" and "Delete Space" buttons
2. "Archive Space" opens a ConfirmModal explaining that archived spaces can be restored; calls `spaceStore.archiveSpace()`
3. "Delete Space" opens a ConfirmModal with danger variant warning this is permanent; calls `spaceStore.deleteSpace()`
4. Both actions redirect to `/spaces` via `navigateToSpaces()` after successful completion
5. Handle errors with toast notifications
6. Write unit test covering: archive confirmation flow, delete confirmation flow, cancel dismisses modal
7. Add E2E test: navigate to space settings, archive space, verify redirect to spaces list

**Acceptance criteria:**
- Archive button shows confirmation modal and archives the space on confirm
- Delete button shows danger confirmation modal and deletes on confirm
- Both actions redirect to the spaces list after completion
- Verify archived spaces are visible under the existing "Archived" filter tab in SpaceContextPanel (the filter tabs already exist in `SpaceContextPanel.tsx` lines 254-258)
- E2E test passes

**Dependencies:** None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
