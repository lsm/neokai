# Milestone 8: Frontend -- Action Confirmation UI and Settings

## Goal

Build the action confirmation workflow UI and Neo-specific settings in the global settings page.

## Tasks

### Task 8.1: Action Confirmation Components

- **Description**: Create UI components for Neo's action confirmation workflow, displayed inline in the chat when Neo needs user approval before executing an action.
- **Agent type**: coder
- **Depends on**: Task 7.3
- **Subtasks**:
  1. Create `packages/web/src/components/neo/NeoActionCard.tsx`:
     - Card component for pending action confirmations
     - Shows: action description, target (room/space/skill name), risk level badge
     - For `confirm` tier: Two buttons: "Confirm" (green) and "Cancel" (red/grey)
     - Clicking Confirm calls `neoStore.confirmAction(actionId)`
     - Clicking Cancel calls `neoStore.cancelAction(actionId)`
     - For `require_explicit` tier: Shows a text input with the required confirmation phrase (e.g., "Type DELETE my-project to confirm"). Submit validates the phrase via `neo.confirm_explicit` RPC.
     - No chat-text confirmation parsing — confirmations use dedicated UI buttons/inputs only
  2. Create `packages/web/src/components/neo/NeoActionResult.tsx`:
     - Inline indicator for auto-executed actions: subtle checkmark with description
     - Inline indicator for failed actions: error icon with message and "Retry" button
     - Inline indicator for undone actions: subtle undo icon with description
  3. Integrate these components into `NeoMessageBubble.tsx`:
     - Detect message types: plain text, action confirmation, action result
     - Render appropriate component based on message type
  4. Write unit tests for confirmation and result components
- **Acceptance criteria**:
  - Pending confirmations show as interactive cards in the chat
  - Confirm/Cancel buttons work and update the action status
  - Auto-executed actions show subtle success indicators
  - Failed actions show error state with retry option
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 8.2: Neo Settings Section

- **Description**: Add a Neo configuration section to the global settings page where users can set their preferred security mode, select Neo's model, and manage the Neo session.
- **Agent type**: coder
- **Depends on**: Task 7.1
- **Subtasks**:
  1. Create `packages/web/src/components/settings/NeoSettings.tsx`:
     - Security mode selector: three radio buttons or a dropdown with descriptions
       - Conservative: "Confirm every action"
       - Balanced (default): "Auto-execute low-risk, confirm medium and high-risk"
       - Autonomous: "Execute all actions immediately"
     - Model selector: dropdown showing available models (reuse existing model selector pattern)
     - "Clear Neo Session" button with confirmation dialog
     - Brief description of what Neo is and how security modes work
  2. Integrate into the existing settings page layout (find the settings component structure in `packages/web/src/components/settings/`)
  3. Wire settings changes to `neo.settings` RPC endpoint
  4. Read current settings from `GlobalSettings.neo` on mount
  5. Write unit tests
- **Acceptance criteria**:
  - Security mode selector displays all three modes with descriptions
  - Changing security mode persists via RPC
  - Model selector shows available models
  - Clear session button works with confirmation
  - Settings section integrates cleanly with existing settings page
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
