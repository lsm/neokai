# Plan: Enhance Gate System — Customizable Badges and Script-Based Checks

## Context

The workflow gate system currently uses hardcoded heuristics to derive badge labels and colors on channel edges. Badge text like "Human", "Votes", "Shell" is inferred from field declarations via `resolveSemanticGateType()` and hardcoded maps in `EdgeRenderer.tsx`. Gate evaluation is purely synchronous and declarative — fields are checked against data, but there is no mechanism to run imperative checks (e.g., lint, test, compile) before field evaluation.

This plan adds two capabilities:
1. **Customizable badge label and color** — author-defined `label` and `color` on the Gate entity, with heuristic fallback preserved for backward compatibility
2. **Script-based gate checks** — optional free-form script execution (bash/node/python3) as an imperative pre-check before declarative field evaluation, using `Bun.spawn()` for process isolation

## Approach

### Part A: Customizable Badges (label + color on Gate)

Add optional `label?: string` and `color?: string` fields to the `Gate` interface in `@neokai/shared`. When set, these override the heuristic-derived badge text and color on channel edges. When not set, the existing heuristic logic in `resolveSemanticGateType()` and `EdgeRenderer.tsx` continues to work unchanged.

- `color` uses hex-only format (`#rrggbb`), validated via regex at the boundary
- `label` is capped at 20 characters
- `fields` becomes optional on `Gate` (defaults to `[]`), since a gate with only a script check needs no fields

### Part B: Script-Based Gate Checks

Add optional `script?: GateScript` to the Gate interface. When present, the gate evaluator runs the script before evaluating declarative fields. The script's stdout (parsed as JSON) is deep-merged into the gate data before field evaluation. A non-zero exit code or timeout blocks the gate immediately.

Key design decisions:
- `Bun.spawn()` (array form), never `Bun.$` (CVE-2025-8022)
- Languages: `bash`, `node`, `python3` only (allowlist)
- Default timeout: 30s, `killSignal: 'SIGKILL'`
- `maxBuffer: 1MB` on stdout
- Restricted env (no API keys or credentials)
- Per-gate evaluation queue (serialized) to prevent race conditions in `onGateDataChanged()`
- Deep merge of JSON stdout with depth limit (max 5 levels)

### Part C: Async Migration

`evaluateGate()` becomes async to support script execution. A private sync helper (`evaluateFieldsSync`) preserves the pure declarative path for gates without scripts. Callers of `evaluateGate` in `ChannelRouter` become async-aware. Existing sync callers in `isChannelOpen()` add an async wrapper.

---

## Milestone 1: Shared Type Changes (Gate Interface + Validation)

### Task 1.1: Extend Gate interface with label, color, script fields

**File:** `packages/shared/src/types/space.ts`

**Subtasks:**
1. Add `GateScript` interface:
   ```ts
   export interface GateScript {
     /** Script interpreter: 'bash', 'node', or 'python3' */
     interpreter: 'bash' | 'node' | 'python3';
     /** Script source code to execute */
     source: string;
     /** Timeout in milliseconds (default: 30000) */
     timeoutMs?: number;
     /** Maximum stdout buffer size in bytes (default: 1048576 = 1MB) */
     maxBuffer?: number;
   }
   ```
2. Add `label?: string` and `color?: string` and `script?: GateScript` to the `Gate` interface (lines 580-592)
3. Make `fields` optional on `Gate` (change `fields: GateField[]` to `fields?: GateField[]`)
4. Update `computeGateDefaults()` to accept `fields: GateField[]` parameter with default `[]` when called
5. Export `GateScript` from the shared module barrel

**Acceptance criteria:**
- `Gate` type compiles with `label`, `color`, `script` all optional, `fields` optional
- `computeGateDefaults(undefined)` returns `{}`
- `computeGateDefaults([])` returns `{}`
- No existing code breaks — all call sites already pass `fields` explicitly
- `GateScript` type is exported from `@neokai/shared`

**Dependencies:** None
**Agent type:** coder

---

### Task 1.2: Add gate validation for new fields

