# Milestone 8: Neo Settings UI

## Goal

Add a settings section where users can configure Neo's behavior: security mode, model, and session management.

## Scope

- New settings section in the Settings page
- Security mode selector (Conservative / Balanced / Autonomous)
- Model selector for Neo
- Clear session button

## Tasks

### Task 8.1: Neo Settings Section

**Description**: Add a Neo configuration section to the Settings page.

**Subtasks**:
1. Create `packages/web/src/components/settings/NeoSettings.tsx`:
   - Section header "Neo Agent"
   - Security mode selector: radio group or dropdown with Conservative / Balanced (default) / Autonomous
   - Description text for each mode explaining the behavior
   - Model selector: dropdown using the same model list as room settings
   - "Clear Session" button: calls `neoStore.clearSession()` with a confirmation dialog
2. Read current settings via `neo.getSettings` RPC on mount
3. Persist changes via `neo.updateSettings` RPC on change
4. Wire into the Settings page component alongside existing sections (General, Providers, MCP, Skills)
5. Add the settings section to the SettingsSection navigation
6. Add unit test for the component (renders, handles changes, calls RPC)

**Acceptance Criteria**:
- Security mode selector works and persists across page reloads
- Model selector shows available models and persists selection
- Clear session shows confirmation dialog and resets Neo on confirm
- Settings section appears in the correct position in the Settings page
- Unit test passes

**Dependencies**: Task 4.1 (neo.getSettings/updateSettings RPC), Task 7.1 (neoStore)

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
