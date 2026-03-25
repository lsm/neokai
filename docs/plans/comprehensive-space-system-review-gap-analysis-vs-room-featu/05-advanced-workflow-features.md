# M5: Advanced Workflow Features

> **Design revalidation notice:** Before implementing any task, revalidate file paths, function signatures, and integration points against the current codebase.

**Milestone goal:** After this milestone, workflows support versioning (safe editing during runs), a template gallery for sharing and discovering workflows, and dynamic reconfiguration (with safety guards).

**Scope:** Workflow versioning, template gallery, and dynamic reconfiguration.

**Note:** Task 5.2 (Cron Scheduling) and Task 5.3 (Goal/Mission Integration) have been moved to the appendix. Cron scheduling is a Room cron-utils port, and goal integration requires bridging to the Room GoalManager -- neither is a prerequisite for the core workflow execution vision.

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

## Task 5.2: Template Gallery

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

## Task 5.3: Dynamic Reconfiguration During Execution

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
