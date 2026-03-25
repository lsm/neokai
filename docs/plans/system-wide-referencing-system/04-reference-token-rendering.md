# M4: Reference Token Rendering

## Milestone Goal

Implement styled mention tokens that render @ references as visually distinct, interactive elements in both the input field (while typing) and in rendered messages. This provides a clear visual representation of references and enables click-to-view functionality.

## Scope

- `MentionToken` component for rendering styled tokens
- Integration with `SDKUserMessage` for rendering in chat
- Input field token rendering (draft state)
- Persistence format for message storage
- Reference display in message history

---

## Tasks

### Task 4.1: Create MentionToken Component

**Description:** Create a reusable component that renders a single @ reference as a styled, interactive token.

**Subtasks:**
1. Create `packages/web/src/components/MentionToken.tsx`:
   - Props: `{ reference: ReferenceMention; resolved?: ResolvedReference; onClick?: () => void }`
   - Visual design:
     - Pill-shaped background with distinct color per type:
       - Task: Blue
       - Goal: Purple
       - File: Green
       - Folder: Yellow/Orange
     - Icon indicating type
     - Display text (shortId or filename)
   - Hover state: show tooltip with full details
   - Click handler: trigger onClick callback
2. CSS classes following existing design tokens:
   - Use `borderColors` from `design-tokens.ts`
   - Match existing mention/tag styles in the app
3. Add keyboard accessibility:
   - Focusable when in messages
   - Enter key triggers onClick

**Acceptance Criteria:**
- MentionToken renders with type-appropriate styling
- Hover shows tooltip with entity details
- Click triggers callback
- Keyboard accessible
- Unit tests cover rendering and interactions

**Depends on:** Task 1.1 (types)

**Agent Type:** coder

---

### Task 4.2: Integrate Token Rendering in SDKUserMessage

**Description:** Modify `SDKUserMessage` to parse and render @ references as MentionToken components.

**Subtasks:**
1. Modify `packages/web/src/components/sdk/SDKUserMessage.tsx`:
   - Add reference parsing in message content renderer
   - Detect markdown-style mentions: `[@:type:id](displayText)`
   - Replace with `MentionToken` components
   - Pass resolved data from message metadata (if available)
2. Add hover preview:
   - On hover, fetch full entity data if not already loaded
   - Show popover with entity details
   - Add loading state while fetching
3. Handle plain @ text:
   - If user types @reference without autocomplete selection
   - Render as plain text (no token styling)
   - Optionally: attempt to resolve on render

**Acceptance Criteria:**
- @ references in user messages render as styled tokens
- Tokens show entity details on hover
- Plain @ text is rendered as-is
- No performance impact on message list scrolling
- Unit tests cover parsing and rendering

**Depends on:** Task 4.1

**Agent Type:** coder

---

### Task 4.3: Implement Input Field Token Rendering

**Description:** Show styled mention tokens in the input field while composing a message, replacing the raw @ syntax.

**Subtasks:**
1. Modify `packages/web/src/components/InputTextarea.tsx`:
   - Track mentions in input content
   - When a reference is selected from autocomplete:
     - Insert markdown-style mention: `[@:type:id](displayText)`
     - Visually render as token in a contenteditable overlay
   - Support editing around tokens
2. Create mention state tracking:
   - Track active mentions in the draft
   - Provide method to get mentions for message send
   - Clear mentions when draft is cleared
3. Handle edge cases:
   - Deleting part of a token (delete entire token)
   - Cursor navigation through tokens
   - Copy/paste with tokens

**Acceptance Criteria:**
- Selected references render as styled tokens in input
- Tokens are treated as atomic units (delete as whole)
- Cursor navigation works around tokens
- Mentions are tracked for message sending
- Unit tests cover mention state management

**Depends on:** Task 2.4, Task 4.1

**Agent Type:** coder

---

### Task 4.4: Implement Persistence and History Display

**Description:** Ensure @ references persist correctly in message storage and display correctly in message history.

**Subtasks:**
1. Define persistence format in message content:
   - Store as markdown-style: `[@:type:id](displayText)`
   - Include resolved reference summary in message metadata
   - Metadata structure: `{ references: { [id: string]: ResolvedReferenceSummary } }`
2. Modify message persistence in `SDKMessageRepository`:
   - Store reference metadata alongside message content
   - Enable reconstruction of resolved data on load
3. Update message loading in frontend:
   - Load reference metadata with messages
   - Pre-populate mention tokens with resolved data
   - Fall back to plain text if metadata missing (backward compat)
4. Handle entity changes:
   - Task/goal deleted: show "deleted" state
   - Task/goal status changed: show current status on hover
   - File moved/deleted: show "file not found" state

**Acceptance Criteria:**
- References persist correctly in database
- Historical messages display references correctly
- Deleted entities show appropriate state
- Backward compatible with messages before feature
- Unit tests cover persistence and loading

**Depends on:** Task 4.2, Task 4.3

**Agent Type:** coder

---

## Notes

- The input field token rendering is complex and may need a contenteditable overlay approach
- Consider using a simpler approach: show raw text in textarea, render tokens in a preview overlay
- Persistence uses markdown-style syntax for portability and readability
- Reference metadata in messages enables rich display without re-resolving on every load
- Consider expiration for reference metadata (re-resolve if too old)
