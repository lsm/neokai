# Milestone 3: Slide-Out Panel

## Goal

Build a reusable right-side slide-out panel component that mounts the existing `ChatContainer` by session ID, with smooth transition animation.

## Tasks

### Task 3.1: Implement SlideOutPanel component

**Agent type:** coder

**Description:**
Create a `SlideOutPanel` component that slides in from the right side of the screen and renders `ChatContainer` for a given session ID. Only one panel can be open at a time.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/SlideOutPanel.tsx` with the following:
   - **Props**:
     ```
     {
       isOpen: boolean;
       sessionId: string | null;
       agentLabel?: string;     // e.g., "Worker" or "Leader"
       agentRole?: string;      // for role color
       onClose: () => void;
     }
     ```
   - **Layout**:
     - Fixed position panel on the right side, overlaying the task view
     - Width: ~50% of viewport on desktop, 100% on mobile (use responsive Tailwind classes)
     - Full height of the parent container
     - Semi-transparent backdrop overlay that closes the panel on click
   - **Header**:
     - Agent name/label with role color
     - Close button (X icon) on the right
   - **Body**:
     - Mount `ChatContainer` with `sessionId={sessionId}` and `readonly={true}` when `isOpen && sessionId`
     - The ChatContainer already handles message loading, streaming, and rendering
   - **Transition animation**:
     - Slide-in from right: use CSS `transform: translateX(100%)` to `translateX(0)` with Tailwind `transition-transform duration-300`
     - Backdrop fade-in with `transition-opacity`
   - **Keyboard support**:
     - Close on Escape key press
3. Add the CSS transitions using Tailwind utility classes (no custom CSS needed).
4. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- Panel slides in from the right with smooth animation.
- Panel renders ChatContainer for the given session ID in readonly mode.
- Panel has a header with agent label and close button.
- Clicking the backdrop closes the panel.
- Pressing Escape closes the panel.
- Panel is responsive (wider on desktop, full-width on mobile).
- Only one panel can be open at a time (managed by parent via `isOpen` prop).

**Dependencies:** None (ChatContainer already exists and accepts `sessionId` prop)

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.2: Unit tests for SlideOutPanel

**Agent type:** coder

**Description:**
Write unit tests for the SlideOutPanel component covering open/close behavior and rendering.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Create `packages/web/src/components/room/__tests__/SlideOutPanel.test.tsx`.
3. Mock `ChatContainer` (the default export from `../../islands/ChatContainer.tsx`) to avoid complex session loading.
4. Write test cases:
   - **Closed state**: When `isOpen: false`, panel is not visible (has translate-x-full or similar).
   - **Open state**: When `isOpen: true` with a sessionId, panel is visible and ChatContainer is mounted with correct sessionId and readonly=true.
   - **Close button**: Clicking close button calls `onClose`.
   - **Backdrop click**: Clicking the backdrop overlay calls `onClose`.
   - **Escape key**: Pressing Escape calls `onClose`.
   - **Agent label display**: Header shows the agent label with correct role color.
   - **Null sessionId**: When sessionId is null and isOpen is true, panel shows a placeholder or does not mount ChatContainer.
5. Run tests and verify all pass.
6. Commit and push to the same feature branch, update PR.

**Acceptance Criteria:**
- All test cases pass.
- ChatContainer is properly mocked.
- Open/close transitions are tested via CSS class assertions.

**Dependencies:** Task 3.1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
