# Milestone 01 — Design System Tokens

## Milestone Goal

Establish a complete, coherent design token system that all subsequent milestones reference. This work is entirely within `packages/web/src/styles.css` and `packages/web/src/lib/design-tokens.ts`. No visible UI change is expected from this milestone alone — it creates the vocabulary for all future changes.

## Milestone Scope

- Extend the CSS custom property definitions in `styles.css` with a full color scale, spacing scale, and transition definitions
- Refactor `design-tokens.ts` to export a consolidated token set with clear categories
- Document each token group with usage intent

---

## Task 1.1 — Extend CSS Custom Properties

**Agent type:** coder

**Description:**
The current `styles.css` defines `--color-dark-*` variables, `--color-dark-850-rgb`, `--color-dark-800-rgb`, and one blue RGB triplet inside an `@theme {}` block. We need to extend this with a complete CSS custom property vocabulary covering: semantic colors, border-radius, and transition durations. Because the project uses Tailwind v4 (via `@import "tailwindcss"` with an `@theme {}` block), any variable added to `@theme` automatically creates a corresponding Tailwind utility class. This will be referenced by Tailwind utilities and by component-level inline styles where Tailwind classes cannot reach.

**Subtasks (in order):**
1. Open `packages/web/src/styles.css` and read all existing `@theme` variables. Note that `--color-dark-800-rgb: 31 31 35` and `--color-dark-850-rgb: 24 24 27` are already present — do NOT re-add them.
2. Add the following new custom properties inside the existing `@theme {}` block:
   - Accent color: `--color-accent: 99 102 241` (indigo-500) and `--color-accent-hover: 79 70 229` (indigo-600)
   - Surface colors: `--color-surface-0: var(--color-dark-950)`, `--color-surface-1: var(--color-dark-900)`, `--color-surface-2: var(--color-dark-800)`
   - Text scale: `--color-text-primary: 243 244 246`, `--color-text-secondary: 156 163 175`, `--color-text-muted: 107 114 128`
   - Border: `--color-border-default: 42 42 48`, `--color-border-subtle: 58 58 66`
   - Status: success (`34 197 94`), warning (`251 191 36`), error (`239 68 68`), info (`99 102 241`)
   - **Transition duration (Tailwind v4 utility registration):** `--duration-250: 250ms` — this registers the `duration-250` Tailwind utility class (built-in Tailwind only provides 75, 100, 150, 200, 300, 500, 700, 1000; 250ms is missing and must be explicitly registered). Also add `--duration-instant: 0ms` and `--duration-deliberate: 400ms` for completeness (150ms and 300ms already exist as built-ins).
3. Add semantic duration aliases as CSS variables on `:root` (these are for use in raw CSS rules, not Tailwind classes):
   - `--duration-quick: 150ms`
   - `--duration-smooth: 250ms`
   - `--duration-deliberate: 400ms`
4. Add a single `--radius-base: 8px` and `--radius-lg: 12px` and `--radius-xl: 20px` (for message bubbles) — add inside `@theme {}` so they register as Tailwind utilities.
5. Verify the file still passes the Biome format check: `bun run format:check`.

**Acceptance criteria:**
- `bun run format:check` passes with no changes needed
- `bun run typecheck` passes
- New CSS variables are accessible in browser devtools when the app runs
- No existing visual regressions (no other files changed yet)

**Depends on:** nothing

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 1.2 — Refactor Design Tokens Module

**Agent type:** coder

**Description:**
The file `packages/web/src/lib/design-tokens.ts` currently exports four separate const objects (`messageSpacing`, `borderRadius`, `messageColors`, `customColors`, `borderColors`). These were added ad-hoc and the `borderColors` object has grown to 20+ entries covering UI, semantic, tool, interactive, and special categories. We need to consolidate into a single coherent `tokens` export with clear sub-namespaces, while keeping backward-compatible re-exports so existing components do not break.

