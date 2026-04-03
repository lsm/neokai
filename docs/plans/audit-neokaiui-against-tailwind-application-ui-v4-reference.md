# Audit: @neokai/ui vs Tailwind Application UI v4 Reference

## Executive Summary

This audit compares the `@neokai/ui` headless component library (v0.8.0) against the Tailwind Application UI v4 React examples (364 files across 11 categories) and the Tailwind Catalyst UI Kit (27 styled components). The goal is to identify missing components, API improvements, and design system gaps that would benefit NeoKai's UI/UX work.

**Key finding:** `@neokai/ui` is a well-built headless library with 20 exports across 15 component families and comprehensive test coverage (25 test files), but it is **not used anywhere** in the NeoKai web application. The web app has 20 parallel UI component implementations in `packages/web/src/components/ui/` that duplicate functionality with weaker accessibility and positioning. This duplication is the most impactful gap to address.

**Secondary finding:** The Tailwind v4 reference demonstrates patterns across data display, navigation, feedback, layout, and application shells that @neokai/ui lacks entirely. While the headless primitives for interactive components (Dialog, Menu, Combobox, etc.) are solid, there is no styled/pre-themed component layer and no shared design token system between the UI library and the web app.

---

## 1. @neokai/ui Current State

### 1.1 Component Inventory

The library exports **20 symbols** from **15 component families** (verified from `packages/ui/src/mod.ts`):

| Component Family | Exports | Category |
|---|---|---|
| Button | Button, CloseButton, DataInteractive | Interactive |
| Checkbox | Checkbox | Form |
| Combobox | Combobox, ComboboxInput, ComboboxButton, ComboboxOption, ComboboxOptions | Selection |
| Dialog | Dialog, DialogPanel, DialogTitle, DialogDescription, DialogBackdrop | Overlay |
| Disclosure | Disclosure, DisclosureButton, DisclosurePanel | Interactive |
| Field | Field, Fieldset, Label, Description, Legend | Form |
| Input | Input, Textarea, Select | Form |
| Listbox | Listbox, ListboxButton, ListboxOption, ListboxOptions, ListboxSelectedOption | Selection |
| Menu | Menu, MenuButton, MenuItems, MenuItem, MenuSection, MenuHeading, MenuSeparator | Overlay |
| Popover | Popover, PopoverButton, PopoverPanel, PopoverBackdrop, PopoverGroup | Overlay |
| Tooltip | Tooltip, TooltipPanel, TooltipTrigger | Overlay |
| RadioGroup | RadioGroup, Radio | Form |
| Switch | Switch | Form |
| Tabs | TabGroup, TabList, Tab, TabPanels, TabPanel | Navigation |
| Transition | Transition, TransitionChild | Animation |
| Toast | Toast, ToastTitle, ToastDescription, ToastAction, Toaster, useToast | Feedback |
| IconButton | IconButton | Interactive |
| Skeleton | Skeleton | Feedback |
| Spinner | Spinner | Feedback |

Plus one hook: `useClose`.

### 1.2 Architecture Strengths

- **Headless/unstyled pattern**: All components use a `render()` utility from `internal/render.ts` that merges accessibility props with user-provided styling. Interaction states are exposed via `data-*` attributes (`data-hover`, `data-focus`, `data-active`, `data-open`, `data-closed`, `data-enter`, `data-leave`, `data-transition`, `data-selected`, `data-disabled`).
- **Compound component pattern**: Context-based composition with parent-child validation (e.g., `DialogTitle` must be within `Dialog`).
- **Polymorphic `as` prop**: Every component accepts `as` to render as any HTML element.
- **Stack machine**: Dialog, Menu, and Popover share a `stackMachines` singleton for proper z-ordering of nested overlays.
- **Floating UI integration**: Menu and Popover use `@floating-ui/dom` v1.7.6 for robust positioned panels with collision detection.
- **Transition system**: RAF-based `data-enter` / `data-leave` / `data-closed` / `data-transition` attributes enable pure CSS transitions. Uses `CSSTransition` via `getAnimations()` API.
- **Full WAI-ARIA support**: Focus trapping, scroll locking, inert tree handling, `aria-labelledby`, `aria-describedby`, `aria-expanded`, `aria-selected`.
- **Comprehensive tests**: 25 test files covering all component families plus internal utilities.

