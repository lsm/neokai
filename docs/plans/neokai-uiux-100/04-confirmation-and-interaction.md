# Milestone 04 — Confirmation and Interaction

## Milestone Goal

Solve the primary UX problem: scattered, context-losing task confirmation flows. The core insight is that user action prompts should appear at the user's focal point (near the input area), not buried deep in the message stream. This milestone introduces an "Action Tray" pattern that docks above the message input and redesigns `QuestionPrompt` to live there.

## Milestone Scope

- New `ActionTray` component: a docking panel above `MessageInput` for pending confirmations
- `QuestionPrompt` refactored to work both inline (historical/resolved state in stream) and in the tray (active/pending state)
- `WorktreeChoiceInline` component consolidated into a tray card
- Stop/interrupt button visual refinement
- Tool action confirmation pattern in `ToolResultCard`

---

## Task 4.1 — Design the ActionTray Component

**Agent type:** coder

**Description:**
Create a new `ActionTray` component that lives between the `SessionStatusBar` and `MessageInput` in the `ChatContainer` layout. When there is an active pending question or a workspace mode choice pending, the tray appears. When resolved or empty, the tray disappears with a smooth animation. The tray uses a distinct visual style (slightly elevated from the page, with an indigo left-accent border) to signal "your action is needed here."

**Subtasks (in order):**
1. Create the file `packages/web/src/components/ActionTray.tsx`.
2. Define the component interface:
   ```ts
   interface ActionTrayProps {
     children: ComponentChildren;
     onDismiss?: () => void;
     label?: string; // e.g. "Claude needs your input"
   }
   ```
3. Implement the visual layout:
   - Outer wrapper: `bg-dark-900 border border-dark-700 border-l-2 border-l-indigo-500 rounded-xl mx-4 mb-2 overflow-hidden`
   - A header row with the `label` text in `text-xs font-semibold text-indigo-400 uppercase tracking-wider` and optionally a dismiss icon button on the right.
   - A content area `p-4` for `children`.
4. Add an entrance/exit animation: use a CSS transition on `max-height` and `opacity`. When the tray has content (`children` is non-null), apply `max-h-[500px] opacity-100 transition-all duration-250 ease-out`; when empty, `max-h-0 opacity-0 overflow-hidden transition-all duration-150 ease-in`.
5. Export `ActionTray` from `packages/web/src/components/ui/index.ts` (or create a new barrel if needed).
6. Add a basic test in `packages/web/src/components/__tests__/` that renders `ActionTray` with content and asserts the label and children are present.
7. Run `bun run typecheck`, `bun run lint`, and `bunx vitest run src/components/__tests__/`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- Tests pass
- `ActionTray` renders with label and children correctly
- Tray has indigo left-border accent and dark-900 background
- Entrance animation classes are present in the DOM

**Depends on:** Milestone 02 complete

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 4.2 — Refactor QuestionPrompt for Dual-Mode Rendering

**Agent type:** coder

**Description:**
The existing `QuestionPrompt` component is rendered inline in `SDKAssistantMessage` (inside `ToolUseBlock` for `AskUserQuestion` tools). For pending/active questions, it should instead render in the `ActionTray`. For resolved questions (submitted or cancelled), it should still render inline in the message stream as a compact read-only summary.

This dual-mode approach means we need two rendering modes: `tray` (full interactive form in ActionTray) and `inline` (compact read-only record in message stream).

**Subtasks (in order):**
1. Read `packages/web/src/components/QuestionPrompt.tsx` in full.
2. Add a `mode` prop: `'tray' | 'inline'`. Default is `'inline'` for backward compatibility.
3. Implement `mode='inline'` (resolved-only compact view):
   - Show a single row: `[icon] [question title truncated] [resolution label (Submitted/Skipped)]`
   - Use `bg-dark-800/40 rounded-lg border border-dark-700 px-3 py-2` for the container
   - Resolution states: submitted → green check icon + "Submitted", cancelled → gray X + "Skipped"
   - Do NOT show the options/choices in inline mode — only the resolved state summary
4. Implement `mode='tray'` (full interactive form for pending questions):
   - This is the full current form, but with styling updates: remove the `bg-white dark:bg-gray-900` from the content area (which creates a jarring white block); instead use `bg-dark-900` for the content area.
   - Remove the hard-coded `border-rose-200 dark:border-rose-800` container border — the tray itself will provide the accent border.
   - Keep the rose/pink color scheme for active options (selected state).
   - The submit/cancel buttons remain unchanged.
5. Update `SDKAssistantMessage` → `ToolUseBlock` (`AskUserQuestion` branch):
   - If `resolvedState` is not null: render `<QuestionPrompt mode='inline' ... />` (compact view in stream).
   - If pending (active): do NOT render QuestionPrompt inline — render nothing (an empty fragment) for this tool block. The ActionTray in `ChatContainer` will display the active question (see step 6).
   - Concretely, remove the `pendingQuestion` prop from `SDKAssistantMessage`'s interface — it is no longer needed there. The component receives `resolvedQuestions: Map<string, ResolvedQuestion>` to determine resolved state; for unresolved tool IDs it simply renders nothing.
