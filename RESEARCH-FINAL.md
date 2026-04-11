# Research: Stop Button Missing in Space Sessions

**Date:** 2026-04-11  
**Task:** Fix stop button visibility in chat composer during agent run  
**Status:** Root cause identified ✅

---

## Executive Summary

The stop button works correctly in **normal worker sessions** but fails to appear in **space/task sessions**. The root cause is that `ThreadedChatComposer.tsx` (used for space sessions) does not pass the `isAgentWorking` and `onStop` props to `InputTextarea`, causing the stop button to never render.

---

## Bug Description

### Symptoms
- ✅ **Normal sessions:** Stop button appears when agent is running and textarea is empty
- ❌ **Space sessions:** Stop button never appears, even when agent is running

### Expected Behavior (All Session Types)
- Agent running + empty textarea → Show red stop button
- Agent running + text in textarea → Show blue send button (queue mode)
- Agent idle + text in textarea → Show blue send button
- Agent idle + empty textarea → Show disabled send button

---

## Root Cause

### File: `packages/web/src/components/space/ThreadedChatComposer.tsx`

**Lines 122-164:** `ThreadedChatComposer` renders `InputTextarea` but **omits critical props**:

```tsx
<InputTextarea
    content={draft}
    onContentChange={handleDraftChange}
    onKeyDown={(e) => { /* ... */ }}
    onSubmit={() => { void submitDraft(); }}
    disabled={isSending}
    placeholder={hasTaskAgentSession ? 'Message task agent...' : 'Message task agent (auto-start)...'}
    textareaRef={textareaRef}
    transparent={true}
    // ❌ MISSING: isAgentWorking prop
    // ❌ MISSING: onStop prop
/>
```

### Why This Breaks the Stop Button

In `InputTextarea.tsx` line 172:
```tsx
const showStop = isAgentWorking && !hasContent && !!onStop;
```

When `ThreadedChatComposer` doesn't pass these props:
- `isAgentWorking` defaults to `false` (prop default value on line 91)
- `onStop` is `undefined`
- Therefore: `showStop = false && !hasContent && false` → **always `false`**

### Comparison: Working Implementation

`MessageInput.tsx` (used for normal sessions) **correctly passes both props** (lines 501-502):

```tsx
<InputTextarea
    // ... other props ...
    isAgentWorking={agentWorking}
    onStop={handleInterrupt}
/>
```

Where:
- `agentWorking` comes from `isAgentWorking.value` signal (line 169)
- `handleInterrupt` comes from `useInterrupt({ sessionId })` hook (line 137)

---

## Fix Implementation

### Step 1: Add Agent State Tracking to ThreadedChatComposer

`ThreadedChatComposer` needs to:
1. Import the `isAgentWorking` signal
2. Read the agent working state for the task session
3. Implement an interrupt handler

### Step 2: Update ThreadedChatComposer Props

The component needs to receive:
- `sessionId` (for interrupt RPC call)
- Or alternatively, receive `isAgentWorking` and `onStop` as props from parent

### Step 3: Pass Props to InputTextarea

```diff
+ import { isAgentWorking } from '../../lib/state.ts';
+ import { useInterrupt } from '../../hooks';

export function ThreadedChatComposer({
    mentionCandidates,
    hasTaskAgentSession,
    canSend,
    isSending,
    errorMessage,
    onSend,
+   taskSessionId,  // New prop needed
}: ThreadedChatComposerProps) {
+   const agentWorking = isAgentWorking.value;
+   const { handleInterrupt } = useInterrupt({ sessionId: taskSessionId });

    // ... existing code ...

    <InputTextarea
        content={draft}
        onContentChange={handleDraftChange}
        onKeyDown={(e) => { /* ... */ }}
        onSubmit={() => { void submitDraft(); }}
        disabled={isSending}
        placeholder={hasTaskAgentSession ? 'Message task agent...' : 'Message task agent (auto-start)...'}
        textareaRef={textareaRef}
        transparent={true}
+       isAgentWorking={agentWorking}
+       onStop={handleInterrupt}
    />
```

### Alternative: Pass as Props from Parent

If the parent component (`SpaceTaskPane.tsx` or similar) already has access to the session state, it can pass the props down:

```diff
interface ThreadedChatComposerProps {
    mentionCandidates: MentionAgent[];
    hasTaskAgentSession: boolean;
    canSend: boolean;
    isSending: boolean;
    errorMessage?: string | null;
    onSend: (message: string) => Promise<boolean>;
+   isAgentWorking?: boolean;
+   onStop?: () => Promise<void>;
}

export function ThreadedChatComposer({
    // ... existing props ...
+   isAgentWorking = false,
+   onStop,
}: ThreadedChatComposerProps) {
    // ... existing code ...

    <InputTextarea
        // ... existing props ...
+       isAgentWorking={isAgentWorking}
+       onStop={onStop}
    />
```

---

## Parent Component Investigation

Let me check where `ThreadedChatComposer` is used:

**File:** `packages/web/src/components/space/SpaceTaskPane.tsx`

This component likely renders `ThreadedChatComposer` and would need to pass the additional props.

---

## Test Coverage

### Unit Tests

**File:** `packages/web/src/components/space/__tests__/ThreadedChatComposer.test.tsx`

Current tests likely don't cover the stop button scenario. New tests needed:

```tsx
it('should show stop button when agent is working and textarea is empty', () => {
    const { container } = render(
        <ThreadedChatComposer
            mentionCandidates={[]}
            hasTaskAgentSession={true}
            canSend={true}
            isSending={false}
            onSend={async () => true}
            isAgentWorking={true}
            onStop={async () => {}}
        />
    );

    const stopButton = container.querySelector('[data-testid="stop-button"]');
    expect(stopButton).toBeTruthy();
});

it('should show send button when agent is working but textarea has content', () => {
    const { container, rerender } = render(
        <ThreadedChatComposer
            mentionCandidates={[]}
            hasTaskAgentSession={true}
            canSend={true}
            isSending={false}
            onSend={async () => true}
            isAgentWorking={true}
            onStop={async () => {}}
        />
    );

    // Type some content
    const textarea = container.querySelector('textarea')!;
    fireEvent.input(textarea, { target: { value: 'test message' } });

    // Should show send button, not stop button
    expect(container.querySelector('[data-testid="send-button"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="stop-button"]')).toBeNull();
});
```

### E2E Tests

The existing E2E test `interrupt-button.e2e.ts` only tests normal worker sessions. A new test is needed for space/task sessions:

```tsx
test('should show stop button in space task session when agent is processing', async ({ page }) => {
    // Navigate to a space
    // Create/open a task
    // Send a message to the task agent
    // Verify stop button appears
    // Click stop button
    // Verify agent stops
});
```

---

## Files Affected

### Source Code
1. **`packages/web/src/components/space/ThreadedChatComposer.tsx`** ⭐ Main fix
   - Add `isAgentWorking` and `onStop` props
   - Pass them to `InputTextarea`

2. **`packages/web/src/components/space/SpaceTaskPane.tsx`** (or wherever ThreadedChatComposer is used)
   - Pass `isAgentWorking` and `onStop` props down

### Tests
3. **`packages/web/src/components/space/__tests__/ThreadedChatComposer.test.tsx`**
   - Add stop button visibility tests

4. **`packages/e2e/tests/core/interrupt-button.e2e.ts`** (or new file)
   - Add space session interrupt test

---

## Implementation Checklist

- [ ] Update `ThreadedChatComposerProps` interface to include `isAgentWorking` and `onStop`
- [ ] Modify `ThreadedChatComposer` to accept and pass these props to `InputTextarea`
- [ ] Update parent component to provide these props
- [ ] Add unit tests for stop button in `ThreadedChatComposer`
- [ ] Add E2E test for space session interrupt
- [ ] Verify fix works in both space sessions and normal sessions

---

## Confidence Level

**Very High** — The root cause is clear and straightforward:
- Normal sessions work because `MessageInput` passes the required props
- Space sessions don't work because `ThreadedChatComposer` omits these props
- Fix is simple: pass the two missing props

---

## Next Steps

1. Implement the fix in `ThreadedChatComposer.tsx`
2. Update parent component to provide props
3. Add test coverage
4. Manual testing in space sessions
5. Update research PR with final findings