### 1.3 Dependencies

- `@floating-ui/dom` v1.7.6 (latest)
- `preact` v10.29.0 (latest in 10.x)
- Dev: `tailwindcss` v4.2.2, `vitest` v4.1.2

### 1.4 Adoption Status

**@neokai/ui is not imported by any package in the monorepo** other than its own demo. The web app (`packages/web/`) has zero imports of `@neokai/ui`. The library exists in isolation.

---

## 2. Tailwind Application UI v4 Reference Overview

The reference at `/Users/lsm/focus/tmp/tailwind/application-ui-v4/react/` contains **364 JSX example files** across **11 categories** (verified):

| Category | Subcategories | Files |
|---|---|---|
| application-shells | multi-column, sidebar, stacked | 23 |
| data-display | calendars, description-lists, stats | 19 |
| elements | avatars, badges, button-groups, buttons, dropdowns | 45 |
| feedback | alerts, empty-states | 12 |
| forms | action-panels, checkboxes, comboboxes, form-layouts, input-groups, radio-groups, select-menus, sign-in-forms, textareas, toggles | 74 |
| headings | card-headings, page-headings, section-headings | 25 |
| layout | cards, containers, dividers, list-containers, media-objects | 38 |
| lists | feeds, grid-lists, stacked-lists, tables | 44 |
| navigation | breadcrumbs, command-palettes, navbars, pagination, progress-bars, sidebar-navigation, tabs, vertical-navigation | 54 |
| overlays | drawers, modal-dialogs, notifications | 24 |
| page-examples | detail-screens, home-screens, settings-screens | 6 |

The reference uses `@headlessui/react` for interactive patterns -- the React equivalent of @neokai/ui's headless approach. The `data-*` attribute patterns match exactly: `data-enter`, `data-leave`, `data-closed`, `data-focus`, `data-hover`, `data-selected`.

---

## 3. Gap Analysis: Missing Components

### 3.1 Components That Should Be Added to @neokai/ui

These are headless primitives that the Tailwind v4 reference demonstrates as interactive patterns requiring state management, keyboard navigation, or accessibility behavior beyond what plain HTML provides.

| Component | Reference Examples | Priority | Notes |
|---|---|---|---|
| **Avatar** | 11 examples (circular, rounded, groups, notifications, initials) | Medium | Needs image loading states, fallback rendering, group stacking with overflow count. Not truly headless -- could be a styled component instead. |
| **Badge** | 18 examples (bordered, flat, pill, dot indicators, removable) | Medium | Primarily visual -- could be a styled component with `data-variant` attributes. |
| **Alert** | 6 examples (with description, list, actions, accent border, dismiss) | Medium | Needs dismiss behavior, ARIA `role="alert"`, icon slot. Headless variant with `onDismiss` callback. |
| **Command Palette** | 9 examples (simple, with preview, grouped, with footer) | Low | Composable from existing `Dialog` + `Combobox`. No new primitive needed -- instead, create a styled recipe/pattern. |
| **Drawer** | 9 examples (empty, overlay, branded header, sticky footer) | Low | Achievable by styling `Dialog` with slide-in transition (reference itself uses `Dialog` + `DialogPanel` with `data-closed:translate-x-full`). No new component needed. |
| **Notification/Toast variants** | 6 examples (simple, condensed, with actions, with avatar, split buttons) | High | @neokai/ui's `Toast` lacks variant types (success/error/warning/info), icon slots, and progress bar. The web app's `ToastItem` has all of these. |

### 3.2 Patterns That Are Purely Styled (No Headless Primitive Needed)

These patterns from the Tailwind v4 reference are visual layouts that can be built with Tailwind utility classes and existing headless primitives. They do not require new @neokai/ui components:

