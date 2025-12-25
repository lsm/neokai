# Testing Safari Background Tab Behavior

This document describes the comprehensive test suite for Safari background tab reconnection behavior.

## Overview

We have 3 tiers of tests to ensure the UI properly synchronizes after returning from background:

- **Tier 1: Unit Tests** - Fast, isolated tests of individual components
- **Tier 2: Integration Tests** - Test interactions between components
- **Tier 3: E2E Tests** - Test real browser behavior with Playwright

## Test Coverage

### What We Test

1. **Page Visibility Detection**
   - Visibility change event handling
   - Handler registration and cleanup
   - State transitions (hidden → visible)

2. **Reconnection Flow**
   - Health check execution
   - Force resubscription (even when connected)
   - State refresh (both appState and globalStore)
   - Parallel execution of refreshes

3. **Data Synchronization**
   - Session list updates
   - Message history synchronization
   - SDK message deduplication
   - Server timestamp usage (clock skew handling)

4. **Error Handling**
   - Health check failures
   - Network errors during refresh
   - Missing connection scenarios

5. **Edge Cases**
   - Multiple background/foreground cycles
   - Long background periods (> 5 minutes)
   - Rapid state transitions

## Running the Tests

### Tier 1: Unit Tests

```bash
# Run all unit tests
bun test packages/web/src/lib/__tests__/connection-manager-visibility.test.ts

# Run with verbose output
TEST_VERBOSE=1 bun test packages/web/src/lib/__tests__/connection-manager-visibility.test.ts

# Run specific test
bun test packages/web/src/lib/__tests__/connection-manager-visibility.test.ts -t "should call forceResubscribe"
```

**Speed:** ~100ms
**When to run:** On every commit, in CI/CD pipeline

### Tier 2: Integration Tests

```bash
# Run integration tests
bun test packages/web/src/lib/__tests__/safari-background-integration.test.ts

# Run with coverage
bun test --coverage packages/web/src/lib/__tests__/safari-background-integration.test.ts
```

**Speed:** ~500ms
**When to run:** On pull requests, before merge

### Tier 3: E2E Tests

```bash
# Run E2E tests (headless)
make e2e

# Run with headed browser (see what's happening)
make e2e-headed

# Run in debug mode
make e2e-debug

# Run in UI mode (interactive)
make e2e-ui

# Run only Safari background tests
npx playwright test safari-background-tab.spec.ts

# Run on specific browser
npx playwright test safari-background-tab.spec.ts --project=webkit
```

**Speed:** ~30-60 seconds
**When to run:** Nightly builds, before releases, after reconnection changes

## Test Files

### Unit Tests

- `packages/web/src/lib/__tests__/connection-manager-visibility.test.ts`
  - 15 test cases covering visibility handling
  - Mocks document events and MessageHub
  - Tests error paths and edge cases

### Integration Tests

- `packages/web/src/lib/__tests__/safari-background-integration.test.ts`
  - 12 test cases covering full reconnection flow
  - Tests StateChannel, GlobalStore, and ConnectionManager integration
  - Validates parallel execution and performance

### E2E Tests

- `packages/web/e2e/safari-background-tab.spec.ts`
  - 10+ test scenarios covering real browser behavior
  - Tests actual WebSocket connections
  - Validates UI updates and user interactions

## Test Strategy

### Unit Test Philosophy

✅ **DO:**

- Mock external dependencies (MessageHub, WebSocket)
- Test individual methods in isolation
- Verify function calls and execution order
- Test error handling paths

❌ **DON'T:**

- Make real network requests
- Test implementation details
- Test external library behavior

### Integration Test Philosophy

✅ **DO:**

- Test component interactions
- Use real StateChannel and GlobalStore instances
- Verify data flow between components
- Test performance characteristics (parallel vs sequential)

❌ **DON'T:**

- Test UI rendering
- Make assumptions about timing
- Skip error scenarios

### E2E Test Philosophy

