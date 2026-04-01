# Plan: Replace global iteration counter with per-channel cycle tracking

## Context

The workflow engine has a single `iterationCount` / `maxIterations` on each workflow run. Every backward (cyclic) channel increments the same counter, so independent loops (e.g. plan-review vs code-review vs QA) compete for the same budget. Additionally, `isCyclic` is stored on channels but is fully derivable from graph topology — the editor already infers it. This change removes the stored flag and the global counter, replacing them with per-channel cycle counts.

## Changes

### 1. Extract cyclicity inference to shared package

**New file:** `packages/shared/src/lib/workflow-graph.ts`

Port `inferChannelIsCyclic`, `doesPathExistBetweenNodes`, `resolveChannelTargetNodeIds` from `VisualWorkflowEditor.tsx` (lines 145-219) into shared pure functions:
- `isChannelCyclic(channelIndex, channels, nodes)` — determines if a channel closes a loop
- `getCyclicChannelIndexes(channels, nodes): Set<number>` — convenience wrapper

Uses node array position as topological order (same convention the editor uses).

**Update:** `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx` — replace local functions with shared imports.

### 2. Type changes in `packages/shared/src/types/space.ts`

| Type | Remove | Add |
|------|--------|-----|
| `WorkflowChannel` | `isCyclic?: boolean` | `maxCycles?: number` |
| `Channel` | `isCyclic?: boolean` | `maxCycles?: number` |
| `ExportedWorkflowChannel` | `isCyclic?: boolean` | `maxCycles?: number` |
| `SpaceWorkflow` | `maxIterations?: number` | — |
| `SpaceWorkflowRun` | `iterationCount`, `maxIterations` | — |
| `CreateSpaceWorkflowParams` | `maxIterations?: number` | — |
| `UpdateSpaceWorkflowParams` | `maxIterations?: number \| null` | — |
| `CreateWorkflowRunParams` | `maxIterations?: number` | — |
| `ResolvedChannel` (space-utils.ts) | `isCyclic?: boolean` | — |

Keep `WorkflowRunFailureReason.maxIterationsReached` — still valid, error detail will name the specific channel.

### 3. DB migration 69

**File:** `packages/daemon/src/storage/schema/migrations.ts`

```sql
CREATE TABLE IF NOT EXISTS channel_cycles (
  run_id TEXT NOT NULL,
  channel_index INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  max_cycles INTEGER NOT NULL DEFAULT 5,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, channel_index),
  FOREIGN KEY (run_id) REFERENCES space_workflow_runs(id) ON DELETE CASCADE
);
```

Dead columns (`iteration_count`, `max_iterations`) left in place — SQLite column drops are expensive.

### 4. New repository: `packages/daemon/src/storage/repositories/channel-cycle-repository.ts`

Methods: `get`, `getAllForRun`, `incrementCycleCount` (atomic UPSERT with cap guard), `reset`.

### 5. Runtime: `packages/daemon/src/lib/space/runtime/channel-router.ts`

- Add `channelCycleRepo` to `ChannelRouterConfig`
- Change `findMatchingWorkflowChannel` to also return channel index
- In `canDeliver()` and `deliverMessage()`: replace `channel.isCyclic` + `run.iterationCount` checks with topology inference + per-channel count from `channelCycleRepo`
- Replace `incrementAndResetCyclicGates()` with `incrementAndResetCyclicChannel(runId, channelIndex, maxCycles, workflow)` — increments per-channel count, resets `resetOnCycle` gates, all in one transaction

### 6. Runtime: `packages/daemon/src/lib/space/runtime/space-runtime.ts`

Remove `maxIterations` propagation from workflow to run creation.

### 7. Visual editor

- `ChannelEdgeConfigPanel.tsx`: Remove "Mark as cyclic" checkbox. Add `maxCycles` number input (shown only when channel is inferred cyclic).
- `VisualWorkflowEditor.tsx`: Stop setting `channel.isCyclic`. Set `channel.maxCycles = 5` as default for inferred-cyclic channels.
- `semanticWorkflowGraph.ts`: Compute `hasCyclic` from shared inference function instead of `channel.isCyclic`.
- `EdgeRenderer.tsx`: No change — receives `isCyclic` as computed prop from parent.

### 8. Built-in workflows: `packages/daemon/src/lib/space/workflows/built-in-workflows.ts`

- Remove `maxIterations` from workflow templates
- Remove `isCyclic: true` from channel definitions
- Add `maxCycles` to backward channels (3 for simple workflow, 5 for V2)

### 9. Export/import: `packages/daemon/src/lib/space/export-format.ts`

- Remove `isCyclic` from Zod schema and serialization
- Add `maxCycles` to schema and serialization

### 10. Repository cleanup

- `space-workflow-run-repository.ts`: Remove `incrementIterationCount()`, stop mapping `iterationCount`/`maxIterations` to run objects
- `space-workflow-repository.ts`: Remove `maxIterations` from create/update/read

## Commit sequence

1. Extract cyclicity inference to shared + update editor imports
2. Types + migration 69 + ChannelCycleRepository
3. Runtime changes (channel-router, space-runtime)
4. Visual editor UI (remove checkbox, add maxCycles)
5. Built-in workflows + export/import + agent tools
6. Test updates

## Verification

```bash
bun run typecheck                    # Type-safe after all changes
make test-daemon                     # channel-router, space-runtime, migration, repository tests
make test-web                        # visual editor, serialization tests
make run-e2e TEST=tests/features/space-workflow-editor.e2e.ts  # if exists
```