6. In `ChatContainer.tsx`, wire the ActionTray using the **existing `pendingQuestion` local variable** already computed at line ~396:
   ```ts
   const pendingQuestion = isWaitingForInput ? agentState.pendingQuestion : null;
   ```
   This variable is derived from `agentState.status === 'waiting_for_input'` (which is the live session state from the `state.session` channel — no new signal needed). Add the following JSX between `<SessionStatusBar>` and `<MessageInput>`:
   ```tsx
   {pendingQuestion && (
     <ActionTray label="Claude needs your input" onDismiss={undefined}>
       <QuestionPrompt
         mode="tray"
         sessionId={sessionId}
         pendingQuestion={pendingQuestion}
         onResolved={handleQuestionResolved}
       />
     </ActionTray>
   )}
   ```
   The `handleQuestionResolved` callback already exists in `ChatContainer` (currently passed to `SDKAssistantMessage` as `onQuestionResolved`). Reuse it.
7. Run `bun run typecheck`, `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- Active/pending questions appear in the ActionTray above MessageInput, NOT in the message stream
- Resolved questions appear as compact inline summaries in the message stream
- The options grid for active questions has dark background (no white block)
- The ActionTray is visible when a question is pending and hides when resolved

**Depends on:** Task 4.1, Milestone 02

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 4.3 — WorktreeChoiceInline → ActionTray Migration

**Agent type:** coder

**Description:**
`WorktreeChoiceInline.tsx` is a small inline prompt that asks the user to choose between worktree and direct workspace modes. It renders inline in the message stream via `ChatContainer`. Like `QuestionPrompt`, it should move to the `ActionTray` when awaiting user input, since it is an action-requiring element at the same conceptual level.

**Subtasks (in order):**
1. Read `packages/web/src/components/WorktreeChoiceInline.tsx` and search for its usage in `ChatContainer.tsx`.
2. Refactor `WorktreeChoiceInline` to accept a `mode` prop: `'tray' | 'inline'`. When `mode='inline'`, it renders a compact summary of the chosen mode (e.g., "Worktree mode selected" or "Direct mode selected") with a small edit icon that could re-trigger the tray.
3. When the worktree choice is still pending (unresolved), render `<WorktreeChoiceInline mode='tray' ... />` inside `<ActionTray label="Choose workspace mode">`. Remove the inline rendering from the message stream when pending.
4. After the user makes a selection, show the compact `mode='inline'` version in the message stream at the appropriate position (or simply log it as a system message).
5. Ensure the emoji `🌿` in `WorktreeChoiceInline` is replaced with an SVG icon (no emoji in UI components per design philosophy). Use a branch/tree SVG icon.
6. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- WorktreeChoiceInline no longer shows inline in the message stream when a decision is pending
- The ActionTray shows the choice when pending
- No emoji in the component (SVG icon only)
- After selection, a compact summary is visible in the message stream

**Depends on:** Task 4.2

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 4.4 — Stop/Interrupt Button and Input State UX

**Agent type:** coder

**Description:**
The stop/interrupt button lives inside `InputTextarea.tsx` (accessed via `onStop` prop from `MessageInput`). When the agent is working, a stop icon appears. The current button is a simple `×` or stop icon with no clear visual prominence. This task makes the stop button more visible and ensures the input field's disabled state gives clear feedback.

**Subtasks (in order):**
1. Read `packages/web/src/components/InputTextarea.tsx` to understand the current stop button implementation.
2. When `isAgentWorking` is true and `onStop` is provided, render a clearly visible stop button:
   - Position: to the right of the textarea, vertically centered
   - Style: `flex items-center justify-center w-8 h-8 bg-red-600/90 hover:bg-red-600 rounded-full transition-colors cursor-pointer`
   - Icon: a filled square (stop icon), `<svg class="w-3 h-3 text-white" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10" rx="1"/></svg>`
   - Add `title="Stop Claude (Escape)"` for the tooltip.
3. When `disabled` is true (agent working, input disabled):
   - Add a `cursor-not-allowed` class to the textarea wrapper.
   - Add a subtle `opacity-60` to the textarea text to visually indicate it cannot accept input.
   - Do NOT disable the stop button when the agent is working.
4. Add a keyboard shortcut: pressing `Escape` while in the chat view triggers `handleInterrupt`. Check if this is already implemented in `useInterrupt.ts` and if not, add a `keydown` event listener in `ChatContainer.tsx` that calls `handleInterrupt` when `Escape` is pressed and the agent is working.
5. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- Stop button is visually prominent (red circle, white square icon)
- Stop button has `title="Stop Claude (Escape)"`
- Textarea shows `opacity-60` and `cursor-not-allowed` when disabled
- `Escape` key triggers interrupt when agent is working

**Depends on:** Task 4.2

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