| Pattern | Reference Examples | Implementation Approach |
|---|---|---|
| **Application Shells** | 23 (sidebar, multi-column, stacked) | Layout primitives with CSS Grid/Flexbox. Could be styled recipes. |
| **Cards** | 8+ examples | Tailwind classes. No component needed. |
| **Dividers** | 8 examples | `<hr>` with Tailwind or a simple styled `Divider` component. |
| **Tables** | 19 examples | HTML `<table>` with Tailwind. No headless primitive needed. |
| **Description Lists** | 8 examples | HTML `<dl>` with Tailwind. No headless primitive needed. |
| **Media Objects** | 8 examples | Flex layout pattern. No component needed. |
| **Stats** | 8 examples | Layout pattern with typography. No component needed. |
| **Empty States** | 6 examples | Layout pattern with illustration slot. |
| **Breadcrumb** | 6 examples | Nav landmark + list. Could be a simple styled component. |
| **Pagination** | 3 examples | Nav landmark + buttons. Could be a simple styled component. |
| **Progress Bar** | 8 examples | Could benefit from a headless primitive with `value`, `max`, animation support, and ARIA `role="progressbar"`. |
| **Feeds** | 15 examples | Layout pattern. No component needed. |
| **Headings** | 25 examples (page, section, card) | Typography/layout patterns. No component needed. |
| **Form Layouts** | 5 examples | Grid/Flex layout patterns. |
| **Input Groups** | 21 examples | Wrapper around existing `Input` with addons. Could be a styled composition. |

---

## 4. Web App Duplication Analysis

### 4.1 Component Mapping

The web app has **20 UI component files** in `packages/web/src/components/ui/`. These are the duplicates and their @neokai/ui equivalents:

| Web App Component | @neokai/ui Equivalent | Gap Assessment |
|---|---|---|
| `Button.tsx` | `Button` | Web's Button is simpler but functional. @neokai/ui provides hover/focus/active data attributes. |
| `Modal.tsx` | `Dialog` + `DialogPanel` + `DialogBackdrop` | **Significant gap.** Web's Modal has basic focus trapping and escape handling (verified from source). It sets `document.body.style.overflow = 'hidden'` but lacks: scroll lock utility (no body padding compensation), inert tree handling for accessibility, transition support, dedicated backdrop component, nested dialog support (no stack machine), `aria-labelledby`/`aria-describedby` auto-linking, `alertdialog` role support, and drawer rendering capability. @neokai/ui's Dialog has all of these. |
| `Toast.tsx` | `Toast` + `Toaster` + `useToast` | **Bidirectional gap.** Web's `ToastItem` has features missing from @neokai/ui: typed variants (success/error/warning/info) with distinct colors and icons, a progress bar showing remaining duration, and an exit animation. @neokai/ui's Toast has features missing from web: proper `role="status"`, `aria-labelledby`/`aria-describedby`, transition integration via `Transition` component, and a `Toaster` container with positioning. |
| `Dropdown.tsx` | `Menu` + `MenuButton` + `MenuItems` + `MenuItem` | **Significant gap.** Web's Dropdown implements manual viewport-aware positioning with `getBoundingClientRect()` calculations (~80 lines of positioning logic, verified from source). It also has manual click-outside detection, manual keyboard navigation (ArrowUp/Down/Enter/Space), and manual escape handling. @neokai/ui's Menu handles all of this via @floating-ui with proper collision detection and flip/shift strategies. |
| `Tooltip.tsx` | `Tooltip` + `TooltipPanel` + `TooltipTrigger` | **Significant gap.** Web's Tooltip uses CSS `absolute` positioning with `translate` transforms (verified from source). It has no collision detection -- tooltips can overflow the viewport. @neokai/ui's Tooltip uses @floating-ui for robust positioning with viewport boundary detection. However, web's Tooltip has a configurable delay (default 500ms) which @neokai/ui's should verify. |
| `Spinner.tsx` | `Spinner` | Similar. Both are headless with sr-only label. |
| `Skeleton.tsx` | `Skeleton` | Similar. Both are headless with animation variant. |
| `IconButton.tsx` | `IconButton` | Similar. @neokai/ui exposes hover/focus/active data attributes. |
| `Dropdown.tsx` (also) | `Popover` + `PopoverButton` + `PopoverPanel` | Web's Dropdown with `customContent` prop is essentially a Popover. |
| `Collapsible.tsx` | `Disclosure` | Similar patterns. Web's uses CSS max-height animation. |
| `ConfirmModal.tsx` | `Dialog` with `role="alertdialog"` | Web wraps Modal in a confirmation pattern. @neokai/ui's Dialog supports `role="alertdialog"` natively. |
| `RejectModal.tsx` | `Dialog` | Another Modal wrapper. |
| `ActionBar.tsx` | None | Web-specific action bar pattern. |
| `ContentContainer.tsx` | None | Layout wrapper. |
| `CopyButton.tsx` | None | Copy-to-clipboard with feedback. |
| `CircularProgressIndicator.tsx` | None | Circular progress. |
| `InboxBadge.tsx` | None | Notification badge. |
| `MobileMenuButton.tsx` | None | Hamburger menu trigger. |
| `NavIconButton.tsx` | None | Navigation icon button. |
| `Portal.tsx` | Internal `Portal` | Both implement portal rendering. Web's is public, @neokai/ui's is internal. |

