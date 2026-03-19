# Milestone 05 — Chat and Message UX

## Milestone Goal

Polish the core chat experience: message bubble visual quality, tool card information hierarchy, thinking block presentation, session status bar compactness, and the overall scrolling/reading experience. This is where the Shibui (subtle elegance) and Kanso (simplicity) principles apply most directly.

## Milestone Scope

- `SDKAssistantMessage` and `SDKUserMessage` message bubble refinements
- `ToolResultCard` and `ToolProgressCard` visual hierarchy
- `ThinkingBlock` expand/collapse UX
- `SessionStatusBar` compactness and model switcher redesign
- `ChatHeader` information density reduction
- `ScrollToBottomButton` visual polish

---

## Task 5.1 — Message Bubble Visual Polish

**Agent type:** coder

**Description:**
The message bubbles currently use iMessage-style styling (blue for user, dark-800 for assistant). The user bubble in `SDKUserMessage` is `bg-blue-500` and the assistant bubble uses `bg-dark-800`. Per the new design system, user bubbles switch to `bg-indigo-500` and assistant bubbles become `bg-dark-800` (unchanged, but with the new `rounded-[20px]` from the token). The actions toolbar (timestamp + copy button) should fade in on hover rather than always be visible.

**Subtasks (in order):**
1. Read `packages/web/src/components/sdk/SDKUserMessage.tsx` and `SDKAssistantMessage.tsx`.
2. In `SDKUserMessage.tsx`:
   - Update bubble background from `bg-blue-500` to `bg-indigo-500` (or update the `messageColors.user.background` token and import from there).
   - Ensure the bubble `max-w-[75%]` constraint is applied to prevent overly wide user bubbles on large screens.
3. In `SDKAssistantMessage.tsx`:
   - Make the actions row (`textBlockActions`) fade in on hover of the message bubble wrapper using a CSS group:
     - Add `group` to the bubble wrapper div.
     - Change the actions div to `opacity-0 group-hover:opacity-100 transition-opacity duration-150` so it fades in on hover.
   - Keep the timestamp and copy button layout as-is.
4. Update the `messageSpacing` tokens if needed to reflect any spacing changes.
5. In `SDKAssistantMessage.tsx`, for the `SubagentBlock`, ensure it has a clear visual separator from adjacent text blocks — add `my-3` to the SubagentBlock when it appears between text blocks.
6. In `SDKUserMessage.tsx`, check if attachments/images are displayed and ensure they use `rounded-xl overflow-hidden` for consistent corner rounding with the bubble.
7. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- User message bubbles are indigo, not blue
- Assistant message action row (copy, timestamp) fades in on hover
- User bubbles do not exceed 75% of container width
- SubagentBlock has `my-3` vertical separation

**Depends on:** Milestone 02 complete

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 5.2 — Tool Cards Hierarchy and Readability

**Agent type:** coder

**Description:**
`ToolResultCard` and `ToolProgressCard` in `packages/web/src/components/sdk/tools/` are the most visually complex elements in the chat stream. They use a multi-color border system (blue for file tools, purple for search, gray for terminal, etc.) which creates a rainbow effect in long sessions. This task reduces the color noise while preserving the semantic meaning, and improves the card expand/collapse UX.

**Subtasks (in order):**
1. Read `packages/web/src/components/sdk/tools/tool-utils.ts` to understand `getToolColors()`.
2. Audit the current tool color mappings. Reduce to three categories:
   - **Action tools** (Bash, Write, Edit, Glob, Grep, WebFetch, WebSearch, TodoWrite): `bg-dark-800/60 border-dark-600` with icon colors differentiated per tool
   - **Read tools** (Read, TodoRead): `bg-dark-800/40 border-dark-700` (lighter, less prominent)
   - **System/Agent tools** (Task, Agent, Thinking, ExitPlanMode, AskUserQuestion): `bg-indigo-950/30 border-indigo-800/50` (distinct, not rainbow)
   - **Error state** (any tool with `isError=true`): `bg-red-950/30 border-red-800` regardless of tool type
   Update `getToolColors()` to return these categories.
3. In `ToolProgressCard.tsx`:
   - Remove the three animated dots progress indicator and replace with a single animated `Spinner` (`size='sm'`, `color='accent'`) on the right side.
   - This reduces visual noise during active tool execution.
4. In `ToolResultCard.tsx`:
   - The expand/collapse chevron should use `transition-transform duration-150` when rotating (already has this, verify it works).
   - When collapsed, the card header should show the tool name + truncated summary. When expanded, show full input and output.
   - Add a thin `border-t border-dark-700` separator between the header and expanded content.
   - The "Remove From Context" button should only appear in the expanded state and should use the `Button` component with `variant='ghost'` and `size='sm'` and `danger` styling rather than a raw `<button>` element.
5. Ensure the `ToolSummary` component (`ToolSummary.tsx`) truncates at 80 chars (currently 60) for better readability on desktop.
6. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- Tool cards use three-category color system (not rainbow)
- ToolProgressCard uses Spinner instead of three dots
- Expanded content has border-t separator
- "Remove From Context" uses styled Button component
- ToolSummary truncates at 80 chars

**Depends on:** Task 5.1

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 5.3 — ThinkingBlock and SubagentBlock Polish

**Agent type:** coder

**Description:**
`ThinkingBlock.tsx` renders Claude's internal thinking text with an amber/yellow color scheme. It's visually distinct (good) but the expand/collapse default behavior and styling can be improved. `SubagentBlock.tsx` renders sub-agent task results — it needs visual polish to clearly indicate the task hierarchy.

