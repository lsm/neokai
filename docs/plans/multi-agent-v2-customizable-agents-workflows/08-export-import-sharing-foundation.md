# Milestone 8: Data Layer -- Export/Import & Sharing Foundation

## Goal

Implement export and import of custom agent definitions and workflow configurations as JSON. This creates a pure data layer that enables sharing between rooms and across installations, laying the groundwork for a future marketplace.

## Version Migration Strategy

The export format uses `version: 1` as a literal type for strict validation. When `version: 2` is introduced in the future:
- **Import**: The importer will include transform functions (`v1ToV2`, etc.) that upgrade older formats on import. Importing always targets the current version.
- **Export**: Always exports in the latest version format.
- **Rejection**: Versions newer than the current runtime are rejected with a clear error ("This export was created by a newer version of NeoKai. Please upgrade to import it.").

This strategy is documented here as a design decision. The actual transform functions will be implemented when v2 is needed.

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
     /** Schema version for future compatibility. See version migration strategy in 08-export-import-sharing-foundation.md. */
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
     /** Schema version for future compatibility. */
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
   - **Version handling**: Accept `version: 1` only. If `version > 1`, reject with message: "This export requires a newer version of NeoKai." If version is missing or < 1, reject as invalid.

4. Write unit tests:
   - Round-trip: export -> serialize -> deserialize -> validate
   - Validation rejects malformed data
   - Room-specific fields (id, roomId, timestamps) are stripped on export
   - Version validation: accepts v1, rejects v2+, rejects missing version

**Acceptance criteria:**
- Export format is well-defined and versioned
- Validation catches malformed imports
- Version checking provides clear upgrade messages
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
   - `import.preview { bundle, roomId }` -> returns `{ agents: ImportPreview[], workflows: ImportPreview[], validationErrors: ValidationError[] }` (dry run showing what will be created, with conflict detection AND full `WorkflowManager` validation including gate security checks — non-allowlisted commands, path traversal, etc. Surface validation errors in the preview so users see them BEFORE committing to import)
   - `import.execute { roomId, bundle, conflictResolution }` -> creates agents/workflows in target room (re-validates on execute as well)

2. Implement conflict resolution:
   - `ImportPreview` includes: `name`, `action: 'create' | 'conflict'`, `existingId?: string`
   - `conflictResolution`: `'skip' | 'rename' | 'replace'` per item
   - When `rename`: append " (imported)" to name
   - When `replace`: update existing agent/workflow
   - When `skip`: do not import

3. Handle cross-references:
   - Workflows referencing custom agents: if the referenced agent is in the bundle, map the new ID after import
   - If the referenced agent is NOT in the bundle and not present in the target room, flag it in the preview as a warning (workflow step will reference a non-existent agent)

4. Wire handlers in `app.ts`

5. Write unit tests:
   - Export includes correct data
   - Import preview detects conflicts
   - Import preview surfaces gate validation errors (non-allowlisted quality_check commands, path traversal in custom gates)
   - Import with different conflict resolutions
   - Cross-reference mapping works
   - Missing cross-references are flagged as warnings
   - Error handling for invalid bundles
   - Version validation on import

**Acceptance criteria:**
- Export produces valid JSON bundles
- Import preview accurately detects conflicts, missing cross-references, AND gate validation errors
- Gate security validation runs during preview (not deferred to execute)
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
     - Missing cross-reference warnings (e.g., "Workflow 'X' references agent 'Y' which is not in this room")
     - Conflict resolution options per item (skip/rename/replace)
     - "Import" and "Cancel" buttons
   - On confirm, calls `import.execute`
   - Shows success/error toast
   - Version mismatch shows clear upgrade message

3. Create `packages/web/src/components/room/ImportPreviewDialog.tsx`:
   - Modal showing import preview results
   - Checkbox per item to include/exclude
   - Conflict resolution dropdown per conflicting item
   - Warning section for missing cross-references
   - Summary line: "Will create X agents and Y workflows"

4. Write e2e tests:
   - Export a custom agent, verify download
   - Import a previously exported agent into the same room (conflict scenario)
   - Import into a room with no conflicts
   - Import a bundle with both agents and workflows

**Acceptance criteria:**
- Export downloads a valid JSON file
- Import flow shows preview before executing
- Missing cross-references are warned about
- Conflict resolution works as expected
- E2E tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