✅ **DO:**

- Test actual user scenarios
- Verify UI updates correctly
- Test cross-component data flow
- Use realistic timing (wait for async operations)

❌ **DON'T:**

- Test every edge case (use unit tests for that)
- Make tests too brittle (avoid pixel-perfect checks)
- Skip accessibility considerations

## Debugging Failed Tests

### Unit Test Failures

```bash
# Run with verbose logging
TEST_VERBOSE=1 bun test <test-file>

# Run single test in isolation
bun test <test-file> -t "test name"

# Check mock calls
console.log(mockFunction.mock.calls);
```

### Integration Test Failures

```bash
# Enable debug logging in StateChannel
const channel = new StateChannel(hub, 'test', { debug: true });

# Check execution order
const executionOrder: string[] = [];
// Add tracking in spies
```

### E2E Test Failures

```bash
# Run headed to see what's happening
make e2e-headed

# Use debug mode (pauses at failures)
make e2e-debug

# Take screenshots on failure (automatic in CI)
# Check artifacts in test-results/

# Add verbose logging
await page.evaluate(() => console.log('State:', window.appState));
```

## Common Issues

### "forceResubscribe not called"

**Cause:** Health check might be failing before reaching forceResubscribe
**Fix:** Check that mockMessageHub.call is configured to return success for 'system.health'

### "State not refreshing"

**Cause:** Timing issue - refresh may not have completed
**Fix:** Increase wait time or use proper await patterns

### "E2E tests timeout"

**Cause:** Server not running or WebSocket not connecting
**Fix:** Ensure `make dev` is running, check port 9283 is accessible

### "Visibility events not firing"

**Cause:** document.hidden property not properly mocked
**Fix:** Use `Object.defineProperty(document, 'hidden', { value: true, configurable: true })`

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Test Safari Background Behavior

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test packages/web/src/lib/__tests__/connection-manager-visibility.test.ts
      - run: bun test packages/web/src/lib/__tests__/safari-background-integration.test.ts

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: npx playwright install --with-deps
      - run: make dev &
      - run: sleep 5 # Wait for server
      - run: npx playwright test safari-background-tab.spec.ts
      - uses: actions/upload-artifact@v3
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
```

## Performance Benchmarks

### Expected Test Durations

| Test Suite           | Tests  | Duration | Speed             |
| -------------------- | ------ | -------- | ----------------- |
| Unit (Tier 1)        | 15     | ~100ms   | 150 tests/sec     |
| Integration (Tier 2) | 12     | ~500ms   | 24 tests/sec      |
| E2E (Tier 3)         | 10     | ~30s     | 0.3 tests/sec     |
| **Total**            | **37** | **~31s** | **1.2 tests/sec** |

### Coverage Goals

- **Unit Tests:** > 95% coverage of visibility handling code
- **Integration Tests:** > 90% coverage of reconnection flow
- **E2E Tests:** Cover all critical user scenarios

## Continuous Improvement

### Adding New Tests

1. **Identify the scenario** - What behavior needs testing?
2. **Choose the right tier:**
   - Pure logic → Unit test
   - Component interaction → Integration test
   - User-facing behavior → E2E test
3. **Write the test** - Follow existing patterns
4. **Verify it fails** - Ensure it catches regressions
5. **Document** - Add to this file if it's a new scenario

### Test Maintenance

- **Review quarterly** - Are tests still relevant?
- **Update after bugs** - Add regression tests for fixes
- **Refactor** - Keep tests DRY and maintainable
- **Monitor flakiness** - Fix or remove flaky tests

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Bun Test Documentation](https://bun.sh/docs/cli/test)
- [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [Safari WebSocket Behavior](https://webkit.org/blog/8943/undoing-the-undoing/)

## Questions?

If tests are failing or you need help:

1. Check this document first
2. Review the test output carefully
3. Try running with verbose/debug flags
4. Check Git history for recent changes
5. Ask the team in #engineering-help
