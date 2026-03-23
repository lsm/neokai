# Milestone 02 — Component Library

## Milestone Goal

Refactor and unify the UI primitive components in `packages/web/src/components/ui/`. Each primitive should use the new design tokens from Milestone 01 and present a consistent API, visual style, and accessibility story. No behavior changes — only visual polish and internal consistency improvements.

## Milestone Scope

- `Button.tsx` — size variants, loading state, icon slot
- `Modal.tsx` + `ConfirmModal.tsx` — unified overlay, animation, close behavior
- `Dropdown.tsx` — consistent positioning, keyboard navigation indicator
- `Tooltip.tsx` — delay, arrow, placement consistency
- `IconButton.tsx` + `NavIconButton.tsx` — active state unification
- `Spinner.tsx` + `Skeleton.tsx` — token-aware color, improved shimmer

---

## Task 2.1 — Button, IconButton, and NavIconButton Unification

**Agent type:** coder

**Description:**
Currently `Button.tsx` and `IconButton.tsx` are separate components with different className patterns. `NavIconButton.tsx` uses yet another pattern for the active state (hardcoded `bg-dark-800` + specific text color). This task standardizes the three components to use the token system and ensures the active indicator for NavIconButton follows the new design (left border accent line + subtle background).

**Subtasks (in order):**
1. Read `packages/web/src/components/ui/Button.tsx`, `IconButton.tsx`, and `NavIconButton.tsx`.
2. In `Button.tsx`:
   - Replace `bg-blue-500` / `hover:bg-blue-600` in the `primary` variant with `bg-indigo-500` / `hover:bg-indigo-600` to align with the new accent color.
   - Ensure the `loading` state spinner uses the token-aware `Spinner` component (not an inline SVG).
   - Add a `size` prop with values `'sm' | 'md' | 'lg'`; `'md'` is the current default. Define the padding and text-size for each size using the 8px grid: sm=`px-3 py-1.5 text-sm`, md=`px-4 py-2 text-sm`, lg=`px-5 py-2.5 text-base`.
   - Ensure `fullWidth` prop works with `w-full` class.
3. In `IconButton.tsx`:
   - Replace any hardcoded hover background (`hover:bg-gray-800`, `hover:bg-dark-700`) with the token value `hover:bg-dark-800` for consistency.
   - Ensure `disabled` state uses `opacity-40 cursor-not-allowed` (currently uses `opacity-50`).
4. In `NavIconButton.tsx`:
   - Replace the current active state (which varies per usage) with a single pattern: when `active`, apply `border-l-2 border-indigo-500 bg-dark-800/60 text-gray-100`; when inactive, `border-l-2 border-transparent text-gray-500 hover:text-gray-200 hover:bg-dark-800/30`.
   - Remove any remaining emoji-based icon fallbacks.
5. Run `bun run lint`, `bun run typecheck`. Fix any `no-unused-vars` errors from the new props.

**Acceptance criteria:**
- `bun run lint` and `bun run typecheck` pass
- NavRail shows a left-edge indigo accent bar on the active item
- Button primary variant uses indigo, not blue
- No behavioral regressions (existing event handlers still fire)

**Depends on:** Milestone 01 complete

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 2.2 — Modal and ConfirmModal Unification

**Agent type:** coder

**Description:**
`Modal.tsx` is a generic overlay wrapper and `ConfirmModal.tsx` uses `Modal.tsx` internally. The current implementation has inconsistencies: the backdrop uses `bg-black/60` in Modal but `bg-black/80` in ConnectionOverlay; the panel uses `bg-dark-800` but prose shows it as `bg-dark-900`; the `animate-scaleIn` animation uses `scale(0.95)` origin with a 200ms ease-out, which is appropriate. This task standardizes the modal surface and backdrop across all usage sites.

**Subtasks (in order):**
1. Read `packages/web/src/components/ui/Modal.tsx` and `ConfirmModal.tsx`.
2. In `Modal.tsx`:
   - Change backdrop to `bg-black/70 backdrop-blur-[2px]` (slightly more transparent, with minimal blur).
   - Change panel background to `bg-dark-900 border border-dark-700` (a step lighter than `dark-800` feels more panel-like).
   - Add `rounded-xl` (12px) to the panel — currently uses `rounded-lg` (8px) which is too tight for a modal.
   - Ensure the close button in the modal header uses `IconButton` from the component library rather than an inline `<button>` element.
   - Add `role="dialog"` and `aria-modal="true"` to the panel div if not already present.
3. In `ConfirmModal.tsx`:
   - Update to use the improved `Modal.tsx` directly without any style overrides.
   - Ensure the `confirmButtonVariant='danger'` renders the Button with `bg-red-600 hover:bg-red-700 text-white` — check that the Button component actually supports a `danger` variant and add it if missing.
4. Check `ConnectionOverlay.tsx` — update its panel to also use `bg-dark-900 border border-dark-700 rounded-xl` to match the modal system.
5. Run `bun run typecheck` and verify tests in `packages/web/src/components/ui/__tests__/` still pass with `bunx vitest run src/components/ui/__tests__/`.

