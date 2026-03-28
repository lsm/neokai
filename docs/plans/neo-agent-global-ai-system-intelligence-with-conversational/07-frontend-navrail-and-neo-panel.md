# Milestone 7: Frontend -- NavRail Input and Neo Panel

## Goal

Build the primary Neo UI: a persistent input bar in the NavRail and a slide-out panel with full chat history and activity feed.

## Tasks

### Task 7.1: Neo Store and RPC Client

- **Description**: Create the frontend signal store and RPC client for Neo communication, following the pattern of existing stores like `skills-store.ts` and `room-store.ts`.
- **Agent type**: coder
- **Depends on**: Task 6.1, Task 6.2
- **Subtasks**:
  1. Create `packages/web/src/lib/neo-store.ts`
  2. Implement `NeoStore` class with Preact signals:
     - `messages: Signal<NeoMessage[]>` -- chat messages
     - `activityLog: Signal<NeoActionLog[]>` -- action history
     - `pendingActions: Signal<NeoActionLog[]>` -- actions awaiting confirmation
     - `isLoading: Signal<boolean>` -- whether Neo is processing
     - `isPanelOpen: Signal<boolean>` -- panel visibility (persisted to localStorage)
     - `activeTab: Signal<'chat' | 'activity'>` -- current panel tab
  3. Implement methods:
     - `sendMessage(content: string): Promise<void>` -- calls `neo.send` RPC
     - `loadHistory(): Promise<void>` -- calls `neo.history` RPC
     - `confirmAction(actionId: string): Promise<void>` -- calls `neo.confirm_action`
     - `cancelAction(actionId: string): Promise<void>` -- calls `neo.cancel_action`
     - `clearSession(): Promise<void>` -- calls `neo.clear_session`
     - `loadActivityLog(): Promise<void>` -- calls `neo.activity_log`
  4. Subscribe to LiveQueries (`neo.messages`, `neo.activity`, `neo.pending_actions`) for real-time updates
  5. Initialize store from localStorage on construction (panel open/closed state)
  6. Export singleton instance
  7. Write unit tests in `packages/web/src/__tests__/neo-store.test.ts`
- **Acceptance criteria**:
  - Store provides reactive signals for all Neo state
  - RPC methods correctly call backend endpoints
  - LiveQuery subscriptions provide real-time updates
  - Panel open/closed state persists across page reloads
  - Unit tests cover store methods
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 7.2: NavRail Neo Input Bar

- **Description**: Add a persistent Neo input bar to the NavRail component that allows users to start a conversation with Neo from any context.
- **Agent type**: coder
- **Depends on**: Task 7.1
- **Subtasks**:
  1. Create `packages/web/src/components/neo/NeoInputBar.tsx`:
     - Compact text input with Neo icon/branding
     - Pressing Enter sends the message via `neoStore.sendMessage()` and opens the panel
     - Keyboard shortcut Cmd+K (or Ctrl+K) focuses the input from anywhere
     - Visual indicator when Neo is processing (subtle loading state)
  2. Add `NeoInputBar` to `NavRail.tsx`:
     - Position between the logo and nav items (or at the bottom above settings)
     - Distinct visual treatment from nav buttons (input field, not icon button)
  3. Register the Cmd+K global keyboard shortcut:
     - Create hook or utility in `packages/web/src/hooks/useNeoShortcut.ts`
     - Register on app mount, clean up on unmount
     - Prevent conflict with browser's default Cmd+K (address bar focus). Note: Firefox does not allow overriding Cmd+K — document this limitation.
  4. Mobile handling: NavRail is `hidden md:relative` so NeoInputBar follows the same responsive pattern — hidden on mobile. A mobile-specific entry point is out of scope for this plan.
  5. Write unit tests for the input component
- **Acceptance criteria**:
  - Input bar is visible in the NavRail on desktop layouts (hidden on mobile, matching NavRail behavior)
  - Typing and pressing Enter sends a message and opens the Neo panel
  - Cmd+K focuses the Neo input from anywhere in the app
  - Loading state is visible while Neo processes
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 7.3: Neo Panel -- Chat View

- **Description**: Build the slide-out Neo panel with the chat interface for viewing and continuing conversations with Neo.
- **Agent type**: coder
- **Depends on**: Task 7.1, Task 7.2
- **Subtasks**:
  1. Create `packages/web/src/components/neo/NeoPanel.tsx`:
     - Slide-out panel from the left side (next to NavRail)
     - Header with Neo branding, tab switcher (Chat | Activity), close button
     - Message list rendering user and Neo messages
     - Input bar at the bottom for continued conversation
     - Click outside or close button dismisses the panel
     - Animate in/out with CSS transitions
  2. Create `packages/web/src/components/neo/NeoMessageBubble.tsx`:
     - User messages: right-aligned, minimal styling
     - Neo messages: left-aligned with Neo avatar
     - Support for structured data rendering (JSON objects shown as formatted cards/tables)
     - Support for action confirmation cards (see Milestone 8)
     - Timestamp display
  3. Create `packages/web/src/components/neo/NeoActivityFeed.tsx`:
     - Scrollable list of action log entries
     - Each entry shows: timestamp, action type, target description, status (badge/icon)
     - Color-coded status: green (success), yellow (pending), red (failed), grey (undone)
  4. Mount `NeoPanel` in the app's root layout (likely `MainContent.tsx` or the app shell)
  5. Wire panel visibility to `neoStore.isPanelOpen`
  6. Write unit tests for panel components
- **Acceptance criteria**:
  - Panel slides in/out smoothly with animation
  - Chat messages render correctly for both user and Neo
  - Structured data (JSON) renders as formatted cards, not raw text
  - Activity feed shows action history with status badges
  - Tab switching between Chat and Activity works
  - Panel dismisses on close button or click outside
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