**File:** `packages/daemon/src/lib/space/runtime/gate-evaluator.ts`

**Subtasks:**
1. Add `validateGateColor(color: unknown): string[]` — validates hex format `#rrggbb` via `/^#[0-9a-fA-F]{6}$/`
2. Add `validateGateLabel(label: unknown): string[]` — validates string, max 20 chars
3. Add `validateGateScript(script: unknown): string[]` — validates:
   - `interpreter` is one of `'bash' | 'node' | 'python3'`
   - `source` is a non-empty string
   - `timeoutMs` is positive number if present (max 120000)
   - `maxBuffer` is positive number if present (max 10485760)
4. Add `validateGate(gate: unknown): string[]` — top-level validator that calls `validateGateFields()`, `validateGateColor()`, `validateGateLabel()`, and `validateGateScript()`

**Acceptance criteria:**
- `validateGate({ id: 'g1', fields: [], resetOnCycle: false })` returns `[]`
- Invalid color `'red'` produces error
- Valid color `'#ff5500'` passes
- Script with `interpreter: 'ruby'` produces error
- Empty `source` produces error
- `timeoutMs: 200000` produces error (exceeds 120s max)
- Label longer than 20 chars produces error

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 1.3: Unit tests for shared type changes

**File:** `packages/daemon/tests/unit/space/gate-types-and-schema.test.ts`

**Subtasks:**
1. Add tests for `Gate` with `label` and `color` fields persisting through `SpaceWorkflowRepository` round-trip
2. Add tests for `Gate` with `script` field persisting through workflow repository
3. Add tests for `Gate` with `fields` omitted (script-only gate) persisting correctly
4. Add tests for `computeGateDefaults` with `undefined` and `[]` fields
5. Verify backward compatibility: existing gates without `label`/`color`/`script` round-trip unchanged

**Acceptance criteria:**
- All new tests pass
- Existing tests continue to pass
- Gate with label+color+script+fields persists and round-trips correctly
- Gate with only script (no fields) persists and round-trips correctly

**Dependencies:** Task 1.1, Task 1.2
**Agent type:** coder

---

## Milestone 2: Backend Script Execution Engine

### Task 2.1: Create gate script executor

**New file:** `packages/daemon/src/lib/space/runtime/gate-script-executor.ts`

**Subtasks:**
1. Define `GateScriptResult` interface:
   ```ts
   export interface GateScriptResult {
     success: boolean;
     data?: Record<string, unknown>;  // parsed JSON stdout
     error?: string;                   // stderr or error message
   }
   ```
2. Define `RESTRICTED_ENV_KEYS` — set of env var prefixes to strip (e.g., `ANTHROPIC_`, `CLAUDE_`, `GLM_`, `ZHIPU_`, `COPILOT_`, `NEOKAI_`)
3. Implement `buildRestrictedEnv(): Record<string, string | undefined>`:
   - Start with `process.env` copy
   - Remove keys matching restricted prefixes
   - Remove common credential keys: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, etc.
4. Implement `deepMergeWithDepthLimit(target, source, maxDepth = 5): Record<string, unknown>`:
   - Recursive merge of source into target
   - Reject keys named `__proto__`, `constructor`, `prototype`
   - Stop recursing at `maxDepth`
5. Implement `parseJsonStdout(raw: string): Record<string, unknown> | null`:
   - Trim whitespace, parse as JSON
   - Return null if parse fails or result is not a plain object
6. Implement `executeGateScript(script: GateScript, context?: { workspacePath?: string }): Promise<GateScriptResult>`:
   - Build restricted env
   - Set `cwd` to `context?.workspacePath ?? process.cwd()`
   - Determine interpreter binary: `bash` -> `['bash', '-c', script.source]`, `node` -> `['node', '-e', script.source]`, `python3` -> `['python3', '-c', script.source]`
   - Spawn with `Bun.spawn()`, capture stdout + stderr
   - Apply `timeoutMs` (default 30000) via `setTimeout` + `process.kill(pid, 'SIGKILL')`
   - Apply `maxBuffer` (default 1048576) — kill process if stdout exceeds limit
   - On exit code 0: parse stdout as JSON, deep-merge with depth limit into empty object, return `{ success: true, data }`
   - On non-zero exit or timeout: return `{ success: false, error: stderr || 'exit code N' }`

