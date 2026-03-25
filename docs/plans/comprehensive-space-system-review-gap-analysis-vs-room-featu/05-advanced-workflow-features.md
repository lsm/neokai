# M5: Advanced Workflow Features

> **Design revalidation notice:** Before implementing any task, revalidate file paths, function signatures, and integration points against the current codebase.

**Milestone goal:** After this milestone, workflows support versioning, cron-based recurring execution, goal/mission integration, and a template gallery. These features make the workflow system powerful enough for production use.

**Scope:** Workflow versioning, cron scheduling, goal integration, template gallery, and dynamic reconfiguration.

---

## Task 5.1: Workflow Versioning

**Priority:** P2
**Agent type:** coder
**Depends on:** Milestones 2 and 4 (reliability and interaction should be stable)

### Description

Add versioning to workflow definitions so that editing a workflow does not break in-progress runs. Each edit creates a new version, and runs are bound to the version that was active when they started.

### Subtasks

1. Add a `version` column to `space_workflows` (integer, auto-incremented on update).
2. Modify `SpaceWorkflowRepository.updateWorkflow()` to:
   - Increment `version` on every update.
   - Store the previous version in a `space_workflow_versions` history table (snapshot of the full workflow definition).
3. Add a `version` column to `space_workflow_runs` -- set to the workflow's current version when the run is created.
4. Modify `WorkflowExecutor` to use the run's `version` to look up the correct workflow definition (instead of always using the latest).
5. Add a `spaceWorkflow.listVersions` RPC handler and a "Version History" panel in the frontend.

### Files to modify/create

- `packages/shared/src/types/space.ts` -- Add version to SpaceWorkflow and SpaceWorkflowRun
- `packages/daemon/src/storage/schema/migrations.ts` -- Add version columns + history table
- `packages/daemon/src/storage/repositories/space-workflow-repository.ts` -- Version management
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Use versioned workflow definition
- `packages/daemon/src/lib/rpc-handlers/space-workflow-handlers.ts` -- Add listVersions handler

### Implementation approach

On each `updateWorkflow()` call, snapshot the current state to `space_workflow_versions` before applying changes. The `SpaceRuntime.startWorkflowRun()` captures the workflow's current version and stores it on the run. The `WorkflowExecutor` constructor receives the exact version of the workflow that was active at run start -- no dynamic lookup.

### Edge cases

- A run references a version that was deleted from history -- fall back to the latest version with a warning.
- Rapid successive edits (10+ versions in a minute) -- history table grows but is bounded (add TTL cleanup).
- Rollback to a previous version -- create a new version with the old snapshot's content (not an in-place update).

### Testing

- Unit test: Update increments version.
- Unit test: History table stores snapshot.
- Unit test: Run uses the correct version (not latest).
- Unit test: Rollback creates a new version from snapshot.

### Acceptance criteria

- [ ] Workflow version auto-increments on update
- [ ] History table stores full snapshots
- [ ] Runs are bound to the version active at creation time
- [ ] Editing a workflow does not break in-progress runs
- [ ] Version history is viewable in the UI
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 5.2: Cron Scheduling for Recurring Workflows

**Priority:** P2
**Agent type:** coder
**Depends on:** Task 2.3 (reliable tick loop), Task 5.1 (versioning for consistent execution)

### Description

Add the ability to schedule workflow runs on a cron schedule. This enables recurring workflows like "run test suite every morning" or "scan for vulnerabilities every Friday."

### Subtasks

1. Add a `schedule` field to `SpaceWorkflow` (or a separate `space_workflow_schedule` table): `{ expression: string, timezone: string, enabled: boolean }`.
2. Create `packages/daemon/src/lib/space/runtime/workflow-scheduler.ts`:
   - Resolves cron expressions to next run times.
   - Maintains a `Map<workflowId, nextRunAt>` for active schedules.
   - On each tick, check if any schedule's `nextRunAt` has passed. If so, start a new workflow run via `startWorkflowRun()`.
   - Skip if the previous run is still in_progress (no concurrent runs for the same scheduled workflow).
3. Add `spaceWorkflow.setSchedule` and `spaceWorkflow.getSchedule` RPC handlers.
4. Add a "Schedule" section in the workflow editor UI.

### Files to modify/create