### 4.2 Where Web App UI Components Are Used

Web UI components are imported across **9 island files** with **21 total import occurrences**:
- `ChatContainer.tsx` (6 imports -- heaviest consumer)
- `Lobby.tsx` (3 imports)
- `Room.tsx` (3 imports)
- `ContextPanel.tsx` (2 imports)
- `NavRail.tsx` (2 imports)
- `SessionsPage.tsx` (2 imports)
- `MainContent.tsx`, `BottomTabBar.tsx`, `ToastContainer.tsx` (1 each)

---

## 5. Design System and Token Alignment

### 5.1 Token Divergence (Verified)

The @neokai/ui demo and the web app use **completely different design token systems**.

**@neokai/ui demo** (`packages/ui/demo/styles.css`):
- Semantic tokens: `--surface-0` through `--surface-3`, `--text-primary` through `--text-muted`
- Light/dark mode via `:root` / `.dark` CSS custom properties
- Tailwind v4 `@theme` block mapping to `--color-surface-*`, `--color-text-*`
- Accent color: `--color-accent-500: #6366f1` (indigo)
- Legacy `dark-*` tokens for backward compatibility

**Web app** (`packages/web/src/lib/design-tokens.ts`):
- TypeScript constants, not CSS custom properties
- Message-specific tokens: `messageSpacing`, `messageColors` (iMessage-inspired)
- Structural tokens: `borderColors.ui.*`, `borderColors.tool.*`, `borderColors.semantic.*`
- Uses Tailwind class strings directly (e.g., `'bg-dark-800'`, `'border-dark-700'`)
- No light mode support (dark-only design)
- Accent: `bg-indigo-500` in the unified `tokens` object

**Impact:** These two systems cannot coexist without a unified token layer. Any migration of the web app to @neokai/ui requires first establishing a shared token system.

### 5.2 Catalyst UI Kit Theming Pattern (Reference)

The Catalyst UI Kit demonstrates an elegant theming approach worth studying:

- CSS custom properties per component: `--btn-bg`, `--btn-border`, `--btn-hover-overlay`, `--btn-icon`
- Runtime theming without JavaScript: `bg-(--btn-bg)`, `text-(--btn-icon)`
- Style objects merged with `clsx`: `styles.base`, `styles.solid`, `styles.colors.dark/zinc`
- `TouchTarget` component expanding hit area to 44x44px on touch devices
- Optical border technique using `before:` pseudo-element for border+shadow composition

**Recommendation:** Adopt the CSS custom property per-component pattern for the styled layer. This enables runtime theming (e.g., brand color changes, dark/light mode) without JavaScript re-renders.

---

## 6. Recommendations

### HIGH IMPACT

#### R1. Migrate Web App to @neokai/ui for Overlay Components

**Why:** The web app's Modal, Dropdown, and Tooltip have significant accessibility and positioning gaps compared to @neokai/ui's Dialog, Menu, and Tooltip. The web's Dropdown alone has ~80 lines of manual positioning code that @floating-ui handles automatically.