**Acceptance criteria:**
- `executeGateScript({ interpreter: 'node', source: 'console.log(JSON.stringify({done:true}))' })` returns `{ success: true, data: { done: true } }`
- Script with non-zero exit returns `{ success: false, error: ... }`
- Script exceeding timeout is killed and returns failure
- Restricted env does not leak `ANTHROPIC_API_KEY`
- Deep merge with depth limit stops at max depth
- Prototype pollution keys are rejected
- Empty/non-JSON stdout returns `{ success: true, data: {} }` (no error, just no data)

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 2.2: Unit tests for gate script executor

**New file:** `packages/daemon/tests/unit/space/gate-script-executor.test.ts`

**Subtasks:**
1. Test successful script execution with JSON stdout (all three interpreters: bash, node, python3)
2. Test non-zero exit code handling
3. Test timeout enforcement
4. Test maxBuffer enforcement
5. Test restricted env does not leak credentials
6. Test deep merge with depth limit
7. Test prototype pollution prevention
8. Test non-JSON stdout handling (returns empty data, no error)
9. Test invalid interpreter rejection (via validateGateScript, not executeGateScript)

**Acceptance criteria:**
- All tests pass with `bun test`
- Tests do not require real API keys or external services
- Coverage of happy path + error paths for all three interpreters

**Dependencies:** Task 2.1
**Agent type:** coder

---

## Milestone 3: Async Gate Evaluation Migration

### Task 3.1: Migrate evaluateGate to async with script pre-check

**File:** `packages/daemon/src/lib/space/runtime/gate-evaluator.ts`

**Subtasks:**
1. Extract sync field evaluation into private helper `evaluateFieldsSync(gate: Gate, data: Record<string, unknown>): GateEvalResult`
2. Make `evaluateGate()` async: `async evaluateGate(gate: Gate, data: Record<string, unknown>, scriptExecutor?: GateScriptExecutor): Promise<GateEvalResult>`
3. If `gate.script` is defined and `scriptExecutor` is provided:
   - Call `scriptExecutor.executeGateScript(gate.script)`
   - On failure: return `{ open: false, reason: 'Script check failed: ' + result.error }`
   - On success: deep-merge `result.data` into `data` (via `deepMergeWithDepthLimit`)
4. Then call `evaluateFieldsSync(gate, mergedData)` as before
5. If `gate.script` is undefined or `scriptExecutor` is not provided: call `evaluateFieldsSync` directly (no async overhead for existing gates)
6. Update `isChannelOpen()` to async: wrap call to `evaluateGate()` in async, accept optional `scriptExecutor`
7. Update `GateEvalResult` to remain synchronous (the async is only in evaluation, not the result type)

**Acceptance criteria:**
- Existing tests for `evaluateGate` and `isChannelOpen` continue to pass (with updated async calls)
- Gate without script evaluates synchronously under the hood (no unnecessary promise)
- Gate with script runs script before field evaluation
- Script failure blocks the gate immediately
- Script success merges stdout data before field checks
- `isChannelOpen` returns a `Promise<GateEvalResult>`

**Dependencies:** Task 1.1, Task 2.1
**Agent type:** coder

---

### Task 3.2: Update ChannelRouter for async gate evaluation

**File:** `packages/daemon/src/lib/space/runtime/channel-router.ts`

**Subtasks:**
1. Import `GateScriptExecutor` and `executeGateScript` (or accept via config)
2. Add `scriptExecutor?: GateScriptExecutor` to `ChannelRouterConfig`
3. Update `evaluateGateById()` to async: pass `scriptExecutor` to `evaluateGate()`
4. Update `canDeliver()` to await the async `evaluateGateById()`
5. Update `deliverMessage()` to await the async `evaluateGateById()`
6. Update `onGateDataChanged()` to await the async `evaluateGateById()`
7. Implement per-gate evaluation queue:
   - Add private `gateEvaluationQueues: Map<string, Promise<GateEvalResult>>`
   - In `evaluateGateById()`: check for in-flight evaluation for same gateId; if present, await it instead of starting a new one
   - Clear queue entry after evaluation completes
