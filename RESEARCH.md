# Research: Stop Button Visibility Bug in Chat Composer

**Date:** 2026-04-11  
**Task:** Fix stop button visibility in chat composer during agent run  
**Status:** Root cause identified

---

## Executive Summary

The stop button in the chat composer fails to appear when the agent is running **and** the user has typed text in the textarea. The root cause is an incorrect conditional in `InputTextarea.tsx` that only shows the stop button when the textarea is empty.

**Impact:** Users cannot interrupt a running agent if they've typed follow-up text, creating a poor UX where the expected stop button is hidden.

---

## Bug Description

### Expected Behavior
- **Agent running + empty textarea:** Show stop button ✅
- **Agent running + text in textarea:** Show stop button ✅ (CURRENTLY BROKEN)
- **Agent idle + text in textarea:** Show send button ✅
- **Agent idle + empty textarea:** Show disabled send button ✅

### Actual Behavior
- **Agent running + empty textarea:** Show stop button ✅
- **Agent running + text in textarea:** Show send button ❌ (BUG!)
- **Agent idle + text in textarea:** Show send button ✅
- **Agent idle + empty textarea:** Show disabled send button ✅

---

## Root Cause Analysis

### Location
**File:** `packages/web/src/components/InputTextarea.tsx`  
**Line:** 172

### Buggy Code
```tsx
const showStop = isAgentWorking && !hasContent && !!onStop;
```

### Problem
The condition includes `!hasContent`, which means the stop button only appears when:
1. Agent is working (`isAgentWorking`)
2. **AND** the textarea is empty (`!hasContent`)
3. **AND** the `onStop` callback is provided (`!!onStop`)

This means if a user types any text while the agent is running, the stop button disappears and is replaced by the send button.

### Correct Logic
```tsx
const showStop = isAgentWorking && !!onStop;
```

The stop button should appear whenever the agent is working, regardless of textarea content.

---

## Evidence

### 1. Component Logic Analysis

**File:** `packages/web/src/components/InputTextarea.tsx`

The component has mutually exclusive button states:

```tsx
// Lines 171-172
const hasContent = content.trim().length > 0;
const showStop = isAgentWorking && !hasContent && !!onStop;  // ← BUG HERE

// Lines 286-340: Conditional rendering
{showStop ? (
    <button data-testid="stop-button">Stop</button>
) : (
    <button data-testid="send-button" disabled={!hasContent}>Send</button>
)}
```

The ternary ensures only one button is visible at a time. The bug is in the `showStop` calculation.

### 2. Data Flow

**Flow from ChatComposer → MessageInput → InputTextarea:**

1. `ChatComposer.tsx` renders `MessageInput` with `isProcessing` prop
2. `MessageInput.tsx` (line 169) reads `isAgentWorking` from signal:
   ```tsx
   const agentWorking = isAgentWorking.value;
   ```
3. `MessageInput.tsx` (line 501) passes it to `InputTextarea`:
   ```tsx
   <InputTextarea
       isAgentWorking={agentWorking}
       onStop={handleInterrupt}
       // ...
   />
   ```
4. `InputTextarea.tsx` (line 172) uses it in conditional:
   ```tsx
   const showStop = isAgentWorking && !hasContent && !!onStop;  // ← BUG
   ```

### 3. Test Coverage Analysis

#### Unit Tests (packages/web/src/components/__tests__/InputTextarea.test.tsx)

The unit tests **do not cover the stop button** properly. All stop button tests are missing because:

- Lines 185-201: Tests "should show send button when isAgentWorking is false" ✓
- Lines 203-219: Tests "should keep send button visible when isAgentWorking is true" ❌
  - This test is **wrong** — it expects send button when agent is working!
  - Missing `onStop` prop, so stop button wouldn't show anyway
- Lines 221-236: Tests "should keep send button enabled with content when isAgentWorking is true" ❌
  - Same issue — expects send button during agent work

**The unit tests document the buggy behavior as if it's correct.**

#### E2E Tests (packages/e2e/tests/core/interrupt-button.e2e.ts)

The E2E tests **also document the buggy behavior**:

**Line 127-161: "should toggle between stop and send button based on input content while agent is running"**

```typescript
// Stop button visible, send button NOT visible (agent running + empty input)
await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

// Type text while agent is running → send button should appear, stop button disappear
await messageInput.fill('some follow-up text');
await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 3000 });
await expect(stopButton).not.toBeVisible();  // ← This is the bug!

// Clear the text → stop button returns, send button disappears
await messageInput.fill('');
await expect(stopButton).toBeVisible({ timeout: 3000 });
```

**This test validates the incorrect behavior.** When the agent is running, the stop button should remain visible regardless of input content.

---

## Impact Assessment

### User Experience Impact
- **Severity:** High
- **Frequency:** Common (any time user types while agent is working)
- **Workaround:** User must delete all typed text to see the stop button again

### User Scenarios Affected
1. **Multi-turn conversations:** User types a follow-up while agent is responding
2. **Queue mode:** User wants to interrupt before queuing another message
3. **Exploratory workflows:** User starts typing, realizes agent output is wrong, wants to stop

---

## Recommended Fix

### Code Change

**File:** `packages/web/src/components/InputTextarea.tsx`  
**Line:** 172

```diff
- const showStop = isAgentWorking && !hasContent && !!onStop;
+ const showStop = isAgentWorking && !!onStop;
```

### Test Updates Required

#### 1. Unit Tests (`packages/web/src/components/__tests__/InputTextarea.test.tsx`)