**Approach:**
1. Create a thin styled wrapper layer that composes @neokai/ui headless primitives with NeoKai's design tokens
2. Migrate Modal -> Dialog (gains: inert tree, nested dialog support, transitions, proper ARIA)
3. Migrate Dropdown -> Menu (gains: @floating-ui positioning, collision detection, proper keyboard nav)
4. Migrate Tooltip -> Tooltip (gains: @floating-ui positioning, viewport boundary detection)
5. Migrate ConfirmModal/RejectModal -> Dialog with `role="alertdialog"`

**Estimated effort:** 2-3 sessions. The styled wrappers would be small since they just apply Tailwind classes to @neokai/ui components.

#### R2. Establish a Shared Design Token System

**Why:** @neokai/ui and the web app use incompatible token systems. Without unification, adopting @neokai/ui in the web app requires duplicating or translating tokens.

**Approach:**
1. Define a canonical set of CSS custom properties in a shared location (e.g., `packages/ui/src/tokens.css` or a new `@neokai/tokens` package)
2. Map the web app's `design-tokens.ts` constants to CSS custom properties
3. Consume the shared tokens in both @neokai/ui's demo and the web app
4. Adopt the Catalyst CSS custom property per-component pattern for the styled layer

**Estimated effort:** 1-2 sessions.

#### R3. Add Toast Variant Types to @neokai/ui

**Why:** The web app's ToastItem has success/error/warning/info variants with distinct colors, icons, and progress bars. @neokai/ui's Toast is variant-agnostic. The Tailwind v4 reference's notification examples (6 files) all use typed variants.

**Approach:**
1. Add a `variant` field to `ToastOptions`: `'info' | 'success' | 'warning' | 'error'`
2. Add an `icon` slot to Toast (rendered via a named slot or a render prop)
3. Add optional progress bar support (controlled via `showProgress` boolean)
4. These additions are backward-compatible -- existing consumers without variants continue to work

**Estimated effort:** 1 session.

### MEDIUM IMPACT

#### R4. Create a Styled Component Layer

**Why:** @neokai/ui is purely headless -- every consumer must write their own Tailwind classes. This creates inconsistency and slows development. The Catalyst UI Kit demonstrates the pattern: styled wrappers that compose headless primitives with pre-defined design tokens.

**Approach:**
1. Create a `packages/ui/src/styled/` directory
2. Build styled wrappers for the most-used components: Button, Dialog (Modal), Menu (Dropdown), Tooltip, Toast
3. Use CSS custom properties per component (Catalyst pattern): `--btn-bg`, `--btn-border`, `--dialog-bg`, etc.
4. Export both headless and styled versions from `mod.ts`
5. The styled layer should support `className` overrides for customization

**Estimated effort:** 2-3 sessions.

#### R5. Add Headless Primitives for Missing Interactive Patterns

**Why:** Some patterns in the Tailwind v4 reference require state management or keyboard navigation that plain HTML does not provide.

**Components to add:**
- **Alert**: `role="alert"`, dismissible state, icon slot, accent border variant. 6 reference examples.
- **Progress**: `role="progressbar"`, `value`/`max` props, `indeterminate` state, animation support. 8 reference examples. This is the one "missing headless primitive" that genuinely needs to exist.
- **Badge**: Primarily visual, but a `data-variant` approach with removable variant would be useful. 18 reference examples.

**Estimated effort:** 2 sessions (1 for Progress, 1 for Alert + Badge).

#### R6. Adopt TouchTarget Pattern

**Why:** Catalyst's `TouchTarget` expands hit areas to 44x44px minimum on touch devices. This is an accessibility improvement per WCAG 2.2 Success Criterion 2.5.8. It is a simple, framework-agnostic pattern (a single `pointer-fine:hidden` span).

**Approach:**
1. Add a `TouchTarget` component to @neokai/ui (or as a utility in the styled layer)
2. Wrap it inside Button and IconButton by default in the styled layer
3. 10 lines of code, zero dependencies

**Estimated effort:** Minimal (part of R4).

### LOW IMPACT

#### R7. Create Composable Patterns (Not New Components)

**Why:** Several Tailwind v4 reference patterns can be composed from existing @neokai/ui primitives without creating new components.

