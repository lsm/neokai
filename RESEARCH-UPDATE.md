# Research Update: Stop Button Not Showing When Agent is Running

**Updated:** 2026-04-11  
**Correction:** The expected behavior was misunderstood initially.

---

## Clarified Expected Behavior

**CORRECT (current logic):**
- Agent running + **has content** → Show blue **send** button ✅
- Agent running + **NO content** → Show red **stop** button ❌ **(BUG - not showing!)**

The conditional logic in `InputTextarea.tsx` line 172 is conceptually correct:
```tsx
const showStop = isAgentWorking && !hasContent && !!onStop;
```

But the stop button is **not appearing** even when all conditions should be met.

---

## Root Cause Investigation

Since the logic looks correct, the bug must be that one of the conditions is evaluating incorrectly:

### Hypothesis 1: `isAgentWorking` is false when it should be true
**Possible causes:**
- Race condition: UI hasn't received the agent state update yet
- State synchronization issue: `currentAgentState` signal not updating
- Timing: Stop button check happens before `isAgentWorking` becomes true

### Hypothesis 2: `hasContent` is true when textarea appears empty
**Possible causes:**
- Whitespace not being trimmed: `content.trim().length > 0` might have hidden characters
- Content not cleared after send: `clearDraft()` might not be working
- Draft persistence: Content being restored from localStorage with whitespace

### Hypothesis 3: `onStop` is undefined
**Possible causes:**
- `handleInterrupt` not being passed in certain scenarios
- Component prop drilling issue
- Hook not returning the function

---

## Debugging Steps

Let me add console logging to trace the exact values:

### 1. Check `hasContent` calculation

Looking at InputTextarea.tsx line 171:
```tsx
const hasContent = content.trim().length > 0;
```

If `content` has any non-whitespace characters, `hasContent` will be true.

**Question:** Could the draft be getting a space or newline character after send?

### 2. Check `isAgentWorking` propagation

Flow:
1. Backend updates agent state → WebSocket event
2. `currentAgentState` signal updates
3. `isAgentWorking` computed signal updates  
4. MessageInput reads `isAgentWorking.value`
5. Passes to InputTextarea as prop

**Question:** Is there a delay between send and agent status becoming 'processing'?

### 3. Check `onStop` value

MessageInput line 137:
```tsx
const { handleInterrupt } = useInterrupt({ sessionId });
```

Line 502:
```tsx
onStop={handleInterrupt}
```

`handleInterrupt` should always be defined (it's a callback from the hook).

---

## Diagnostic Test Needed

To identify which condition is failing, we need to add temporary logging:

```tsx
// In InputTextarea.tsx around line 172
console.log('DEBUG showStop:', {
    isAgentWorking,
    hasContent,
    content: `"${content}"`,  // Show actual content with quotes
    contentLength: content.length,
    trimmedLength: content.trim().length,
    onStopProvided: !!onStop,
    showStop: isAgentWorking && !hasContent && !!onStop
});
```

This would reveal:
- Is `isAgentWorking` true?
- Is `hasContent` false (as expected)?
- Is there hidden whitespace in `content`?
- Is `onStop` provided?

---

## Alternative Investigation: E2E Test Analysis

The E2E test `interrupt-button.e2e.ts` line 27-54 says:
```typescript
test('should show stop button when agent is processing', async ({ page }) => {
    // Initial state: should show send button (disabled, no content)
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="stop-button"]')).not.toBeVisible();

    // Send a message that will take time to process
    const messageInput = await waitForElement(page, 'textarea');
    await messageInput.fill('Write a detailed essay about quantum computing.');
    await page.click('[data-testid="send-button"]');

    // Wait for agent to start processing
    await page.waitForTimeout(IS_MOCK ? 100 : 1000);

    // Stop button should now be visible, send button hidden
    await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({
        timeout: 5000,
    });
```

**Question:** Is this test passing or failing in CI?

If it's **passing**, then the stop button DOES work in the test environment, meaning the bug might be:
- Environment-specific (browser/timing)
- Specific to certain session types
- Specific to non-mock scenarios

If it's **failing**, then we have a reproducible case.

---

## Next Steps

1. **Run the E2E test** to see if it passes or fails
2. **Add debug logging** to see which condition is false
3. **Check for whitespace issues** in draft clearing
4. **Check timing** of state updates after message send

---

## Question for User

To help narrow this down, can you describe the exact steps to reproduce?

1. Open a session
2. Type a message and send it
3. Agent starts working
4. Textarea is now empty
5. **Expected:** Red stop button appears
6. **Actual:** ??? (What button do you see? Disabled send? No button? Something else?)

Also:
- Does this happen every time, or only sometimes?
- Which browser are you using?
- Is this in development mode or production?
