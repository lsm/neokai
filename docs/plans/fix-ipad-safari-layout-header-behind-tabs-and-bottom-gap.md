# Fix iPad Safari Layout: Header Behind Tabs and Bottom Gap

## Goal

Fix two layout issues on iPad Safari:

1. **Header hidden behind Safari tabs** -- The root container uses `pt-safe` which maps to `env(safe-area-inset-top)`. On iPad (no notch), this value is 0, but Safari's tab bar overlays the top of the page, hiding the header.
2. **Unnecessary bottom gap** -- The main content uses `pb-16 md:pb-0` for bottom tab bar clearance. On iPad Mini in portrait (744px viewport width), this falls below the `md:` (768px) breakpoint, applying 64px of padding even though the BottomTabBar uses the same `md:hidden` breakpoint -- so they match, but iPad Mini gets the mobile layout with a bottom tab bar that may not match the hardcoded 64px padding.

## Approach

### Header behind Safari tabs

There is no CSS-only way to detect Safari's tab bar overlay. `env(safe-area-inset-top)` only accounts for the hardware notch (0 on iPads). `visualViewport.offsetTop` measures pinch-zoom offset, NOT browser chrome. No top-offset API exists.

**Key insight**: Rather than trying to detect the tab bar's height (unreliable), we constrain the app's total height to `visualViewport.height` — the actual visible area after all browser chrome is subtracted. This solves the header problem indirectly: the app fits entirely within the visible viewport, so no content renders behind the tab bar.

**Chosen approach**: Create a `useViewportSafety` hook that:
- Detects iPad Safari via `navigator.maxTouchPoints > 1` (distinguishes iPadOS from macOS) AND `navigator.userAgent` containing "Safari" but not "Chrome/CriOS/FxiOS" (iPadOS masquerades as macOS Safari). Does NOT use the deprecated `navigator.platform` API.
- Sets `--safe-height` CSS custom property on `document.documentElement` using `window.visualViewport.height` as the **primary** source — this is the actual visible content area after all browser chrome (tab bar, address bar) is subtracted
- Does NOT set a `--safe-top` property — there is no reliable API for iPad Safari tab bar inset. The header-behind-tab-bar problem is solved exclusively by capping the container height to `visualViewport.height`, which prevents content from extending behind the tab bar.
- Listens to `visualViewport.resize` and `window.resize` events, updates `--safe-height` on changes
- On non-iPad-Safari browsers, does not set `--safe-height`, allowing the CSS fallback (`100svh`) to take effect
- Falls back gracefully: if `visualViewport` is unavailable, does nothing (CSS `100svh` is the fallback)

**Note on `visualViewport` Safari bugs**: `visualViewport.height` has known quirks (jank during toolbar animation, stale values on keyboard dismiss in iOS 26). However, it is still the most reliable API for getting the actual visible area and is more accurate than `window.innerHeight` arithmetic or hardcoded offsets. The CSS `100svh` fallback ensures safe behavior when JS values are unavailable or stale.

### Bottom gap

- Replace the hardcoded `pb-16` with a CSS custom property `--bottom-bar-height` that the BottomTabBar component sets via a ref + ResizeObserver measurement
- This ensures the padding always matches the actual rendered tab bar height (including `pb-safe` for home indicator)
- When BottomTabBar is hidden via CSS (`md:hidden` → `display: none`), ResizeObserver reports height 0. However, `ResizeObserver` does NOT fire when an element transitions from `display: none` to visible (e.g., resizing from desktop to mobile). A supplementary `window.resize` listener is needed to re-measure after breakpoint transitions.

### dvh reliability

- Switch the root container from `h-dvh` to use the JS-computed `--safe-height` custom property, with `h-svh` as the CSS fallback
- Keep `100dvh` on body as a general fallback but add `100svh` as the primary value

## Tasks

### Task 1: Create useViewportSafety hook and CSS custom properties

**Description**: Create a new Preact hook that detects iPad Safari and manages CSS custom properties for safe layout dimensions. Update `styles.css` with the new custom properties and updated utility classes.

**Agent type**: coder

**Subtasks**:

1. Create `packages/web/src/hooks/useViewportSafety.ts`:
   - Detect iPad Safari: check for `navigator.maxTouchPoints > 1` (distinguishes iPadOS from macOS on non-touch Macs) AND `navigator.userAgent` containing "Safari" but not "Chrome", "CriOS", or "FxiOS" (iPadOS masquerades as macOS Safari). Do NOT use the deprecated `navigator.platform` API.
   - On iPad Safari, set `--safe-height` CSS custom property on `document.documentElement` using `window.visualViewport.height` (in px) — this is the actual visible content area after all browser chrome is subtracted.
   - Do NOT set a `--safe-top` property. The header-behind-tab-bar problem is solved by constraining the container height to `visualViewport.height`, not by adding top padding.
   - Listen to `visualViewport.resize` and `window.resize` events, update `--safe-height` on changes.
   - On non-iPad-Safari browsers, do not set `--safe-height` — allow the CSS fallback (`100svh`) to take effect.
   - If `window.visualViewport` is unavailable, do nothing (CSS fallback handles it).
   - Clean up event listeners on unmount.
   - Add a JSDoc comment noting this hook must only be called once globally (in App.tsx). Downstream components must NOT call it themselves.
   - Export the hook for use in App.tsx.