**Subtasks (in order):**
1. Read `packages/web/src/components/sdk/ThinkingBlock.tsx` and `SubagentBlock.tsx`.
2. In `ThinkingBlock.tsx`:
   - Change the container from `bg-amber-950/30 border-amber-800` to `bg-dark-900/80 border-l-2 border-l-amber-500 border-y border-r border-dark-700 rounded-r-lg` — this is a left-accent style, consistent with the ActionTray design pattern.
   - Keep the amber color only for the header text and the left border, not for the entire background.
   - When collapsed, show just the header: "Thinking..." or "Thought for Xs" with a small amber brain icon.
   - When expanded, show the thinking text in a monospace-ish font with `text-sm text-gray-300 leading-relaxed`.
   - The expand/collapse default: collapse by default for thinking blocks that are part of a completed message; expand for the most recent in-progress thinking block.
3. In `SubagentBlock.tsx`:
   - Add a visual indent: wrap the sub-agent content in `border-l-2 border-indigo-700/50 pl-3 ml-2` to visually nest it under the parent message.
   - The header "Task" or "Agent" tool name should be `text-indigo-400 font-medium text-sm`.
   - If the sub-agent has its own nested messages, ensure they are visually indented one more level.
4. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- ThinkingBlock uses left-accent style (amber border-l, dark background)
- ThinkingBlock is collapsed by default for completed messages
- SubagentBlock has visual indentation with indigo left border
- Nested sub-agent messages are further indented

**Depends on:** Task 5.1, Task 5.2

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 5.4 — SessionStatusBar Compactness and Model Switcher

**Agent type:** coder

**Description:**
The `SessionStatusBar` is a dense component with: connection status (left), then a row of icon buttons (coordinator mode, sandbox mode, model switcher, thinking level, auto-scroll), a separator, and context usage bar. On smaller screens this overflows. This task makes the status bar more compact and transforms the model switcher from a small emoji button to a more readable text + icon pattern.

**Subtasks (in order):**
1. Read `packages/web/src/components/SessionStatusBar.tsx`.
2. Replace the single emoji model button with a compact text display: `[icon] [model-name-short]` where `model-name-short` is the first word of the model name (e.g., "claude" → "Claude", "claude-opus-4-5" → "Opus"). Use `text-xs font-medium text-gray-300`.
3. The model switcher button should have a fixed width of `w-24` and use `flex items-center gap-1.5 px-2 py-1 bg-dark-800 hover:bg-dark-700 border border-dark-600 rounded-lg text-xs`.
4. Move the `ProviderBadge` dot from being a separate element to being part of the model button (inside, on the left of the text).
5. For the coordinator mode and sandbox mode toggles, reduce the button size from `w-8 h-8` to `w-7 h-7` and use `rounded-md` instead of `rounded-full` for a more contemporary look.
6. The thinking level button can remain round but should use `w-7 h-7`.
7. Auto-scroll toggle: change from `rounded-full` to `rounded-md w-7 h-7`.
8. The `ConnectionStatus` component on the left: read it and ensure it only shows the indicator dot + short text when in a non-processing state. When processing (`isProcessing=true`), show a pulsing dot + the `currentAction` text truncated to 20 chars.
9. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- Model switcher is a text button (not emoji), shows short model name + provider dot
- Coordinator/sandbox/thinking/auto-scroll buttons are `w-7 h-7 rounded-md`
- Connection status shows truncated action text when processing
- Status bar fits without overflow on a 375px mobile viewport

**Depends on:** Task 5.1, Milestone 02 complete

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 5.5 — ChatHeader Density and ScrollToBottomButton

**Agent type:** coder

**Description:**
`ChatHeader.tsx` currently shows: session title, token count + cost, git branch info, and a three-dot dropdown. For most sessions the context info (tokens/cost) is secondary — it should be a tooltip rather than always-visible. The `ScrollToBottomButton.tsx` is a floating circular button that appears when the user scrolls up. Its current style should be refined.

**Subtasks (in order):**
1. Read `packages/web/src/components/ChatHeader.tsx` and `ScrollToBottomButton.tsx`.
2. In `ChatHeader.tsx`:
   - Move the token count and cost display into a `Tooltip` on hover of the session title (or a small info icon next to the title). The title alone should be in the header.
   - The git branch info (branch name + worktree indicator) can remain visible but reduce to `text-xs text-gray-500` on one line after the title.
   - This creates a cleaner header: `[hamburger] [room/session breadcrumb] [session title] [branch]` with `[options dropdown]` on the right.
3. In `ScrollToBottomButton.tsx`:
   - Change from a circle button to a pill button: `flex items-center gap-1.5 px-3 py-1.5 bg-dark-800/90 hover:bg-dark-700 border border-dark-600 rounded-full text-xs text-gray-300 backdrop-blur-sm`.
   - Add a downward chevron icon + "Jump to bottom" text (hidden on mobile with `hidden sm:inline`).
   - Position: `fixed bottom-[4.5rem] right-4` (adjust to be above the MessageInput area).
4. Run `bun run typecheck` and `bun run lint`.

**Acceptance criteria:**
- `bun run typecheck` and `bun run lint` pass
- ChatHeader shows only title and git branch by default; tokens/cost visible on hover tooltip
- ScrollToBottomButton is a pill with text on desktop, icon-only on mobile
- Header is visually less cluttered

**Depends on:** Task 5.4, Milestone 02

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
