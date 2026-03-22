# Milestone 3: Slide-Out Panel

## Goal

Build a reusable right-side slide-out panel component that mounts the existing `ChatContainer` by session ID, with smooth transition animation. Verify that mounting a secondary ChatContainer instance doesn't cause side effects.

## Tasks

### Task 3.1: Implement SlideOutPanel component

**Agent type:** coder

**Description:**
Create a `SlideOutPanel` component that slides in from the right side of the task view container and renders `ChatContainer` for a given session ID. Only one panel can be open at a time.

**Subtasks (ordered implementation steps):**

1. Run `bun install` at the worktree root.
2. Investigate and resolve `ChatContainer.tsx` side effects when mounting a secondary instance:
   - Check session selection state management (line 84+) and cleanup logic (line 521) for conflicts.
   - **Known issue**: `ChatContainer` calls `sessionStore.select()` which modifies global signal state. The `readonly` prop exists but does not suppress this call. Preact signals are global singletons and cannot be scoped with a context provider.
   - **Preferred strategy**: Add a new prop `suppressSelection?: boolean` to `ChatContainer` that skips the `sessionStore.select()` call when true. The slide-out panel passes `suppressSelection={true}`. This is a minimal, targeted change to `ChatContainer` (adding a conditional guard around one line) that doesn't affect existing callers.
   - **Fallback strategy**: If modifying `ChatContainer` proves too risky (e.g., the selection call has downstream effects), create a thin wrapper `ReadonlyChatContainer` that mounts `ChatContainer` after saving/restoring the session selection state via `useEffect` cleanup. **Caveat**: The existing cleanup in `ChatContainer` uses `setTimeout(() => {}, 0)` (deferred), so the save/restore wrapper must account for this async timing — use a matching `setTimeout` in the restore to run after ChatContainer's deferred cleanup.
   - Document the chosen approach and any findings in the PR description.
3. Create `packages/web/src/components/room/SlideOutPanel.tsx` with the following:
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
     - **Absolutely positioned** within the task view container (NOT `position: fixed` on the viewport) — this prevents the panel from bleeding over the left navigation columns in the three-column Room layout.
     - Width: ~50% of the task view container on desktop, 100% on mobile (use responsive Tailwind classes).
     - Full height of the parent container.
     - Semi-transparent backdrop overlay scoped to the task view container that closes the panel on click.
   - **Header**:
     - Agent name/label with role color (import `ROLE_COLORS` from shared constants)
     - Close button (X icon) on the right
   - **Body**:
     - Mount `ChatContainer` with `sessionId={sessionId}` and `readonly={true}` when `isOpen && sessionId`
     - Apply any isolation needed based on the investigation in step 2
   - **Transition animation**:
     - Slide-in from right: use CSS `transform: translateX(100%)` to `translateX(0)` with Tailwind `transition-transform duration-300`
     - Backdrop fade-in with `transition-opacity`
   - **Keyboard support**:
     - Close on Escape key press
   - **Accessibility**:
     - `role="dialog"` and `aria-modal="true"` on the panel container
     - Focus trapping: when panel opens, focus moves to the close button; Tab cycles within the panel
     - On close, return focus to the trigger element (the clicked turn block)
     - `aria-label` on the panel describing the content (e.g., "Session chat for Worker")
   - **`data-testid` attributes**:
     - `data-testid="slide-out-panel"` on the root panel element
     - `data-testid="slide-out-panel-close"` on the close button
     - `data-testid="slide-out-panel-header"` on the header
     - `data-testid="slide-out-backdrop"` on the backdrop overlay
4. Add the CSS transitions using Tailwind utility classes (no custom CSS needed).
5. Create a feature branch, commit, and create a PR via `gh pr create` targeting `dev`.

**Acceptance Criteria:**
- Panel slides in from the right with smooth animation.
- Panel is absolutely positioned within the task view container (not fixed to viewport).
- Panel renders ChatContainer for the given session ID in readonly mode.
- ChatContainer side effects are investigated and mitigated (documented in PR).
- Panel has a header with agent label and close button.
- Clicking the backdrop closes the panel.
- Pressing Escape closes the panel.
- Panel is responsive (wider on desktop, full-width on mobile).
- Only one panel can be open at a time (managed by parent via `isOpen` prop).
- Accessibility: `role="dialog"`, `aria-modal`, focus trapping, focus restoration.
- All `data-testid` attributes are present.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** None (ChatContainer already exists and accepts `sessionId` prop). **Note**: The preferred isolation strategy adds a `suppressSelection` prop to `ChatContainer.tsx` — this is a minimal one-line conditional guard, not a structural change to the component.

---

### Task 3.2: Unit tests for SlideOutPanel

**Agent type:** coder

**Description:**
Write unit tests for the SlideOutPanel component covering open/close behavior, rendering, and accessibility.

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
   - **Accessibility attributes**: Verify `role="dialog"`, `aria-modal="true"`, and `aria-label` are present.
   - **data-testid attributes**: Verify all required `data-testid` attributes are present.
   - **suppressSelection isolation**: Verify that when ChatContainer is mounted in the slide-out panel, it receives `suppressSelection={true}`. Spy on `sessionStore.select` and confirm it is NOT called when the panel opens (verifying the isolation strategy from Task 3.1).
5. Run tests and verify all pass.
6. Commit and push to the same feature branch, update PR.

**Acceptance Criteria:**
- All test cases pass.
- ChatContainer is properly mocked.
- Open/close transitions are tested via CSS class assertions.
- Accessibility attributes are verified.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Dependencies:** Task 3.1
