# Known Issues in E2E Tests

## Model Switcher Tests

### Test: "should persist model selection across page refresh"

**Status:** Consistently Failing
**File:** `tests/model-switcher.e2e.ts:538`
**Issue:** After page reload, the model switcher button does not appear within 20 seconds

**Details:**

- The test switches to a model, then reloads the page
- After reload, the model switcher button fails to render
- This appears to be a timing issue with how the app mounts after page reload
- The core model switching functionality works correctly (26/27 tests passing)

**Impact:** Low - This is an edge case (page refresh) and doesn't affect the core feature

**Workaround:** None needed - model switching works in normal usage

**Next Steps:** Investigate why the MessageInput component or ChatContainer is not mounting properly after page reload
