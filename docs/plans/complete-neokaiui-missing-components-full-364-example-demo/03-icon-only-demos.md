# Milestone 3: Icon-Only Demos

## Goal

Port all ~93 reference files that use heroicons but NOT headlessui. These require the lucide-preact icon library and the heroicons-to-lucide name mapping from M1.

## Scope

- ~30 subcategories across 8 top-level categories
- ~93 reference JSX files
- Depends on `lucide-preact` being installed and `icon-map.ts` being available

## Porting Checklist (per file)

Everything from M2 checklist PLUS:
1. Replace `import { SomeIcon } from '@heroicons/react/24/outline'` with `import { SomeLucideIcon } from 'lucide-preact'`
2. Use the `icon-map.ts` mapping to translate heroicon names to lucide names
3. Adjust icon props: heroicons use `className` and sometimes `aria-hidden`, lucide uses `class` and passes through other SVG attributes. Use `class="w-5 h-5"` etc. for sizing.
4. Remove any `aria-hidden="true"` from icon usage (lucide handles this internally) or keep it if preferred for explicitness

## Tasks

### Task 3.1: Icon-only demos -- Elements, Feedback, Headings, Layout, Forms (41 files)

**Description**: Port icon-only reference files from elements, feedback, headings, layout, and forms categories.

**Subtasks**:

1. **Update `elements/buttons/ButtonsDemo.tsx`** -- add 4 icon-only button examples: buttons with leading icon, with trailing icon, circular buttons. (Already created in M2 with pure-HTML examples; extend it.)

2. **Update `elements/button-groups/ButtonGroupsDemo.tsx`** -- add 3 icon-only examples: icon-only button group, with stat, with checkbox and dropdown.

3. **Create `feedback/alerts/AlertsDemo.tsx`** (6 files): With description, with list, with actions, with link on right, with accent border, with dismiss button. Uses `ExclamationCircleIcon`, `ExclamationTriangleIcon`, `CheckCircleIcon`, `InformationCircleIcon`, `XMarkIcon`.

4. **Update `feedback/empty-states/EmptyStatesDemo.tsx`** -- add 5 icon-only examples: simple, with starting points, with recommendations, with templates, with recommendations grid. Uses various heroicons.

5. **Create `headings/card-headings/CardHeadingsWithIconsDemo.tsx`** or extend existing -- add 1 icon-only example: with avatar and actions.

6. **Create `headings/page-headings/PageHeadingsWithIconsDemo.tsx`** or extend existing -- add 3 icon-only examples: with actions and breadcrumbs, with banner image, with filters and action.

7. **Create `headings/section-headings/SectionHeadingsWithIconsDemo.tsx`** or extend existing -- add 3 icon-only examples: with input group, with tabs, with actions and tabs.

8. **Create `layout/dividers/DividersWithIconsDemo.tsx`** or extend existing -- add 4 icon-only examples: with icon, with button, with title and button, with toolbar.

9. **Create `forms/form-layouts/FormLayoutsDemo.tsx`** (5 files): Stacked, two-column, two-column with cards, labels on left. Uses `EnvelopeIcon`, `PhoneIcon`, `UserCircleIcon`.

10. **Update `forms/input-groups/InputGroupsDemo.tsx`** -- add 7 icon-only examples: with validation error, with leading icon, with trailing icon, with inline leading dropdown, with inline leading add-on and trailing dropdown, with leading icon and trailing button, inputs with shared borders. Uses `ExclamationCircleIcon`, `MagnifyingGlassIcon`, `CreditCardIcon`, `ChevronDownIcon`, `PlusIcon`.

11. **Update `forms/radio-groups/RadioGroupsDemo.tsx`** -- add 1 icon-only example: cards with icons.

12. **Create `forms/select-menus/SelectMenusDemo.tsx`** (1 file): Simple native select. Note: most select-menu files are in headless batches.

13. **Update `packages/ui/demo/App.tsx`** to register any new demo sections.

**Acceptance criteria**:
- All ~40 icon-only reference examples render correctly
- All heroicon imports replaced with lucide-preact imports
- Icon sizing preserved via `class="w-N h-N"` attributes
- No `@heroicons` imports remain in any file
- `bun run dev` starts without errors

**Depends on**: Task 1.2 (lucide-preact + icon-map.ts), Task 2.1 (existing demo files to extend)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 3.2: Icon-only demos -- Lists, Navigation, Data Display, Application Shells (52 files)

**Description**: Port icon-only reference files from lists, navigation, data-display, and application-shells categories.

**Subtasks**:

1. **Create `lists/feeds/FeedsDemo.tsx`** (2 files): Simple with icons, with multiple item types.

2. **Update `lists/grid-lists/GridListsDemo.tsx`** -- add 4 icon-only examples: contact cards with small portrait, contact cards, simple cards, actions with shared borders.

3. **Update `lists/stacked-lists/StackedListsDemo.tsx`** -- add 7 icon-only examples: with links, with inline links and avatar group, in card with links, two columns with links, full-width with links, full-width with constrained content, narrow with badges.

4. **Update `lists/tables/TablesDemo.tsx`** -- add 2 icon-only examples: with sortable headings, with hidden headings.

5. **Create `navigation/breadcrumbs/BreadcrumbsDemo.tsx`** (4 files): Contained, full-width bar, simple with chevrons, simple with slashes. Uses `ChevronRightIcon`, `HomeIcon`.

6. **Update `navigation/pagination/PaginationDemo.tsx`** -- add 2 icon-only examples: card footer with page buttons, centered page numbers. Uses `ChevronLeftIcon`, `ChevronRightIcon`.

7. **Update `navigation/progress-bars/ProgressBarsDemo.tsx`** -- add 5 icon-only examples: panels, panels with border, circles, bullets and text, circles with text.

8. **Create `navigation/sidebar-navigation/SidebarNavigationDemo.tsx`** (3 files): Light, dark, brand. Uses various heroicons.

9. **Create `navigation/tabs/TabsDemo.tsx`** (9 files): Tabs with underline, with underline and icons, in pills, in pills on gray, in pills with brand color, full-width with underline, bar with underline, with underline and badges, simple. Uses `UserCircleIcon`, `UserGroupIcon`, `FolderIcon`, `CalendarDaysIcon`, `DocumentDuplicateIcon`, `Cog6ToothIcon`.

10. **Update `navigation/vertical-navigation/VerticalNavigationDemo.tsx`** -- add 4 icon-only examples: with icons and badges, with icons, with secondary navigation, on gray.

11. **Create `data-display/calendars/CalendarsDemo.tsx`** (1 icon-only file): Double calendar. Note: most calendar files are in the headless batch.

12. **Create `data-display/description-lists/DescriptionListsDemo.tsx`** (6 files): Left aligned, left aligned in card, left aligned striped, two-column, left aligned with inline actions, narrow with hidden labels.

13. **Update `data-display/stats/StatsDemo.tsx`** -- add 2 icon-only examples: with brand icon, with shared borders.

14. **Create `application-shells/multi-column/MultiColumnDemo.tsx`** (2 icon-only files): Constrained three column, constrained with sticky columns.

15. **Update `packages/ui/demo/App.tsx`** to register all new demo sections.

**Acceptance criteria**:
- All ~52 icon-only reference examples render correctly
- All heroicon imports replaced with lucide-preact imports
- Icon sizing preserved via `class="w-N h-N"` attributes
- No `@heroicons` imports remain in any file
- `bun run dev` starts without errors

**Depends on**: Task 1.2 (lucide-preact + icon-map.ts), Task 2.3 (existing demo files to extend)

**Agent type**: coder

**Note**: Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