- `packages/daemon/src/lib/space/runtime/workflow-scheduler.ts` -- NEW
- `packages/shared/src/types/space.ts` -- Add Schedule type
- `packages/daemon/src/storage/schema/migrations.ts` -- Add schedule table/column
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Integrate scheduler into tick
- `packages/daemon/src/lib/rpc-handlers/space-workflow-handlers.ts` -- Add schedule handlers
- `packages/web/src/components/space/WorkflowEditor.tsx` -- Add schedule UI

### Implementation approach

Use the same cron infrastructure from Room's goal system (`packages/daemon/src/lib/room/runtime/cron-utils.ts`) if applicable. The scheduler is checked on every tick (5s granularity is sufficient for minute-level cron schedules). Store `nextRunAt` in the schedule config so it persists across restarts.

### Edge cases

- Multiple schedules firing at the same tick -- process in order of workflow ID.
- Schedule fires while the previous run is still active -- skip and log.
- Daemon restart with missed schedule -- on startup, check all schedules and fire any that are overdue (within a configurable catch-up window).
- Schedule with very frequent expression (every minute) -- cap the minimum interval to prevent API abuse.

### Testing

- Unit test: Cron expression resolves to correct next run time.
- Unit test: Scheduler fires on tick when nextRunAt has passed.
- Unit test: Scheduler skips when previous run is still active.
- Unit test: Catch-up fires missed schedules on startup.
- Integration test: Scheduled workflow creates runs at expected times.

### Acceptance criteria

- [ ] Cron expression resolves to correct next run time
- [ ] Scheduler creates workflow runs on schedule
- [ ] Active run blocks concurrent scheduled run
- [ ] Missed schedules are caught up on restart
- [ ] Minimum interval cap prevents API abuse
- [ ] Schedule UI in workflow editor works
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 5.3: Goal/Mission Integration for Workflows

**Priority:** P2
**Agent type:** coder
**Depends on:** Task 5.2 (scheduling)

### Description

Wire up the existing `goalId` field on `SpaceWorkflowRun` so that workflow completion updates mission metrics and recurring mission execution can trigger workflow runs.

### Subtasks

1. In `TaskAgentManager.handleSubSessionComplete()` and `report_result` tool handler:
   - When a workflow run completes (terminal step reached), if `run.goalId` is set:
     - Update the associated mission's metric if the workflow run produced a result.
     - Emit a `space.mission.progress` event.
2. In `SpaceRuntime.cleanupTerminalExecutors()`:
   - When a workflow run reaches `completed`, check if it has a `goalId`.
   - If so, record the run result as a mission execution.
3. In the workflow scheduler (Task 5.2):
   - For recurring missions, the schedule can trigger workflow runs.
   - When a scheduled run completes, update the mission's execution history.
4. Add `spaceWorkflowRun.listByGoal` RPC handler for the mission integration.

### Files to modify

- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` -- Report completion to mission
- `packages/daemon/src/lib/space/runtime/space-runtime.ts` -- Handle mission integration on completion
- `packages/daemon/src/lib/space/runtime/workflow-scheduler.ts` -- Trigger from mission schedule
- `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` -- Add listByGoal handler

### Implementation approach

The goal/mission system already exists in Room (`packages/daemon/src/lib/room/managers/goal-manager.ts`). The Space `goalId` field stores the same goal UUID. The integration is a cross-reference: when a workflow run completes, look up the mission by `goalId` and update its metrics. This does NOT require porting the Room goal system -- it only requires reading/writing the same `goals` table.

### Edge cases

- Workflow run with a `goalId` that references a Room goal (cross-system reference) -- skip silently.
- Mission deleted while workflow run is active -- the run completes normally, the mission update is a no-op.
- Multiple workflow runs for the same mission -- each run updates metrics independently (last-write-wins).

### Testing

- Unit test: Workflow completion with goalId updates mission metric.
- Unit test: Workflow completion without goalId does not affect missions.
- Unit test: Deleted mission does not break workflow completion.
- Integration test: Full flow -- mission created, workflow run associated, run completes, metric updated.

### Acceptance criteria

- [ ] Workflow run completion updates associated mission metrics
- [ ] Run without goalId does not affect missions
- [ ] Mission deletion does not break workflow runs
- [ ] `listByGoal` RPC handler returns runs for a mission
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 5.4: Template Gallery

**Priority:** P2
**Agent type:** coder
**Depends on:** nothing (but best after M1 is working)

### Description

Expand the built-in template system to support a user-facing template gallery. Users should be able to browse templates, preview them, and create workflows from templates without starting from scratch.

### Subtasks

1. Extend the export/import system to support a template format that can be imported as a new workflow:
   - Add a `spaceWorkflow.createFromTemplate` RPC handler that imports an `ExportedSpaceWorkflow` as a new workflow in the space.
   - The import should resolve agent names to SpaceAgent UUIDs in the target space.
2. Create a template gallery UI component:
   - Shows built-in templates (Coding, Research, Review-Only) with previews.
   - Shows "My Templates" -- workflows the user has explicitly exported.
   - "Use Template" button creates a new workflow from the selected template.
3. Add a "Save as Template" action in the workflow editor.

### Files to modify/create

- `packages/daemon/src/lib/rpc-handlers/space-export-import-handlers.ts` -- Add createFromTemplate
- `packages/web/src/components/space/WorkflowTemplateGallery.tsx` -- NEW
- `packages/web/src/components/space/WorkflowList.tsx` -- Add template gallery entry point

### Implementation approach

The export/import system already handles agent name resolution. `createFromTemplate` is essentially an import with the user selecting the target space. The built-in templates are already defined in `built-in-workflows.ts` -- expose them via a new RPC handler. The gallery UI is a simple list with previews.

### Edge cases

- Template references agents not present in the target space -- show a "Missing Agents" warning with options to create placeholders or skip.
- User edits a template after creating from it -- the workflow becomes independent (no link back to template).
- Template format version mismatch -- show a warning.

### Testing

- Unit test: `createFromTemplate` RPC creates a new workflow.
- Unit test: Agent name resolution works for template import.
- Component test: Gallery renders built-in templates.
- Component test: "Use Template" creates workflow and navigates to editor.

### Acceptance criteria

- [ ] Template gallery shows built-in and user templates
- [ ] "Use Template" creates a new workflow from template
- [ ] Agent name resolution works during import
- [ ] Missing agents show a warning
- [ ] "Save as Template" works from the workflow editor
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Task 5.5: Dynamic Reconfiguration During Execution

**Priority:** P3 (lowest priority)
**Agent type:** coder
**Depends on:** Task 5.1 (versioning)

### Description

Allow users to modify a workflow definition (add/remove nodes, change transitions, update conditions) while a run is in progress. With versioning in place (Task 5.1), this is safe: the in-progress run continues on its snapshot version, and new runs use the updated definition.

### Subtasks

1. Verify that the existing `spaceWorkflow.update` RPC handler works correctly when a run is in progress for the same workflow. With versioning, this should be safe.
2. Add a visual indicator in the workflow editor showing that a run is in progress:
   - "Run in progress" banner with the run's version number.
   - Warning that changes will not affect the current run.
3. Add a "Rebase Run" action that updates an in-progress run to use the latest workflow version (dangerous -- requires human confirmation).
4. Update the `spaceWorkflowRun.update` RPC handler to support rebasing: change the run's version to the latest and reset `currentNodeId` if the current node no longer exists.

### Files to modify

- `packages/web/src/components/space/visual-editor/VisualWorkflowEditor.tsx` -- Add "run in progress" indicator
- `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts` -- Add rebase action

### Implementation approach

With versioning (Task 5.1), dynamic reconfiguration is mostly automatic -- the user edits the workflow, a new version is created, and the existing run continues on its version. The "Rebase Run" action is the only new functionality needed. Rebase is dangerous: it changes the run's version and may invalidate the current node. Require explicit human confirmation.

### Edge cases

- Rebase when the current node was deleted in the new version -- cancel the run or move to the nearest valid node.
- Rebase during a cyclic iteration -- iteration count may be invalid.
- Multiple in-progress runs for the same workflow -- rebase affects all of them (or require individual selection).

### Testing

- Unit test: Updating a workflow during a run does not affect the run.
- Unit test: "Rebase Run" changes the run's version.
- Unit test: Rebase with deleted current node cancels or moves the run.
- Component test: "Run in progress" indicator shows during editing.

### Acceptance criteria

- [ ] Editing a workflow during a run does not affect the run
- [ ] "Run in progress" indicator shows in the editor
- [ ] "Rebase Run" action works with confirmation
- [ ] Rebase handles deleted current node gracefully
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