**Subtasks (in order):**
1. Read `packages/web/src/lib/design-tokens.ts` in full.
2. Create a new top-level `tokens` object that groups everything: `tokens.color`, `tokens.spacing`, `tokens.radius`, `tokens.transition`.
3. Under `tokens.color`, add:
   - `tokens.color.accent` = `'bg-indigo-500'` (replaces all `bg-blue-500` usages in message bubbles)
   - `tokens.color.surface` = `{ app: 'bg-dark-950', panel: 'bg-dark-900', card: 'bg-dark-800' }`
   - `tokens.color.text` = `{ primary: 'text-gray-100', secondary: 'text-gray-400', muted: 'text-gray-500' }`
   - `tokens.color.border` = `{ default: 'border-dark-700', subtle: 'border-dark-600' }`
   - `tokens.color.status` = `{ success: 'text-green-400', warning: 'text-amber-400', error: 'text-red-400', info: 'text-indigo-400' }`
4. Under `tokens.spacing`, add the standard chat container max-width: `tokens.spacing.chatMaxWidth = 'max-w-4xl'`.
5. Under `tokens.radius`, consolidate the existing `borderRadius` entries plus add `tokens.radius.panel = 'rounded-xl'`.
6. Under `tokens.transition`, add: `tokens.transition.quick = 'transition-all duration-150 ease-out'`, `tokens.transition.smooth = 'transition-all duration-250 ease-out'`. The `duration-250` class is valid here because Task 1.1 registers `--duration-250: 250ms` in the `@theme` block.
7. Keep all existing named exports (`messageSpacing`, `borderRadius`, `messageColors`, `customColors`, `borderColors`) pointing to their corresponding new locations — do NOT remove them, only re-export from the new structure. This prevents any component breakage.
8. Export `tokens` as the default export and as a named export.
9. Run `bun run typecheck` and `bun run lint` to verify no type errors or lint issues.

**Acceptance criteria:**
- `bun run typecheck` passes
- `bun run lint` passes
- All existing named exports remain importable without change
- The new `tokens` object is exported and strongly typed

**Depends on:** Task 1.1

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 1.3 — Typography and Global Prose Refinements

**Agent type:** coder

**Description:**
The current `styles.css` prose styles use a mix of hardcoded hex colors and `rgb(var(...))` patterns. The heading hierarchy (`h1` at `2em`, `h2` at `1.5em`, `h3` at `1.25em`) is appropriate, but line-height values (`1.75` for body, `1.3` for headings) can be made more readable. This task also adds a CSS class `.text-balance` polyfill wrapper and ensures the scrollbar styles use the new CSS variables.

**Subtasks (in order):**
1. Read `packages/web/src/styles.css` to understand the current prose and scrollbar rules.
2. Update `.prose p` to use `line-height: 1.7` (slightly tighter, more precise).
3. Update `.prose code` background and color to reference the existing CSS variable: `background: rgb(var(--color-dark-800-rgb))`. Note: `--color-dark-800-rgb: 31 31 35` is already defined in `styles.css` (present since the initial codebase — not added by Task 1.1). No addition is needed; this subtask only updates the prose rule to consume it.
4. Update `::-webkit-scrollbar-track` to use `rgb(var(--color-dark-950))` (currently uses dark-900, making it slightly lighter than the body — fix this visual inconsistency).
5. Update `::-webkit-scrollbar-thumb` to use `rgb(var(--color-dark-600))` (currently uses dark-700, making it barely visible on dark-900 tracks).
6. Add a `.text-balance` utility class using `text-wrap: balance` with a fallback comment.
7. Add a `.surface-panel` utility class: `background: rgb(var(--color-dark-900)); border: 1px solid rgb(var(--color-dark-700));` for use in modal/panel components.
8. Run `bun run format` to auto-format the CSS file.
9. Run `bun run format:check` to confirm clean output.

**Acceptance criteria:**
- `bun run format:check` passes
- Scrollbar appears slightly more visible in dev browser
- `.text-balance` and `.surface-panel` classes exist in the stylesheet
- No existing component styles are broken

**Depends on:** Task 1.1

**Branch/PR:** Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