2. Update `packages/web/src/styles.css`:
   - Add CSS custom property defaults on `:root`: `--bottom-bar-height: 0px` (no `--safe-top` needed)
   - Add a new utility class `.h-safe-screen` that uses `height: var(--safe-height, 100svh)` — JS sets `--safe-height` on iPad Safari; on other browsers the `100svh` fallback applies
   - Add a new utility class `.pb-bottom-bar` that uses `padding-bottom: var(--bottom-bar-height, 0px)` — Tailwind-consistent custom utility instead of inline styles
   - Change body height from `100dvh` (with `100vh` fallback) to `100svh` (with `100vh` fallback). **Rationale**: `dvh` causes layout recalculation every time the browser toolbar animates in/out (e.g., scrolling on mobile Safari/Chrome), leading to visible jank. `svh` is static — it uses the smallest viewport (all browser chrome visible) — so no recalculations occur. **Tradeoff**: on all mobile browsers (not just iPad Safari), when the address bar collapses, there may be a small gap at the bottom rather than the page expanding to fill the full screen. This is intentional — the root container's height is managed by `.h-safe-screen` (which uses `--safe-height` from JS on iPad Safari, or `100svh` as fallback), so the body `svh` simply provides a consistent non-janky baseline.

3. Create `packages/web/src/hooks/__tests__/useViewportSafety.test.ts`:
   - Test that on non-iPad-Safari, `--safe-height` is NOT set on document root (CSS fallback applies)
   - Test that the hook cleans up event listeners
   - Test iPad Safari detection logic with mocked `navigator.maxTouchPoints` and `navigator.userAgent`
   - Test that `--safe-height` is set to `visualViewport.height` value on iPad Safari

**Acceptance criteria**:
- Hook correctly identifies iPad Safari via `maxTouchPoints` + UA string (no deprecated APIs)
- `--safe-height` is set from `visualViewport.height` on iPad Safari only
- No `--safe-top` property is used
- Event listeners are properly cleaned up on unmount
- Unit tests pass via `bunx vitest run`

**Dependencies**: None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2: Update root layout to use safe viewport dimensions

**Description**: Update `App.tsx` and overlay components to use the new `useViewportSafety` hook and CSS custom properties instead of raw `h-dvh`.

**Agent type**: coder

**Subtasks**:

1. Update `packages/web/src/App.tsx`:
   - Import and call `useViewportSafety()` at the top of the App component (it needs to run once to set up the CSS custom properties and listeners)
   - Change root container from `h-dvh` to `h-safe-screen` (the new utility class)
   - Keep `pt-safe` on the root container (safe-area-inset-top still works for notched devices)

2. Update overlay components that use `h-dvh`:
   - `packages/web/src/components/neo/NeoPanel.tsx`: change `h-dvh` to `h-safe-screen` (use grep to find the correct line)
   - `packages/web/src/components/room/SlideOutPanel.tsx`: change `h-dvh` to `h-safe-screen` (use grep to find the correct line)
   - `packages/web/src/islands/ContextPanel.tsx` (mobile overlay): **IMPORTANT** — the current code is `h-dvh md:h-full`. The `md:h-full` responsive modifier MUST be preserved because on desktop the panel sits inside the layout flow and needs `h-full`. Change to `h-safe-screen md:h-full` (only replace the mobile `h-dvh` portion, keep the `md:h-full` breakpoint rule).

3. Update tests:
   - `packages/web/src/lib/__tests__/ios-safe-area.test.ts`: Update the test that checks for `h-dvh` to verify the root uses `h-safe-screen` instead. Add a test verifying `styles.css` defines the `.h-safe-screen` utility class.
   - `packages/web/src/islands/__tests__/ContextPanel.test.tsx`: Update the assertion at ~line 611 that checks for `h-dvh` to expect `h-safe-screen` instead (the test explicitly asserts this class).

**Acceptance criteria**:
- Root container and all overlay panels use `h-safe-screen` instead of `h-dvh`
- ContextPanel preserves `md:h-full` responsive modifier alongside `h-safe-screen`
- `pt-safe` still applied on root container for notched devices
- All existing tests updated and passing (including ContextPanel test)
- No visual regression on desktop browsers (CSS fallback `100svh` applies when `--safe-height` is not set)

**Dependencies**: Task 1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3: Fix bottom tab bar padding to be dynamic

**Description**: Replace the hardcoded `pb-16` with a dynamic approach that measures the actual BottomTabBar height and communicates it via a CSS custom property. Use a Tailwind-consistent custom utility class rather than inline styles.

**Agent type**: coder

**Subtasks**:

1. Update `packages/web/src/islands/BottomTabBar.tsx`:
   - Add a `ref` to the root `div` element
   - Use `useEffect` + `ResizeObserver` to measure the actual height of the tab bar
   - Set `document.documentElement.style.setProperty('--bottom-bar-height', height + 'px')` whenever the height changes
   - **Important**: `ResizeObserver` does NOT fire when an element transitions from `display: none` to visible (e.g., resizing from desktop to mobile via the `md:hidden` breakpoint). Add a supplementary `window.resize` event listener that re-measures the ref element's `offsetHeight` after breakpoint transitions. Use `requestAnimationFrame` inside the resize handler to ensure the browser has applied the new display property before reading `offsetHeight`.
   - On unmount, set `--bottom-bar-height` to `0px` and clean up both ResizeObserver and window resize listener.

2. Update `packages/web/src/App.tsx`:
   - Replace `pb-16 md:pb-0` on the main content div with the new `.pb-bottom-bar` utility class (defined in Task 1's styles.css changes as `padding-bottom: var(--bottom-bar-height, 0px)`)
   - This is a Tailwind-consistent custom utility — not an inline style — matching the codebase's Tailwind-first approach
   - Remove `md:pb-0` since the dynamic approach handles both cases (when BottomTabBar is hidden at md+, ResizeObserver reports 0 height)

3. Update `packages/web/src/styles.css`:
   - Ensure `--bottom-bar-height: 0px` default is on `:root` (from Task 1)
   - Ensure `.pb-bottom-bar` utility is defined (from Task 1)

4. Add test coverage:
   - In `packages/web/src/lib/__tests__/ios-safe-area.test.ts`, add a test verifying that App.tsx no longer uses hardcoded `pb-16` for bottom padding (source code check)
   - Verify the BottomTabBar source contains `--bottom-bar-height` custom property usage
   - Verify App.tsx uses the `pb-bottom-bar` utility class

**Acceptance criteria**:
- Bottom padding on main content matches actual BottomTabBar height dynamically via `--bottom-bar-height`
- No hardcoded `pb-16` in the main content area
- Uses the `.pb-bottom-bar` Tailwind custom utility class (not inline styles)
- On desktop (md+ breakpoint), BottomTabBar is hidden and `--bottom-bar-height` is 0
- On iPad Mini in portrait (744px), the bottom padding correctly matches the visible tab bar
- ResizeObserver + window resize listener cleanup on unmount
- Breakpoint transitions (desktop ↔ mobile) correctly update `--bottom-bar-height` (verified by Task 4 e2e test, not unit-testable in jsdom since CSS media queries don't apply)

**Dependencies**: Task 1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4: Integration testing and iPad Safari verification

**Description**: Add a Playwright e2e test that verifies the layout adapts correctly at different viewport sizes. Add unit tests for the CSS custom property values.

**Agent type**: coder

**Limitations acknowledged**: Playwright's viewport emulation does NOT replicate Safari's compact tab bar overlay behavior. The e2e tests can verify correct CSS class usage, correct custom property values, correct responsive behavior (BottomTabBar visibility, padding changes at breakpoints), and correct viewport-size adaptation. **Manual device testing on real iPad Safari is still required** to verify the actual tab bar overlay fix. The e2e tests serve as regression guards for the responsive layout logic.

**Subtasks**:

1. Create `packages/e2e/tests/features/ipad-safari-layout.e2e.ts`:
   - Test at iPad portrait viewport (820x1180 for standard iPad, 744x1133 for iPad Mini)
   - Verify the header element is visible in the viewport (check its bounding box)
   - Verify the root container uses the `h-safe-screen` class (DOM class check — visible DOM state)
   - Verify at iPad Mini portrait (744px width) that bottom tab bar is visible and the main content area has a non-zero computed `padding-bottom` (use `getComputedStyle().paddingBottom` — this checks visible layout behavior, not internal custom property state)
   - Verify at desktop width (1280px) that bottom tab bar is hidden and the main content area has `0px` computed `padding-bottom`
   - All assertions must verify visible DOM state per CLAUDE.md e2e rules: element visibility, bounding boxes, CSS classes, computed styles — not raw JS-set custom property values

2. Add unit tests for CSS custom property behavior:
   - In the `useViewportSafety` test file (from Task 1), add tests verifying that `--safe-height` is set to `visualViewport.height` value when iPad Safari is detected (mocked `maxTouchPoints` + UA)
   - Test that `--safe-height` is NOT set when the browser is not iPad Safari (CSS fallback applies)

3. Verify all existing tests still pass:
   - Run `bunx vitest run` in packages/web to confirm unit tests pass
   - Run the new e2e test via `make run-e2e TEST=tests/features/ipad-safari-layout.e2e.ts`

**Acceptance criteria**:
- E2E test covers iPad portrait, iPad Mini portrait, and desktop viewports
- CSS class usage (`h-safe-screen`) verified via DOM class checks at each viewport size
- Bottom padding behavior verified via computed `padding-bottom` values (visible layout state, not raw custom property reads)
- All existing unit tests continue to pass
- New e2e test passes
- Test file includes a comment noting that manual iPad Safari testing is required for full verification

**Dependencies**: Task 2, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