8. All methods in ChannelRouter that call `evaluateGateById` become fully async-aware (they already return Promises, so this is a minimal change)

**Acceptance criteria:**
- `canDeliver()`, `deliverMessage()`, `onGateDataChanged()` work correctly with async script evaluation
- Concurrent `onGateDataChanged()` calls for the same gateId are serialized (no interleaving)
- Gates without scripts continue to evaluate synchronously-fast (no measurable latency)
- Existing ChannelRouter tests pass (updated for async)
- No race conditions when script execution is slow

**Dependencies:** Task 2.1, Task 3.1
**Agent type:** coder

---

### Task 3.3: Update node-agent-tools.ts for async gate evaluation

**File:** `packages/daemon/src/lib/space/tools/node-agent-tools.ts`

**Subtasks:**
1. Find where `evaluateGate()` is called in `node-agent-tools.ts` (currently imported and used for `list_gates` and gate status reporting)
2. Update calls to `await evaluateGate()` where needed
3. Pass `scriptExecutor` if available in the tools config
4. Update `NodeAgentToolsConfig` if needed to carry `scriptExecutor`

**Acceptance criteria:**
- `list_gates` tool works correctly for gates with scripts
- Gate status in `list_reachable_agents` includes script evaluation results
- No breaking changes to existing tool behavior

**Dependencies:** Task 3.2
**Agent type:** coder

---

### Task 3.4: Unit tests for async gate evaluation + migration

**Files:**
- `packages/daemon/tests/unit/space/gate-evaluator.test.ts`
- `packages/daemon/tests/unit/space/channel-router.test.ts`

**Subtasks:**
1. Update existing `evaluateGate` tests to use `await` (since it is now async)
2. Add tests for `evaluateGate` with script pre-check:
   - Script passes, fields pass -> gate opens
   - Script fails -> gate closed immediately
   - Script passes but merges data that satisfies a field check
   - Script passes but field check still fails
   - Script returns non-JSON stdout -> field evaluation proceeds with original data
3. Add tests for per-gate evaluation queue in ChannelRouter:
   - Concurrent `onGateDataChanged()` for same gateId serializes correctly
   - Different gateIds evaluate concurrently
4. Add tests for backward compatibility: gates without `script` field evaluate as before

**Acceptance criteria:**
- All existing gate evaluator tests pass (updated for async)
- All new async evaluation tests pass
- Per-gate queue tests verify serialization
- No regressions in ChannelRouter tests

**Dependencies:** Task 3.1, Task 3.2
**Agent type:** coder

---

## Milestone 4: Frontend — Customizable Badge Rendering

### Task 4.1: Update semantic graph to pass gate label/color

**File:** `packages/web/src/components/space/visual-editor/semanticWorkflowGraph.ts`

**Subtasks:**
1. Add `gateLabel?: string` and `gateColor?: string` to `SemanticWorkflowEdge` interface
2. Update `resolveSemanticGateType()` to return the heuristic type AND propagate `gate.label` and `gate.color` when set on the Gate entity
3. Since `resolveSemanticGateType` returns only a type string, change its return type to an object: `{ type: SemanticWorkflowEdge['gateType'], label?: string, color?: string }`
4. In `buildSemanticWorkflowEdges()`: use the new return type to set `gateLabel` and `gateColor` on the semantic edge when the gate defines them
5. Fallback: when `gate.label` is not set, continue using the heuristic-derived label (from `CHANNEL_GATE_BADGE_LABELS`). When `gate.color` is not set, continue using the heuristic-derived color (from `CHANNEL_GATE_BADGE_COLORS`).

**Acceptance criteria:**
- `SemanticWorkflowEdge` includes `gateLabel` and `gateColor`
- Gates with `label` set propagate the label to the edge
- Gates without `label` fall back to heuristic
- Gates with `color` set propagate the hex color
- Gates without `color` fall back to heuristic color
- Existing semantic graph tests pass (updated for new return type)

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 4.2: Update EdgeRenderer to use gate label/color

