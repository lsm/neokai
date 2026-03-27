# M2: Frontend Autocomplete Menu

## Milestone Goal

Implement the frontend autocomplete menu that appears when a user types @ in the chat input field. This includes the hook for managing autocomplete state, the component for rendering the menu, integration with the existing `InputTextarea` component, keyboard navigation, and mobile UX.

## Scope

- `useReferenceAutocomplete` hook (similar pattern to `useCommandAutocomplete`)
- `ReferenceAutocomplete` component
- Integration with `InputTextarea` component (native textarea — no contenteditable)
- Keyboard navigation and mobile UX
- Fuzzy search via RPC
- Standalone session graceful degradation (file/folder only)

---

## Tasks

### Task 2.1: Create useReferenceAutocomplete Hook

**Description:** Create a hook that manages @ reference autocomplete state, following the pattern of `useCommandAutocomplete`.

**Subtasks:**
1. Create `packages/web/src/hooks/useReferenceAutocomplete.ts`:
   - Interface `UseReferenceAutocompleteOptions`: `{ content: string; onSelect: (reference: ReferenceMention) => void }`
   - Interface `UseReferenceAutocompleteResult`: `{ showAutocomplete: boolean; results: ReferenceSearchResult[]; selectedIndex: number; handleKeyDown: (e: KeyboardEvent) => boolean; handleSelect: (result: ReferenceSearchResult) => void; close: () => void }`
   - Read `sessionId` internally from `sessionStore` (consistent with `useCommandAutocomplete` pattern — no need to pass as prop)
   - State: `showAutocomplete`, `results`, `selectedIndex`, `searchQuery`
   - Debounced search via RPC (`reference.search`) with 300ms debounce
   - Detection logic: trigger when cursor is immediately after @ (not just at start of text)
   - Extract query between @ and cursor position
2. Handle edge cases:
   - @ in middle of text should still trigger
   - Multiple @ in same message (handle each independently based on cursor position)
   - Cancel in-progress search on new input
3. Standalone session handling:
   - If search results come back with only file/folder entries, update menu header accordingly
   - No special frontend logic needed — the RPC handler already filters by context

**Acceptance Criteria:**
- Hook triggers autocomplete when @ is typed anywhere in the input
- Results are fetched via RPC with debouncing
- Keyboard navigation works (arrow keys, Enter, Escape)
- Hook exports match interface pattern from `useCommandAutocomplete`
- Multiple @ mentions in same message are handled correctly
- Unit tests cover detection, selection, keyboard handling, and multiple @ support

**Depends on:** Task 1.1, Task 1.3

**Agent Type:** coder

---

### Task 2.2: Create ReferenceAutocomplete Component

**Description:** Create the dropdown component for displaying reference search results, similar to `CommandAutocomplete`.

**Subtasks:**
1. Create `packages/web/src/components/ReferenceAutocomplete.tsx`:
   - Props: `{ results: ReferenceSearchResult[]; selectedIndex: number; onSelect: (result: ReferenceSearchResult) => void; onClose: () => void; position?: { top: number; left: number } }`
   - Header with icon and "References" label (changes to "Files & Folders" if only file/folder results)
   - Grouped sections for each entity type (Tasks, Goals, Files, Folders)
   - Each result shows:
     - Icon indicating type (task/goal/file/folder)
     - `displayText` as primary text
     - `subtitle` as secondary text (e.g., task status, file path)
   - Selected item highlighting (blue border)
   - Footer with keyboard hints
2. Match styling of `CommandAutocomplete` for consistency
3. Scroll selected item into view automatically

**Acceptance Criteria:**
- Component renders search results grouped by type
- Keyboard navigation visual feedback works correctly
- Click selection works
- Click outside closes the menu
- Styling matches `CommandAutocomplete`
- Empty groups are hidden (no "Tasks:" header if no task results)
- Unit tests cover rendering and selection

**Depends on:** Task 1.1, Task 2.1

**Agent Type:** coder

---

### Task 2.3: Integrate Reference Autocomplete with InputTextarea

**Description:** Modify `InputTextarea` component to support reference autocomplete alongside command autocomplete. The native `<textarea>` remains — no contenteditable conversion.

