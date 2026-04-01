# Fix iPad Safari Layout: Header Behind Tabs and Bottom Gap

## Goal

Fix two layout issues on iPad Safari:

1. **Header hidden behind Safari tabs** -- The root container uses `pt-safe` which maps to `env(safe-area-inset-top)`. On iPad (no notch), this value is 0, but Safari's tab bar overlays the top of the page, hiding the header.
2. **Unnecessary bottom gap** -- The main content uses `pb-16 md:pb-0` for bottom tab bar clearance. On iPad Mini in portrait (744px viewport width), this falls below the `md:` (768px) breakpoint, applying 64px of padding even though the BottomTabBar uses the same `md:hidden` breakpoint -- so they match, but iPad Mini gets the mobile layout with a bottom tab bar that may not match the hardcoded 64px padding.

## Approach

### Header behind Safari tabs

There is no CSS-only way to detect Safari's tab bar overlay. `env(safe-area-inset-top)` only accounts for the hardware notch (0 on iPads). `visualViewport.offsetTop` measures pinch-zoom offset, NOT browser chrome. The practical solutions are:

1. **Use `h-svh` instead of `h-dvh`** -- `svh` (small viewport height) represents the viewport with all browser chrome visible. This prevents the container from extending behind the tab bar. The tradeoff is that when the tab bar auto-hides (e.g., scrolling in landscape), there may be a small gap at the bottom rather than filling the full screen. This is the least janky option.

2. **Add a CSS custom property `--top-offset`** set by JS that detects iPad Safari via user-agent and applies a fixed top padding (approximately 50px for the Safari compact tab bar). This is fragile but addresses the specific problem.

3. **Accepted limitation** -- Safari's compact tab bar on iPad intentionally overlaps content, similar to how desktop browser toolbars work. Many apps simply accept this. However, since NeoKai's header contains critical controls, we should mitigate it.

**Chosen approach**: Create a `useViewportSafety` hook that:
- Detects iPad Safari via user-agent sniffing (iPadOS reports as macOS Safari with touch support)
- Compares `window.innerHeight` vs `document.documentElement.clientHeight` to detect if browser chrome is eating space
- Sets CSS custom properties (`--safe-top`, `--safe-height`) on the document root
- Updates on `resize` and `visualViewport.resize` events
- Falls back to `env(safe-area-inset-top)` and `100dvh` when detection is not needed

### Bottom gap

- Replace the hardcoded `pb-16` with a CSS custom property `--bottom-bar-height` that the BottomTabBar component sets via a ref measurement
- This ensures the padding always matches the actual rendered tab bar height (including `pb-safe` for home indicator)
- When BottomTabBar is hidden (`md:hidden`), the custom property is set to 0

### dvh reliability

- Switch the root container from `h-dvh` to use the JS-computed `--safe-height` custom property, with `h-svh` as the CSS fallback
- Keep `100dvh` on body as a general fallback but add `100svh` as the primary value

## Tasks

### Task 1: Create useViewportSafety hook and CSS custom properties

**Description**: Create a new Preact hook that detects iPad Safari and manages CSS custom properties for safe layout dimensions. Update `styles.css` with the new custom properties and updated utility classes.

**Agent type**: coder

**Subtasks**:

1. Create `packages/web/src/hooks/useViewportSafety.ts`:
   - Detect iPad Safari: check for `navigator.maxTouchPoints > 1` AND `navigator.userAgent` containing "Safari" but not "Chrome" AND `navigator.platform` starting with "Mac" (iPadOS masquerades as macOS)
   - On iPad Safari, calculate top offset: use a heuristic based on `window.screen.height - window.innerHeight` compared to expected values, or use a fixed 50px offset for the compact tab bar (this is the most reliable approach given API limitations)
   - Set `--safe-top` CSS custom property on `document.documentElement` (0px for non-iPad-Safari, calculated value for iPad Safari)
   - Set `--safe-height` CSS custom property: `calc(100svh - var(--safe-top))` or computed from `visualViewport.height` as a JS value
   - Listen to `resize` and `visualViewport.resize` events, update on changes
   - Clean up event listeners on unmount
   - Export the hook for use in App.tsx

2. Update `packages/web/src/styles.css`:
   - Add CSS custom property defaults on `:root`: `--safe-top: env(safe-area-inset-top, 0px)`, `--bottom-bar-height: 0px`
   - Update `.pt-safe` to use `padding-top: var(--safe-top)` (so JS can override it)
   - Add a new utility class `.h-safe-screen` that uses `height: var(--safe-height, 100svh)`
   - Change body height from `100dvh` (with `100vh` fallback) to `100svh` (with `100vh` fallback) to reduce jank

3. Create `packages/web/src/hooks/__tests__/useViewportSafety.test.ts`:
   - Test that on non-iPad-Safari, custom properties default to standard values
   - Test that the hook cleans up event listeners
   - Test iPad Safari detection logic with mocked navigator properties