**File:** `packages/web/src/components/space/visual-editor/EdgeRenderer.tsx`

**Subtasks:**
1. Add `gateLabel?: string` and `gateColor?: string` to `ResolvedWorkflowChannel` interface
2. In the channel edge rendering section (around lines 750-756), update badge rendering:
   - Use `channel.gateColor ?? CHANNEL_GATE_BADGE_COLORS[effectiveGateType]` for the badge color
   - Use `channel.gateLabel ?? CHANNEL_GATE_BADGE_LABELS[effectiveGateType]` for the badge label
3. Apply gate color to arrow polygon fills as well
4. No change to the loop badge (it is independent of gate configuration)

**Acceptance criteria:**
- Badge renders with custom label when `gateLabel` is set
- Badge renders with custom color when `gateColor` is set
- Heuristic labels/colors still work when custom ones are not set
- Arrow fills match the badge color (custom or heuristic)
- Selected state (white) still works correctly

**Dependencies:** Task 4.1
**Agent type:** coder

---

### Task 4.3: Update GateEditorPanel with label/color inputs

**File:** `packages/web/src/components/space/visual-editor/GateEditorPanel.tsx`

**Subtasks:**
1. Add "Badge Label" text input field (max 20 chars) — placed between "Description" and "Reset on cycle":
   - `data-testid="gate-editor-label"`
   - Value bound to `gate.label ?? ''`
   - On change: `updateGate({ label: value || undefined })`
2. Add "Badge Color" color picker — placed next to label input or below it:
   - Use `<input type="color">` for hex color selection
   - `data-testid="gate-editor-color"`
   - Value bound to `gate.color ?? '#3b82f6'` (blue default)
   - On change: `updateGate({ color: value })`
   - Add a "Reset" button to clear the custom color and revert to heuristic
3. Show a preview of the badge with the current label and color next to the inputs

**Acceptance criteria:**
- Label input accepts up to 20 characters
- Color picker works and updates badge preview
- Clearing label falls back to heuristic display
- Reset button clears custom color
- Badge preview updates in real-time
- `gate.label` and `gate.color` are correctly propagated to parent via `onChange`

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 4.4: Update GateEditorPanel with script editor

**File:** `packages/web/src/components/space/visual-editor/GateEditorPanel.tsx`

**Subtasks:**
1. Add "Script Check" section below "Fields":
   - Toggle switch to enable/disable script check (`data-testid="gate-editor-script-enabled"`)
   - When enabled, show:
     - Interpreter dropdown: `bash` | `node` | `python3` (`data-testid="gate-editor-script-interpreter"`)
     - Source code textarea with monospace font (`data-testid="gate-editor-script-source"`)
     - Timeout input (number, seconds, default 30, max 120) (`data-testid="gate-editor-script-timeout"`)
   - When disabled, clear `gate.script`
2. Provide simple presets for common scripts:
   - "Lint Check" — `bash` with `npm run lint 2>/dev/null; echo $?`
   - "Type Check" — `node` with `console.log(JSON.stringify({passed: true}))`
   - Placeholder for user to understand the expected format

**Acceptance criteria:**
- Script section can be toggled on/off
- Interpreter dropdown shows three options
- Source textarea accepts multiline script code
- Timeout defaults to 30 and maxes at 120
- Preset buttons populate the form correctly
- Gate with script-only (no fields) works in the editor
- `gate.script` is correctly propagated to parent via `onChange`

**Dependencies:** Task 1.1, Task 4.3
**Agent type:** coder

---

### Task 4.5: Update ChannelEdgeConfigPanel to show gate label/color

**File:** `packages/web/src/components/space/visual-editor/ChannelEdgeConfigPanel.tsx`

**Subtasks:**
1. In the gate summary section, show the custom badge label and color when set on the gate
2. Display a small colored dot or badge preview next to the gate ID when custom label/color is set
3. No functional changes — just visual display of the gate's `label` and `color` in the summary