**Subtasks:**
1. Add reference autocomplete props to `InputTextareaProps`:
   - `showReferenceAutocomplete?: boolean`
   - `referenceResults?: ReferenceSearchResult[]`
   - `selectedReferenceIndex?: number`
   - `onReferenceSelect?: (reference: ReferenceMention) => void`
   - `onReferenceClose?: () => void`
2. Render `ReferenceAutocomplete` conditionally alongside `CommandAutocomplete`
3. Position menu above cursor (calculate position based on textarea cursor position using the mirror-div technique)
4. Ensure only one autocomplete menu is visible at a time (close slash command if @ is typed, close reference if / is typed)
5. Handle the insertion: when reference is selected, replace `@query` with `@ref{type:id}` formatted text
6. Add visual hint — use an **indicator badge** approach (simplest, most reliable):
   - Add a small indicator element (e.g., a chip/tag with reference count) below or beside the textarea when `@ref{}` tokens are detected in the content
   - Count active references by scanning content for `@ref{}` pattern matches
   - Badge shows: "📎 2 references" (or similar icon + count)
   - Badge is purely informational — the raw `@ref{}` text remains visible in the textarea as-is
   - This avoids the complexity of overlay/span positioning inside a native textarea

**Acceptance Criteria:**
- @ triggers reference autocomplete in `InputTextarea`
- `/` still triggers command autocomplete
- Only one autocomplete menu visible at a time
- Selected reference replaces the @ and query text with `@ref{type:id}` format
- Native textarea behavior is preserved (cursor position, IME, selection)
- Unit tests cover insertion and menu switching

**Depends on:** Task 2.1, Task 2.2

**Agent Type:** coder

---

### Task 2.4: Integrate Reference Autocomplete with MessageInput

**Description:** Wire up the reference autocomplete hook and handlers in `MessageInput` component.

**Subtasks:**
1. Import and use `useReferenceAutocomplete` in `MessageInput`
2. Pass required props to `InputTextarea`:
   - `showReferenceAutocomplete`
   - `referenceResults`
   - `selectedReferenceIndex`
   - `onReferenceSelect`
   - `onReferenceClose`
3. Implement `handleReferenceSelect`:
   - Replace `@query` in content with `@ref{type:id}` text
   - Update content signal
   - Focus textarea after selection
4. Handle keyboard event coordination:
   - Reference autocomplete takes precedence when visible
   - Fall through to command autocomplete, then default handlers
5. Test with both slash commands and references in same message

**Acceptance Criteria:**
- Reference autocomplete works in `MessageInput`
- Can combine slash commands and references (e.g., `/agent @task-t-42 fix the bug`)
- Keyboard events are handled correctly
- No conflicts with existing command autocomplete

**Depends on:** Task 2.3

**Agent Type:** coder

---

### Task 2.5: Mobile UX and Touch Support

**Description:** Ensure reference autocomplete works well on mobile/touch devices.

**Subtasks:**
1. Test on mobile viewport (use Playwright mobile emulation):
   - Touch selection works
   - Menu positioning is correct
   - Scrolling within menu works
2. Adjust menu positioning for mobile:
   - Position above input (not below) to avoid virtual keyboard
   - Full-width on small screens
3. Add touch-specific interactions:
   - Tap to select
   - Tap outside to close
4. Ensure keyboard hints are appropriate for mobile (or hidden)

**Acceptance Criteria:**
- Reference autocomplete is usable on mobile devices
- Touch selection works correctly
- Menu doesn't get hidden by virtual keyboard
- Responsive design for different screen sizes

**Depends on:** Task 2.3, Task 2.4

**Agent Type:** coder

---

## Notes

- Reference autocomplete should work anywhere in the text (not just at the start)
- The hook must track cursor position to determine if @ is "active"
- Debounce search to avoid excessive RPC calls during typing
- The native `<textarea>` is preserved — no contenteditable conversion (see P1-1 decision in overview)
- Insertion format is `@ref{type:id}` which is the raw text stored in the textarea
- Visual hint: a reference count indicator badge below/beside the textarea (not text overlay inside textarea)
