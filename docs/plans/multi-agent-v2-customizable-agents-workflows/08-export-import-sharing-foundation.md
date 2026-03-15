# Milestone 8: Data Layer -- Export/Import & Sharing Foundation

## Goal

Implement export and import of custom agent definitions and workflow configurations as JSON. This creates a pure data layer that enables sharing between rooms and across installations, laying the groundwork for a future marketplace.

## Scope

- JSON export format for agents and workflows
- Import with validation and conflict resolution
- RPC handlers for export/import
- Frontend UI for export/import actions
- Unit tests

---

### Task 8.1: Define Export/Import JSON Format

**Agent:** coder
**Priority:** normal
**Depends on:** Task 1.3, Task 3.3

**Description:**

Define a standardized JSON format for exporting and importing custom agents and workflows. The format should be self-contained and portable.

**Subtasks:**

1. Add export/import types to `packages/shared/src/types/neo.ts`:

   ```typescript
   /** Exported agent definition (room-agnostic) */
   interface ExportedAgent {
     /** Schema version for future compatibility */
     version: 1;
     type: 'agent';
     name: string;
     description: string;
     model: string;
     provider?: string;
     tools: string[];
     systemPrompt: string;
     role: 'worker' | 'reviewer' | 'orchestrator';
     config?: Record<string, unknown>;
   }

   /** Exported workflow definition (room-agnostic) */
   interface ExportedWorkflow {
     version: 1;
     type: 'workflow';
     name: string;
     description: string;
     steps: Array<{
       name: string;
       agentRef: string;
       agentRefType: 'builtin' | 'custom';
       entryGate?: WorkflowGate | null;
       exitGate?: WorkflowGate | null;
       instructions?: string;
       order: number;
     }>;
     rules: Array<{
       name: string;
       content: string;
       appliesTo?: string[];
     }>;
     tags: string[];
     config?: Record<string, unknown>;
   }

   /** A bundle containing agents and/or workflows */
   interface ExportBundle {
     version: 1;
     type: 'bundle';
     name: string;
     description?: string;
     agents: ExportedAgent[];
     workflows: ExportedWorkflow[];
     exportedAt: string; // ISO timestamp
     exportedFrom?: string; // room name (optional metadata)
   }
   ```

2. Create `packages/daemon/src/lib/room/data/export-format.ts`:
   - `exportAgent(agent: CustomAgent): ExportedAgent`
   - `exportWorkflow(workflow: Workflow): ExportedWorkflow`
   - `exportBundle(agents: CustomAgent[], workflows: Workflow[], name: string): ExportBundle`
   - Strip room-specific IDs and timestamps from exports

3. Create validation functions:
   - `validateExportedAgent(data: unknown): ExportedAgent` -- validates and coerces
   - `validateExportedWorkflow(data: unknown): ExportedWorkflow`
   - `validateExportBundle(data: unknown): ExportBundle`
   - Use zod schemas for validation

4. Write unit tests:
   - Round-trip: export -> serialize -> deserialize -> validate
   - Validation rejects malformed data
   - Room-specific fields (id, roomId, timestamps) are stripped on export

**Acceptance criteria:**
- Export format is well-defined and versioned
- Validation catches malformed imports
- Room-specific data is stripped on export
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 8.2: Export/Import RPC Handlers

**Agent:** coder
**Priority:** normal
**Depends on:** Task 8.1

**Description:**

Add RPC handlers for exporting and importing agents and workflows.

**Subtasks:**

1. Create `packages/daemon/src/lib/rpc-handlers/export-import-handlers.ts`:
   - `export.agents { roomId, agentIds? }` -> returns `{ bundle: ExportBundle }` (all or specific agents)
   - `export.workflows { roomId, workflowIds? }` -> returns `{ bundle: ExportBundle }` (all or specific workflows)
   - `export.bundle { roomId, agentIds?, workflowIds? }` -> returns full bundle
   - `import.preview { bundle }` -> returns `{ agents: ImportPreview[], workflows: ImportPreview[] }` (dry run showing what will be created, with conflict detection)
   - `import.execute { roomId, bundle, conflictResolution }` -> creates agents/workflows in target room

2. Implement conflict resolution:
   - `ImportPreview` includes: `name`, `action: 'create' | 'conflict'`, `existingId?: string`
   - `conflictResolution`: `'skip' | 'rename' | 'replace'` per item
   - When `rename`: append " (imported)" to name
   - When `replace`: update existing agent/workflow
   - When `skip`: do not import

3. Handle cross-references:
   - Workflows referencing custom agents: if the referenced agent is in the bundle, map the new ID after import
   - If the referenced agent is NOT in the bundle, flag it in the preview

4. Wire handlers in `app.ts`

5. Write unit tests:
   - Export includes correct data
   - Import preview detects conflicts
   - Import with different conflict resolutions
   - Cross-reference mapping works
   - Error handling for invalid bundles

**Acceptance criteria:**
- Export produces valid JSON bundles
- Import preview accurately detects conflicts
- Conflict resolution options all work correctly
- Cross-references between agents and workflows are handled
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 8.3: Frontend Export/Import UI

**Agent:** coder
**Priority:** normal
**Depends on:** Task 8.2

**Description:**

Add export and import UI actions to the custom agent and workflow list views.

**Subtasks:**

1. Add export functionality:
   - "Export" button on individual agent/workflow cards (exports single item)
   - "Export All" button on list views (exports all agents or workflows)
   - "Export Bundle" button on room settings (exports everything)
   - Export triggers a file download with `.neokai.json` extension
   - File named: `{room-name}-{type}-{date}.neokai.json`

2. Add import functionality:
   - "Import" button on list views
   - Opens file picker for `.json` or `.neokai.json` files
   - After file selection, calls `import.preview` and shows preview dialog:
     - List of items to import with name, type, and conflict status
     - Conflict resolution options per item (skip/rename/replace)
     - "Import" and "Cancel" buttons
   - On confirm, calls `import.execute`
   - Shows success/error toast

3. Create `packages/web/src/components/room/ImportPreviewDialog.tsx`:
   - Modal showing import preview results
   - Checkbox per item to include/exclude
   - Conflict resolution dropdown per conflicting item
   - Summary line: "Will create X agents and Y workflows"

4. Write e2e tests:
   - Export a custom agent, verify download
   - Import a previously exported agent into the same room (conflict scenario)
   - Import into a room with no conflicts
   - Import a bundle with both agents and workflows

**Acceptance criteria:**
- Export downloads a valid JSON file
- Import flow shows preview before executing
- Conflict resolution works as expected
- E2E tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
