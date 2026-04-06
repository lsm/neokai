# Milestone 4: Code-Splitting with Lazy/Suspense

## Goal

Lazy-load the three heaviest tab components (GoalsEditor, RoomAgents, RoomSettings) so they are only downloaded when the user navigates to their respective tabs.

## Scope

Primary files: `packages/web/src/islands/Room.tsx`, `packages/web/src/components/room/index.ts` (barrel export).

---

### Task 7: Add lazy loading for GoalsEditor, RoomAgents, and RoomSettings

**Description:** Use Preact's `lazy()` and `Suspense` to code-split GoalsEditor (~2065 lines), RoomAgents (~1093 lines), and RoomSettings (~772 lines) into separate chunks that load on demand.

**Subtasks:**

1. In Room.tsx, add imports:
   ```ts
   import { lazy, Suspense } from 'preact/compat';
   ```

2. Replace the static imports of `GoalsEditor`, `RoomAgents`, and `RoomSettings` with lazy imports:
   ```ts
   const GoalsEditor = lazy(() => import('../components/room/GoalsEditor').then(m => ({ default: m.GoalsEditor })));
   const RoomAgents = lazy(() => import('../components/room/RoomAgents').then(m => ({ default: m.RoomAgents })));
   const RoomSettings = lazy(() => import('../components/room/RoomSettings').then(m => ({ default: m.RoomSettings })));
   ```
   Note: The `.then(m => ({ default: m.GoalsEditor }))` wrapper is **required** — all three components use named exports (`export function GoalsEditor`, `export function RoomAgents`, `export function RoomSettings`), not default exports.

3. Remove the `GoalsEditor`, `RoomSettings`, `RoomAgents` imports from the barrel import (`from '../components/room'`). The `CreateGoalFormData` type import from GoalsEditor needs to remain -- use a separate type-only import:
   ```ts
   import type { CreateGoalFormData } from '../components/room/GoalsEditor';
   ```

4. **Update the barrel export** in `packages/web/src/components/room/index.ts`. Remove the re-exports for `GoalsEditor`, `RoomAgents`, and `RoomSettings` from the barrel. If any other consumer imports them via the barrel (check with `grep -r "from.*components/room'" packages/web/src/ --include='*.ts' --include='*.tsx'`), update those imports to use direct file paths instead. If the barrel re-exports remain, other consumers will bypass the lazy boundary and cause these modules to be bundled eagerly, defeating the purpose of code splitting.

5. Wrap each lazy component's rendering in a `<Suspense>` boundary with a simple loading fallback:
   ```tsx
   {activeTab === 'goals' && (
     <div class="h-full overflow-y-auto">
       <Suspense fallback={<div class="flex items-center justify-center h-32"><Skeleton width="200px" height={24} /></div>}>
         <GoalsEditor ... />
       </Suspense>
     </div>
   )}
   ```
   Apply the same pattern for `RoomAgents` and `RoomSettings`.

6. Keep `RoomDashboard` and `RoomTasks` eagerly loaded -- they are the primary entry points (overview and tasks tabs) and should be instantly available.

7. Verify the Vite build produces separate chunks for the lazy components:
   - Run `cd packages/web && bunx vite build` (or `make build`)
   - Check the output for separate chunk files corresponding to GoalsEditor, RoomAgents, RoomSettings
   - **Note:** Vite/Rollup may merge small chunks depending on its chunk strategy. If separate chunks are not visible, verify via the build output that dynamic imports are present, or check that the main bundle size decreased.

8. Verify that the lazy components load correctly in development mode (`make dev`) by navigating to each tab and confirming the component renders after a brief loading state.

9. Update Room.test.tsx if needed -- lazy components in tests may need a wrapping `<Suspense>` in the test render, or the test can mock the lazy imports.

**Acceptance Criteria:**

- GoalsEditor, RoomAgents, and RoomSettings are loaded on demand (not included in the main bundle)
- Vite build output shows separate chunks for these components
- Navigating to goals/agents/settings tabs shows a brief loading skeleton then renders the component
- RoomDashboard and RoomTasks render instantly without Suspense
- No flash of content or layout shift when lazy components load
- `cd packages/web && bunx vitest run src/islands/__tests__/Room.test.tsx` passes
- `make build` succeeds without errors
- E2E test added or existing navigation E2E tests verified to pass with new URL structure (run via `make run-e2e TEST=tests/core/navigation-3-column.e2e.ts` or equivalent)

**Dependencies:** Task 3 (Room.tsx must be refactored to signal-driven tabs first, otherwise the lazy/Suspense additions will conflict with the useState refactor)

**Agent type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
