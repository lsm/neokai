---
name: playwright-interactive
description: Persistent browser session for iterative UI debugging and visual QA
---

# Playwright Interactive — Persistent Browser Sessions

This skill manages a **persistent browser session** across multiple iterations. Instead of opening and closing a browser for each action, you bootstrap browser/context/page handles once and reuse them throughout a debugging or QA session. Ideal for visual inspection, iterative UI debugging, and manual-style QA checklists.

## Bootstrap a persistent session

Before any interactions, initialise the browser handles. Run this code once at the start of the session:

```typescript
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

// Desktop web context
const browser: Browser = await chromium.launch({ headless: true });
const context: BrowserContext = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
});
const page: Page = await context.newPage();
```

For **mobile web** contexts:

```typescript
import { chromium, devices } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ...devices['iPhone 14'],
});
const page = await context.newPage();
```

Keep `browser`, `context`, and `page` in scope for the entire session. Do not re-create them between iterations.

## Screenshot helpers

Capture screenshots at any point to inspect the current state:

```typescript
// Full-page screenshot
await page.screenshot({ path: '/tmp/screenshot-full.png', fullPage: true });

// Viewport-only screenshot
await page.screenshot({ path: '/tmp/screenshot-viewport.png' });

// Screenshot of a specific element
const element = page.locator('[data-testid="modal"]');
await element.screenshot({ path: '/tmp/screenshot-modal.png' });
```

## Iterative interaction pattern

Reuse handles across multiple interaction steps without reopening the browser:

```typescript
// Navigate
await page.goto('https://example.com');

// Interact
await page.fill('input[name="email"]', 'user@example.com');
await page.fill('input[name="password"]', 'hunter2');
await page.click('button[type="submit"]');

// Wait for navigation or network idle
await page.waitForLoadState('networkidle');

// Capture state
await page.screenshot({ path: '/tmp/after-login.png' });

// Continue iterating — no need to reopen browser
await page.goto('https://example.com/dashboard');
await page.screenshot({ path: '/tmp/dashboard.png' });
```

## Functional QA checklist

Use this checklist when performing functional QA on a UI:

- [ ] Page loads without console errors (check `page.on('console', ...)`)
- [ ] All primary navigation links resolve (no 404s)
- [ ] Forms submit successfully and show expected confirmation or error states
- [ ] Required field validation triggers correctly (submit with empty fields)
- [ ] Interactive elements (buttons, dropdowns, modals) are keyboard-accessible
- [ ] Loading states are shown during async operations
- [ ] Error states display user-friendly messages (not raw stack traces)
- [ ] Back-navigation and browser history work as expected

## Visual QA checklist

Use this checklist when performing visual QA:

- [ ] Layout is not broken at the target viewport size
- [ ] Text is not clipped or overflowing its container
- [ ] Images and icons load (no broken image placeholders)
- [ ] Colours and fonts match the design intent
- [ ] Interactive states (hover, focus, active) are visually distinct
- [ ] Modals and overlays cover the page correctly
- [ ] Scrollable areas scroll smoothly and don't double-scroll

## Signoff criteria

A page passes QA when:

1. No JavaScript errors appear in the browser console
2. All functional checklist items pass
3. All visual checklist items pass at the specified viewport(s)
4. Screenshots are captured and reviewed for the key states (initial load, after interaction, error state)

## Capture console errors

Attach a listener before navigation to catch runtime errors:

```typescript
const consoleErrors: string[] = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push(msg.text());
  }
});

await page.goto('https://example.com');
// ... perform interactions ...

if (consoleErrors.length > 0) {
  console.log('Console errors detected:', consoleErrors);
}
```

## Cleanup

Always close handles when the session is complete:

```typescript
await context.close();
await browser.close();
```

Failing to close handles leaves zombie browser processes. Always call `browser.close()` at the end of the session, even after errors (use try/finally).

```typescript
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
  // ... session work ...
} finally {
  await browser?.close();
}
```

## Running the code

Execute Playwright scripts using Bun:

```bash
bunx playwright install chromium  # first-time setup: install browser
bun run /tmp/my-automation.ts
```

Or run inline TypeScript directly in Claude Code's code execution environment.

## Notes

- Use `headless: true` for automation. Set `headless: false` only when you need to observe the browser visually in a headed environment.
- `page.waitForLoadState('networkidle')` is useful after form submissions or navigation triggered by JavaScript.
- Prefer `page.locator()` with semantic selectors (`role`, `text`, `data-testid`) over CSS or XPath for resilient automation.
- When iterating on a UI, keep the browser open between iterations to avoid the startup overhead.