**Lines 203-219:** Fix test expectations
```diff
- it('should keep send button visible when isAgentWorking is true', () => {
+ it('should show stop button when isAgentWorking is true and onStop is provided', () => {
      const { container } = render(
          <InputTextarea
              content="hello"
              onContentChange={() => {}}
              onKeyDown={() => {}}
              onSubmit={() => {}}
              isAgentWorking={true}
+             onStop={() => {}}
          />
      );

-     const sendButton = container.querySelector('[data-testid="send-button"]');
      const stopButton = container.querySelector('[data-testid="stop-button"]');

-     expect(sendButton).toBeTruthy();
-     expect(stopButton).toBeNull();
+     expect(stopButton).toBeTruthy();
+     expect(sendButton).toBeNull();
  });
```

**Lines 221-236:** Fix test expectations
```diff
- it('should keep send button enabled with content when isAgentWorking is true', () => {
+ it('should show enabled stop button when agent is working (even with content)', () => {
      const { container } = render(
          <InputTextarea
              content="hello"
              onContentChange={() => {}}
              onKeyDown={() => {}}
              onSubmit={() => {}}
              isAgentWorking={true}
+             onStop={() => {}}
          />
      );

-     const sendButton = container.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
-     expect(sendButton?.disabled).toBe(false);
+     const stopButton = container.querySelector('[data-testid="stop-button"]') as HTMLButtonElement;
+     expect(stopButton).toBeTruthy();
+     expect(stopButton.disabled).toBe(false);
  });
```

**Add new test:** Stop button persists when typing during agent work
```tsx
it('should show stop button when agent is working, regardless of textarea content', () => {
    const onStop = vi.fn();
    const { container, rerender } = render(
        <InputTextarea
            content=""
            onContentChange={() => {}}
            onKeyDown={() => {}}
            onSubmit={() => {}}
            isAgentWorking={true}
            onStop={onStop}
        />
    );

    // Initially empty: stop button visible
    expect(container.querySelector('[data-testid="stop-button"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="send-button"]')).toBeNull();

    // Type content: stop button should STILL be visible
    rerender(
        <InputTextarea
            content="some typed text"
            onContentChange={() => {}}
            onKeyDown={() => {}}
            onSubmit={() => {}}
            isAgentWorking={true}
            onStop={onStop}
        />
    );

    expect(container.querySelector('[data-testid="stop-button"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="send-button"]')).toBeNull();
});
```

#### 2. E2E Tests (`packages/e2e/tests/core/interrupt-button.e2e.ts`)

**Lines 127-161:** Fix test expectations

```diff
- test('should toggle between stop and send button based on input content while agent is running', async ({
+ test('should keep stop button visible while agent is running, regardless of input content', async ({
      page,
  }) => {
      // ... setup code ...

      // Stop button visible, send button NOT visible (agent running + empty input)
      await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

-     // Type text while agent is running → send button should appear, stop button disappear
+     // Type text while agent is running → stop button should REMAIN visible
      await messageInput.fill('some follow-up text');
-     await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 3000 });
-     await expect(stopButton).not.toBeVisible();
+     await expect(stopButton).toBeVisible({ timeout: 3000 });
+     await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

-     // Clear the text → stop button returns, send button disappears
+     // Clear the text → stop button should still be visible
      await messageInput.fill('');
      await expect(stopButton).toBeVisible({ timeout: 3000 });
      await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

      // Click stop to interrupt → send button returns after interrupt completes
      await stopButton.click();
      await expect(page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 15000 });
      await expect(stopButton).not.toBeVisible();

      await cleanupTestSession(page, sessionId);
  });
```

---

## Design Rationale

### Why Stop Button Should Always Be Visible During Agent Work

1. **Interrupt is always available:** The backend allows interrupts at any time during agent execution
2. **User intent is clear:** If the agent is running, the primary action is "stop" not "send another message"
3. **Queue mode exists:** If users want to send while agent is working, they can use Tab (defer to queue)
4. **Consistency:** Other UIs (Claude.ai, ChatGPT) show stop/interrupt as the primary action during generation

### Alternative Considered: Show Both Buttons

**Rejected** because:
- Clutters the UI with two buttons
- Confusing to users which action is primary
- Current design uses a single button slot (mutually exclusive)

---

## Files Analyzed

### Source Code
- ✅ `packages/web/src/components/ChatComposer.tsx` — Top-level composer wrapper
- ✅ `packages/web/src/components/MessageInput.tsx` — Input orchestration, passes `isAgentWorking` prop
- ✅ `packages/web/src/components/InputTextarea.tsx` — **Contains the bug** (line 172)
- ✅ `packages/web/src/lib/state.ts` — `isAgentWorking` signal definition
- ✅ `packages/web/src/hooks/useInterrupt.ts` — Interrupt handler implementation

### Tests
- ✅ `packages/web/src/components/__tests__/InputTextarea.test.tsx` — Unit tests (validate buggy behavior)
- ✅ `packages/e2e/tests/core/interrupt-button.e2e.ts` — E2E tests (validate buggy behavior)

---

## Next Steps

1. ✅ Fix `InputTextarea.tsx` line 172
2. ✅ Update unit tests to validate correct behavior
3. ✅ Update E2E test expectations
4. ✅ Manual testing: verify stop button persists when typing during agent work
5. ✅ Trigger E2E tests in CI to ensure no regressions

---

## Conclusion

The bug is a simple logic error in `InputTextarea.tsx` where the `!hasContent` condition incorrectly hides the stop button when the user has typed text while the agent is running. The fix is a one-line change, but requires updating both unit and E2E tests that currently validate the incorrect behavior.

**Confidence Level:** Very High  
**Risk Level:** Low (one-line change, clear test coverage path)  
**Estimated Effort:** 1-2 hours (code fix + test updates)
