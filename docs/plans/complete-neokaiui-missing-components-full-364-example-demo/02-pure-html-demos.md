# Milestone 2: Pure HTML Demos

## Goal

Port all ~163 reference files that have zero external dependencies (no headlessui, no heroicons) into demo section files. These are pure Tailwind CSS markup -- the fastest and least complex batch.

## Scope

- 20 subcategories across 7 top-level categories
- ~163 reference JSX files total
- Each subcategory becomes one demo section file

## Porting Checklist (per file)

For every reference file, the coder must:
1. Convert `className` to `class`
2. Remove `'use client'` directive (React-specific)
3. Convert `import { useState } from 'react'` to `import { useState } from 'preact/hooks'` (if present)
4. Convert unbracketed data attribute variants (`data-closed:`, `data-focus:`, etc.) to bracketed form (`data-[closed]:`, `data-[focus]:`, etc.)
5. Wrap each example in a `<div class="space-y-4">` or similar container with a label/title
6. Ensure all examples in a subcategory are rendered within the single demo component

## Tasks

### Task 2.1: Pure HTML demos -- Elements, Headings, Layout (75 files)

**Description**: Port all pure-HTML reference files from the elements, headings, and layout categories.

**Subtasks**:

1. **Create `elements/avatars/AvatarsDemo.tsx`** (11 files): Circular/rounded avatars, with notifications (top/bottom), with placeholder icon/initials, avatar groups, with text.

2. **Create `elements/badges/BadgesDemo.tsx`** (18 files): With border, with dot, pill variants, flat variants, with remove button, small variants.

3. **Create `elements/buttons/ButtonsDemo.tsx`** (5 files): Primary, secondary, soft, rounded primary, rounded secondary. Note: some button files are in the icon-only or headless batches; only port the 5 pure-HTML ones.

4. **Create `elements/button-groups/ButtonGroupsDemo.tsx`** (1 file): Basic button group. Note: only 1 of 5 button-group files is pure HTML.

5. **Create `headings/card-headings/CardHeadingsDemo.tsx`** (4 files): Simple, with action, with description and action, with description.

6. **Create `headings/page-headings/PageHeadingsDemo.tsx`** (3 files): With actions, with avatar and actions, card with avatar and stats.

7. **Create `headings/section-headings/SectionHeadingsDemo.tsx`** (5 files): Simple, with description, with actions, with action, with inline tabs, with label.

8. **Create `layout/cards/CardsDemo.tsx`** (10 files): Basic card, edge-to-edge on mobile, with header, with footer, with header and footer, gray footer, gray body, well variants.

9. **Create `layout/containers/ContainersDemo.tsx`** (5 files): Full-width on mobile constrained, constrained with padded content, narrow constrained.

10. **Create `layout/dividers/DividersDemo.tsx`** (3 files): With label, with label on left, with title, with title on left. Note: some divider files are in the icon-only batch.

11. **Create `layout/list-containers/ListContainersDemo.tsx`** (7 files): Simple with dividers, card with dividers, separate cards, flat card, full-width on mobile variants.

12. **Create `layout/media-objects/MediaObjectsDemo.tsx`** (8 files): Basic, aligned to center/bottom, stretched, media on right, responsive variants, nested.

13. **Update `packages/ui/demo/App.tsx`** to import and render all new demo sections in the "Application UI > Elements", "Application UI > Headings", and "Application UI > Layout" sidebar categories.

**Acceptance criteria**:
- 12 new demo section files created
- All 75 reference examples render in the demo app
- No `className`, no `'use client'`, no `from 'react'` in any file
- All data attribute variants use bracketed form
- Sidebar navigation shows new sections under correct categories
- `bun run dev` starts without errors

**Depends on**: Task 1.2 (categorized sidebar must exist)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.2: Pure HTML demos -- Forms (67 files)

**Description**: Port all pure-HTML reference files from the forms category. This is the largest pure-HTML batch.

**Subtasks**:

1. **Create `forms/action-panels/ActionPanelsDemo.tsx`** (8 files): Simple, with link, with button on right, with button at top right, with toggle, with input, simple well, with well.

2. **Create `forms/checkboxes/CheckboxesDemo.tsx`** (4 files): List with description, inline description, checkbox on right, simple list with heading.

3. **Create `forms/input-groups/InputGroupsDemo.tsx`** (13 files): Input with label, with label and help text, disabled state, hidden label, corner hint, with add-on, inline add-on, inline leading and trailing add-ons, inset label, overlapping label, pill shape, gray background, keyboard shortcut. Note: some input-group files are in icon-only or headless batches.

4. **Create `forms/radio-groups/RadioGroupsDemo.tsx`** (12 files): Simple list, inline list, with description, inline description, radio on right, simple table, descriptions in panel, color picker, small cards, stacked cards.

5. **Create `forms/sign-in-forms/SignInFormsDemo.tsx`** (4 files): Simple, simple no labels, split screen, simple card.

6. **Create `forms/textareas/TextareasDemo.tsx`** (1 file): Simple. Note: most textarea files are in icon/headless batches.

7. **Create `forms/toggles/TogglesDemo.tsx`** (5 files): Simple toggle, short toggle, with icon, with left label and description, with right label.

8. **Update `packages/ui/demo/App.tsx`** to import and render all new demo sections in the "Application UI > Forms" sidebar category.

**Acceptance criteria**:
- 7 new demo section files created
- All 47 reference examples render in the demo app (some input-group files deferred to icon-only batch)
- No `className`, no `'use client'`, no `from 'react'` in any file
- All data attribute variants use bracketed form
- Sidebar navigation shows new sections under Forms category
- `bun run dev` starts without errors

**Depends on**: Task 1.2 (categorized sidebar must exist)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.3: Pure HTML demos -- Data Display, Lists, Navigation, Feedback (41 files)

**Description**: Port all remaining pure-HTML reference files from data-display, lists, navigation, and feedback categories.

**Subtasks**:

1. **Create `data-display/stats/StatsDemo.tsx`** (3 files): With trending, simple, simple in cards. Note: 2 stats files are in the icon-only batch.

2. **Create `lists/grid-lists/GridListsDemo.tsx`** (2 files): Horizontal link cards, images with details. Note: most grid-list files are in icon/headless batches.

3. **Create `lists/stacked-lists/StackedListsDemo.tsx`** (6 files): Simple, narrow, narrow with sticky headings, narrow with actions, narrow with truncated content, narrow with small avatars. Note: many stacked-list files are in icon/headless batches.

4. **Create `lists/tables/TablesDemo.tsx`** (18 files): Simple, simple in card, full-width, striped rows, uppercase headings, stacked columns on mobile, hidden columns, avatars with multiline content, sticky header, vertical lines, condensed, grouped rows, summary rows, with border, with checkboxes, full-width with avatars. Note: 2 table files are in icon-only batch.

5. **Create `navigation/pagination/PaginationDemo.tsx`** (1 file): Simple card footer. Note: 2 pagination files are in icon-only batch.

6. **Create `navigation/progress-bars/ProgressBarsDemo.tsx`** (4 files): Simple, bullets, progress bar. Note: 5 progress-bar files are in icon-only batch.

7. **Create `navigation/vertical-navigation/VerticalNavigationDemo.tsx`** (2 files): Simple, with badges. Note: 4 vertical-navigation files are in icon-only batch.

8. **Create `feedback/empty-states/EmptyStatesDemo.tsx`** (1 file): With dashed border. Note: 5 empty-state files are in icon-only batch.

9. **Update `packages/ui/demo/App.tsx`** to import and render all new demo sections.

**Acceptance criteria**:
- 8 new demo section files created
- All ~37 reference examples render in the demo app
- No `className`, no `'use client'`, no `from 'react'` in any file
- All data attribute variants use bracketed form
- Sidebar navigation shows new sections under correct categories
- `bun run dev` starts without errors

**Depends on**: Task 1.2 (categorized sidebar must exist)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