**Acceptance criteria:**
- Gate summary shows custom label when set
- Gate summary shows color indicator when set
- Gate summary falls back to standard display when not set

**Dependencies:** Task 4.3
**Agent type:** coder

---

### Task 4.6: Update visual editor tests for badge customization

**Files:**
- `packages/web/src/components/space/visual-editor/__tests__/semanticWorkflowGraph.test.ts`
- New file: `packages/web/src/components/space/visual-editor/__tests__/GateEditorPanel.test.tsx` (if not existing)

**Subtasks:**
1. Update `semanticWorkflowGraph.test.ts`:
   - Add tests for gates with `label` set — verify `gateLabel` on semantic edge
   - Add tests for gates with `color` set — verify `gateColor` on semantic edge
   - Add tests for gates without `label`/`color` — verify heuristic fallback
2. If GateEditorPanel tests exist, add tests for:
   - Label input renders and updates gate
   - Color picker renders and updates gate
   - Script toggle renders
   - Script interpreter dropdown works
3. Verify backward compatibility in all tests

**Acceptance criteria:**
- All semantic graph tests pass including new label/color tests
- Gate editor panel tests cover new inputs
- No regressions in existing tests

**Dependencies:** Task 4.1, Task 4.3
**Agent type:** coder

---

## Milestone 5: End-to-End Testing

### Task 5.1: E2E test for customizable gate badges

**New file:** `packages/e2e/tests/features/space-gate-custom-badges.e2e.ts`

**Subtasks:**
1. Create a space with a workflow that has a gated channel
2. Open the gate editor panel
3. Set a custom label on the gate
4. Verify the badge on the channel edge shows the custom label
5. Set a custom color on the gate
6. Verify the badge on the channel edge shows the custom color
7. Remove the custom label and verify heuristic fallback
8. Test script-only gate (no fields) — verify gate can be created and the editor works

**Acceptance criteria:**
- E2E test passes against dev server
- All interactions go through the UI (no direct API calls)
- Assertions verify visible DOM state (badge text, color)
- Test runs with `make run-e2e TEST=tests/features/space-gate-custom-badges.e2e.ts`

**Dependencies:** Task 4.3, Task 4.4
**Agent type:** coder

---

### Task 5.2: E2E test for script-based gate evaluation

**New file:** `packages/e2e/tests/features/space-gate-script-check.e2e.ts`

**Subtasks:**
1. Create a space with a workflow containing a gate with a script check
2. Configure a simple script (e.g., node script that outputs `{ done: true }`)
3. Trigger the gate evaluation (by sending a message through the gated channel)
4. Verify the gate opens when the script succeeds
5. Configure a failing script
6. Verify the gate blocks when the script fails
7. Verify error message is shown to the user

**Acceptance criteria:**
- E2E test passes against dev server
- Script execution result correctly opens/blocks the gate
- Error feedback is visible in the UI
- Test runs with `make run-e2e TEST=tests/features/space-gate-script-check.e2e.ts`

**Dependencies:** Task 3.2, Task 3.3
**Agent type:** coder

---

## Summary

| Milestone | Tasks | Key Deliverable |
|-----------|-------|-----------------|
| 1. Shared Type Changes | 1.1, 1.2, 1.3 | Gate interface with label, color, script; validation; persistence tests |
| 2. Script Execution Engine | 2.1, 2.2 | `gate-script-executor.ts` with Bun.spawn(), restricted env, deep merge |
| 3. Async Gate Evaluation | 3.1, 3.2, 3.3, 3.4 | Async evaluateGate, per-gate queue, ChannelRouter migration |
| 4. Frontend Badge/Editor | 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 | Custom badge rendering, label/color picker, script editor UI |
| 5. E2E Testing | 5.1, 5.2 | End-to-end tests for badge customization and script checks |

**Total tasks:** 15
**Critical path:** 1.1 -> 1.2 -> 2.1 -> 3.1 -> 3.2 -> 3.3 (backend) and 1.1 -> 4.1 -> 4.2 -> 4.3 -> 4.4 (frontend), converging at 5.1 + 5.2