**Acceptance criteria:**
- `bun run typecheck` passes
- All modal surfaces (Modal, ConfirmModal, ConnectionOverlay panel) have consistent `bg-dark-900 border-dark-700 rounded-xl` styling
- ConfirmModal `danger` variant button is visually distinct (red)
- Backdrop opacity is consistent at `bg-black/70`

**Depends on:** Task 2.1

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 2.3 — Dropdown, Tooltip, Collapsible Polish

**Agent type:** coder

**Description:**
The `Dropdown.tsx` component renders its panel with `bg-dark-800 border border-dark-600` but the `SessionStatusBar` model picker and thinking dropdown are rendered as raw inline `<div>` elements rather than using `Dropdown`. This creates two different code paths for the same UX pattern. The `Tooltip.tsx` component works well but its arrow is positioned inconsistently. This task aligns the dropdown pattern and polishes tooltip positioning.

**Subtasks (in order):**
1. Read `packages/web/src/components/ui/Dropdown.tsx` and `Tooltip.tsx`.
2. In `Dropdown.tsx`:
   - Update the dropdown panel to use `bg-dark-900 border border-dark-700 rounded-xl shadow-2xl` (align with modal surface style from Task 2.2).
   - Ensure the trigger wrapper uses `relative` positioning and the panel is `absolute bottom-full mb-2` or `absolute top-full mt-2` depending on a `placement` prop (default `'bottom-start'`).
   - Export a `DropdownItem` sub-component for consistent item styling: `w-full px-3 py-2 text-sm text-left flex items-center gap-2 hover:bg-dark-800 transition-colors rounded-lg` — danger items get `text-red-400 hover:bg-red-950/50`.
   - Add `type DropdownItem` to the exported types so `ChatHeader.tsx` (which currently builds action arrays) can use it.
3. In `Tooltip.tsx`:
   - Ensure all four placement values (`top`, `bottom`, `left`, `right`) compute the correct arrow position. Read the current implementation and fix any off-by-one pixel issues in the arrow offset.
   - Change the tooltip background to `bg-dark-900 border border-dark-700` to match the new surface style.
4. In `Collapsible.tsx`:
   - Read the file and ensure the toggle chevron uses `transition-transform duration-150` when rotating.
   - Ensure the collapsed state uses `max-h-0 overflow-hidden` and the expanded state uses `max-h-screen` (or a measured value) with `transition-[max-height] duration-250 ease-out`.
5. Run `bun run lint` and `bun run typecheck`.

**Acceptance criteria:**
- `bun run lint` and `bun run typecheck` pass
- `Dropdown` panel matches modal panel style
- `DropdownItem` with `danger=true` shows red text
- Tooltip arrow points in the correct direction for all four placements

**Depends on:** Task 2.2

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 2.4 — Spinner, Skeleton, Toast, and ContentContainer

**Agent type:** coder

**Description:**
`Spinner.tsx` currently uses a hardcoded `border-gray-600 border-t-blue-500` color pair regardless of context. `Skeleton.tsx` uses a CSS `shimmer` animation that references dark colors, which is correct for the dark theme but the gradient endpoints could be refined. The `Toast.tsx` component uses a hardcoded border-left accent for each toast type. `ContentContainer.tsx` sets a max-width for the chat content area — verify this is correct and add responsive behavior.

**Subtasks (in order):**
1. Read `Spinner.tsx`, `Skeleton.tsx`, `Toast.tsx`, `ContentContainer.tsx`.
2. In `Spinner.tsx`:
   - Add a `color` prop with values `'default' | 'accent' | 'white'`.
   - `default`: `border-dark-600 border-t-gray-400`
   - `accent`: `border-dark-600 border-t-indigo-400`
   - `white`: `border-white/20 border-t-white`
   - Keep `size` prop (`sm` / `md` / `lg`) as-is.
3. In `Skeleton.tsx`:
   - Update the shimmer gradient to use the new surface-level colors: dark-900 → dark-800 → dark-900.
   - Add a `rounded` prop (default `'md'`) that applies `rounded-sm` / `rounded-md` / `rounded-lg` / `rounded-full`.
4. In `Toast.tsx`:
   - Update success/error/warning/info border-left colors to use the status tokens from `design-tokens.ts`:
     - success: `border-l-4 border-green-500`
     - error: `border-l-4 border-red-500`
     - warning: `border-l-4 border-amber-500`
     - info: `border-l-4 border-indigo-500`
   - Change the toast background from `bg-dark-800` to `bg-dark-900` for consistency.
5. In `ContentContainer.tsx`:
   - Verify the max-width matches the chat header max-width (`max-w-4xl`).
   - If the component only adds `max-w-4xl mx-auto px-4`, confirm it does and add a `sm:px-6` responsive padding for slightly more breathing room on medium screens.
6. Run `bun run lint` and `bun run typecheck`.

**Acceptance criteria:**
- `bun run lint` and `bun run typecheck` pass
- Spinner accepts `color` prop and renders correctly
- Skeleton shimmer is visually smooth on dark background
- Toast colors match the status token system
- ContentContainer has responsive horizontal padding

**Depends on:** Task 2.1

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