**Acceptance criteria**:
- Hook correctly identifies iPad Safari via user-agent/touch heuristics
- CSS custom properties are set on document root
- Event listeners are properly cleaned up on unmount
- Unit tests pass via `bunx vitest run`

**Dependencies**: None

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2: Update root layout to use safe viewport dimensions

**Description**: Update `App.tsx` and overlay components to use the new `useViewportSafety` hook and CSS custom properties instead of raw `h-dvh` and `pt-safe`.

**Agent type**: coder

**Subtasks**:

1. Update `packages/web/src/App.tsx`:
   - Import and call `useViewportSafety()` at the top of the App component (it needs to run once to set up the CSS custom properties and listeners)
   - Change root container from `h-dvh` to `h-safe-screen` (the new utility class)
   - Keep `pt-safe` on the root container (it now uses `var(--safe-top)` which the hook overrides)

2. Update overlay components that use `h-dvh pt-safe`:
   - `packages/web/src/components/neo/NeoPanel.tsx` line 157: change `h-dvh` to `h-safe-screen`
   - `packages/web/src/components/room/SlideOutPanel.tsx` line 109: change `h-dvh` to `h-safe-screen`
   - `packages/web/src/islands/ContextPanel.tsx` line 361 (mobile overlay): change `h-dvh` to `h-safe-screen`

3. Update `packages/web/src/lib/__tests__/ios-safe-area.test.ts`:
   - Update the test that checks for `pt-safe` to also verify the root uses `h-safe-screen`
   - Add a test verifying that `styles.css` defines the `--safe-top` custom property
   - Add a test verifying that `styles.css` defines the `.h-safe-screen` utility class

**Acceptance criteria**:
- Root container and all overlay panels use `h-safe-screen` instead of `h-dvh`
- `pt-safe` still applied but now reads from `--safe-top` (JS-overridable)
- Existing tests updated and passing
- No visual regression on desktop browsers (custom properties fall back to standard values)

**Dependencies**: Task 1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3: Fix bottom tab bar padding to be dynamic

**Description**: Replace the hardcoded `pb-16` with a dynamic approach that measures the actual BottomTabBar height and communicates it via a CSS custom property.

**Agent type**: coder

**Subtasks**:

1. Update `packages/web/src/islands/BottomTabBar.tsx`:
   - Add a `ref` to the root `div` element
   - Use `useEffect` + `ResizeObserver` to measure the actual height of the tab bar
   - Set `document.documentElement.style.setProperty('--bottom-bar-height', height + 'px')` whenever the height changes
   - On unmount (or when the bar is hidden), set `--bottom-bar-height` to `0px`

2. Update `packages/web/src/App.tsx`:
   - Replace `pb-16 md:pb-0` on the main content div with an inline style: `paddingBottom: 'var(--bottom-bar-height, 0px)'`
   - Remove the `md:pb-0` since the dynamic approach handles both cases (when BottomTabBar is hidden at md+, it sets the variable to 0)

3. Update `packages/web/src/styles.css`:
   - Ensure `--bottom-bar-height: 0px` default is on `:root` (from Task 1)

4. Add test coverage:
   - In `packages/web/src/lib/__tests__/ios-safe-area.test.ts`, add a test verifying that App.tsx no longer uses hardcoded `pb-16` for bottom padding (source code check)
   - Verify the BottomTabBar source contains `--bottom-bar-height` custom property usage

**Acceptance criteria**:
- Bottom padding on main content matches actual BottomTabBar height dynamically
- No hardcoded `pb-16` in the main content area
- On desktop (md+ breakpoint), BottomTabBar is hidden and `--bottom-bar-height` is 0
- On iPad Mini in portrait (744px), the bottom padding correctly matches the visible tab bar
- ResizeObserver cleanup on unmount

**Dependencies**: Task 1

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 4: Integration testing and iPad Safari verification

**Description**: Add a Playwright e2e test that verifies the layout adapts correctly at different viewport sizes, simulating iPad Safari dimensions.

**Agent type**: coder

**Subtasks**:

1. Create `packages/e2e/tests/features/ipad-safari-layout.e2e.ts`:
   - Test at iPad portrait viewport (820x1180 for standard iPad, 744x1133 for iPad Mini)
   - Verify the header element is visible and not obscured (check its bounding box top position is > 0)
   - Verify the main content area does not have excessive bottom padding at desktop viewport (1280x800)
   - Verify at iPad Mini portrait (744px width) that bottom tab bar is visible and main content has appropriate bottom padding
   - Verify at desktop width (1280px) that bottom tab bar is hidden and no bottom padding is applied

2. Verify all existing tests still pass:
   - Run `bunx vitest run` in packages/web to confirm unit tests pass
   - Run the new e2e test via `make run-e2e TEST=tests/features/ipad-safari-layout.e2e.ts`

**Acceptance criteria**:
- E2E test covers iPad portrait, iPad Mini portrait, and desktop viewports
- Header visibility is verified at each viewport size
- Bottom padding behavior is verified at each viewport size
- All existing unit tests continue to pass
- New e2e test passes

**Dependencies**: Task 2, Task 3

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