**Patterns to document/create as recipes:**
- **Command Palette**: `Dialog` + `Combobox` + `Transition`. 9 reference examples.
- **Drawer/Slide-over**: `Dialog` + `DialogPanel` with `data-closed:translate-x-full` transition. 9 reference examples.
- **Notification with actions**: `Toast` + `ToastAction` + variant styling. 6 reference examples.

**Approach:** Create example files in the @neokai/ui demo app showing these compositions.

**Estimated effort:** 1 session.

#### R8. Add Missing Styled Layout Components

**Why:** The web app likely implements layout patterns inline. Creating reusable styled layout components would improve consistency.

**Components to consider** (all purely styled, no headless behavior needed):
- Divider (8 reference examples)
- Breadcrumb (6 reference examples)
- Pagination (3 reference examples)
- Empty State (6 reference examples)

**Estimated effort:** 1-2 sessions.

---

## 7. Appendix: Component Comparison Matrix

### @neokai/ui vs Tailwind v4 Reference vs Catalyst UI Kit

| Pattern | @neokai/ui | Tailwind v4 Reference | Catalyst | Web App |
|---|---|---|---|---|
| Button | Headless | 12 examples | Styled (solid/outline/plain + colors) | Styled |
| CloseButton | Headless | (part of Dialog) | (part of Dialog) | Inline SVG |
| Checkbox | Headless | 6 examples | Styled | None |
| Combobox | Headless | 8 examples | Styled | None |
| Dialog | Headless (full-featured) | 15 examples | Styled | Modal (basic) |
| Disclosure | Headless | None | None | Collapsible |
| Field/Label | Headless | (part of forms) | Fieldset | None |
| Input/Textarea/Select | Headless (native HTML) | 74 examples total | Styled | None |
| Listbox | Headless | None | Styled | None |
| Menu | Headless + @floating-ui | 9 dropdown examples | Dropdown | Dropdown (manual) |
| Popover | Headless + @floating-ui | None | None | None |
| Tooltip | Headless + @floating-ui | None | None | CSS-only |
| RadioGroup | Headless | 5 examples | Styled | None |
| Switch | Headless | 6 examples | Styled | None |
| Tabs | Headless | 4 examples | None | None |
| Transition | Headless (CSSTransition) | (used throughout) | (used throughout) | CSS animations |
| Toast | Headless + Toaster | 6 examples | None | Styled (typed variants) |
| IconButton | Headless | None | None | Styled |
| Skeleton | Headless | None | None | Styled |
| Spinner | Headless | None | None | Styled |
| Avatar | **Missing** | 11 examples | Styled | None |
| Badge | **Missing** | 18 examples | Styled | InboxBadge |
| Alert | **Missing** | 6 examples | Styled | None |
| Command Palette | **Missing** (composable) | 9 examples | None | None |
| Drawer | **Missing** (composable) | 9 examples | None | None |
| Progress | **Missing** | 8 examples | None | CircularProgressIndicator |
| Table | N/A (HTML) | 19 examples | Styled | None |
| Description List | N/A (HTML) | 8 examples | Styled | None |
| Divider | N/A (HTML) | 8 examples | Styled | None |
| Pagination | N/A (HTML) | 3 examples | Styled | None |
| Breadcrumb | N/A (HTML) | 6 examples | None | None |
| Sidebar Layout | N/A (CSS) | 23 examples | Styled | NavRail |
| App Shell | N/A (CSS) | 23 examples | SidebarLayout/StackedLayout | None |

### Data Attribute Coverage

| Attribute | @neokai/ui | Headless UI v2 Reference | Notes |
|---|---|---|---|
| `data-hover` | Yes | Yes | |
| `data-focus` | Yes | Yes | |
| `data-active` | Yes | Yes | |
| `data-open` | Yes | Yes | |
| `data-closed` | Yes | Yes | |
| `data-disabled` | Yes | Yes | |
| `data-selected` | Yes | Yes | |
| `data-enter` | Yes | Yes | |
| `data-leave` | Yes | Yes | |
| `data-transition` | Yes (custom) | Not in current docs | @neokai/ui sets `data-transition` whenever `data-enter` OR `data-leave` is active. This is a convenience attribute not documented in Headless UI v2.2.x. |
