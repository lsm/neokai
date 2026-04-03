# Milestone 1: Foundation

## Goal

Set up the infrastructure needed for all subsequent demo porting work: fix missing package exports, install the icon library, create the heroicons-to-lucide name mapping, and refactor the demo App.tsx to support a categorized sidebar with 49 sections.

## Scope

- Fix `packages/ui/package.json` exports for 7 components missing from the exports map
- Install `lucide-preact` as a devDependency
- Create heroicons-to-lucide icon name mapping utility
- Refactor `packages/ui/demo/App.tsx` to support categorized sidebar navigation

## Tasks

### Task 1.1: Fix package.json exports and install lucide-preact

**Description**: Update `packages/ui/package.json` to add missing exports for components that exist in `src/mod.ts` but are not in the `exports` map. Install `lucide-preact` as a devDependency.

**Subtasks**:
1. Compare `src/mod.ts` exports with `package.json` exports field. Missing entries:
   - `"./alert"` -> `./src/components/alert/alert.tsx`
   - `"./avatar"` -> `./src/components/avatar/avatar.tsx`
   - `"./badge"` -> `./src/components/badge/badge.tsx`
   - `"./input-group"` -> `./src/components/input-group/input-group.tsx`
   - `"./progress-bar"` -> `./src/components/progress-bar/progress-bar.tsx`
   - `"./stepper"` -> `./src/components/stepper/stepper.tsx`
   - `"./touch-target"` -> `./src/components/touch-target/touch-target.tsx`
2. Run `bun add -D lucide-preact@0.577.0` in the `packages/ui` directory
3. Verify the demo dev server still starts (`bun run dev`)

**Acceptance criteria**:
- All 26 component groups from `src/mod.ts` have corresponding entries in `package.json` exports
- `lucide-preact` is listed in devDependencies
- `bun run dev` starts without errors
- `bun run test` still passes

**Depends on**: Nothing

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 1.2: Create heroicons-to-lucide icon name mapping and refactor demo App.tsx sidebar

**Description**: Create a mapping utility that translates heroicon component names to lucide-preact icon names. Then refactor `packages/ui/demo/App.tsx` to support a categorized sidebar with 11 categories and 49 sections, replacing the current flat list.

**Subtasks**:

1. **Create icon mapping file** at `packages/ui/demo/icon-map.ts`:
   - Export a `Record<string, string>` mapping heroicon names to lucide names
   - Map all 66 unique heroicon names found in the 364 reference files (plus any aliases)
   - Key naming convention: heroicon `ChevronDownIcon` maps to lucide `ChevronDown`, `XMarkIcon` maps to `X`, `Bars3Icon` maps to `Menu`, `MagnifyingGlassIcon` maps to `Search`
   - Size variants (16/solid, 20/solid, 24/outline, 24/solid) are NOT needed in the mapping -- lucide icons are size-agnostic via `class="w-N h-N"` and always use the same stroke style

2. **Refactor demo App.tsx sidebar**:
   - Define a categorized section structure with 11 categories matching the reference taxonomy:
     ```
     Application Shells (multi-column, sidebar, stacked)
     Data Display (calendars, description-lists, stats)
     Elements (avatars, badges, button-groups, buttons, dropdowns)
     Feedback (alerts, empty-states)
     Forms (action-panels, checkboxes, comboboxes, form-layouts, input-groups, radio-groups, select-menus, sign-in-forms, textareas, toggles)
     Headings (card-headings, page-headings, section-headings)
     Layout (cards, containers, dividers, list-containers, media-objects)
     Lists (feeds, grid-lists, stacked-lists, tables)
     Navigation (breadcrumbs, command-palettes, navbars, pagination, progress-bars, sidebar-navigation, tabs, vertical-navigation)
     Overlays (drawers, modal-dialogs, notifications)
     Page Examples (detail-screens, home-screens, settings-screens)
     ```
   - Keep the existing 22 "Component" sections in a top-level category
   - Add a new "Application UI" category with the 49 subcategories (initially empty/placeholder)
   - Implement collapsible category headers in the sidebar
   - Use the lucide-preact `ChevronDown` / `ChevronRight` icons for collapse/expand toggles
   - Replace the inline `SunIcon` / `MoonIcon` SVGs with lucide `Sun` / `Moon` icons
   - Keep all existing demo sections functional (no regressions)

3. **Update demo/styles.css** if needed:
   - Add any CSS custom properties needed for the expanded sidebar
   - Consider widening the sidebar from `w-56` to `w-64` to accommodate category nesting

**Acceptance criteria**:
- `packages/ui/demo/icon-map.ts` exports a mapping for all 66 heroicon names (plus any aliases)
- App.tsx sidebar shows categories with collapsible sections
- All 22 existing demo sections still render correctly
- Theme toggle (dark/light) still works
- Inline SVGs for Sun/Moon replaced with lucide imports
- `bun run dev` starts and sidebar navigation works

**Depends on**: Task 1.1 (lucide-preact must be installed)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
