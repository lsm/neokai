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
- `Bun.spawn()` (array form), never `Bun.$` — user-supplied script source must never be interpolated into a shell string, and `Bun.spawn` avoids shell interpretation entirely
- Languages: `bash`, `node`, `python3` only (allowlist)
- Default timeout: 30s, `killSignal: 'SIGKILL'`
- `maxBuffer: 1MB` on stdout — enforced via chunk-by-chunk byte counting during streaming read, not by buffering everything then checking size
- Restricted env (no API keys or credentials) — scripts are **trusted** (workspace-author-configured), but env is restricted as defense-in-depth to prevent accidental credential leakage
- Per-gate evaluation coalescing with re-run-if-dirty pattern: concurrent evaluations for the same gateId share one in-flight result, but if new gate data arrives during execution, a follow-up re-evaluation is scheduled
- Deep merge of JSON stdout with depth limit (max 5 levels), rejecting `__proto__`/`constructor`/`prototype` keys

### Part C: Async Migration

`evaluateGate()` becomes async to support script execution. A private sync helper (`evaluateFieldsSync`) preserves the pure declarative path for gates without scripts. The **frontend** retains its own independent `evaluateGateStatus()` function in `WorkflowCanvas.tsx` (which is sync and field-only) — it is not affected by the backend async migration.

`isChannelOpen()` remains **synchronous** — it is a convenience function for checking gate status from data already in hand, not for triggering script execution. It has no `scriptExecutor` context.

### Part D: Concurrency

Per-gate evaluation coalescing prevents overlapping evaluations for the same gate (deduplication). A global concurrency semaphore (default: 4) caps the total number of simultaneous script processes across all gates to prevent resource exhaustion.

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
   }
   ```
2. Add `label?: string` and `color?: string` and `script?: GateScript` to the `Gate` interface (lines 580-592)
3. Make `fields` optional on `Gate` (change `fields: GateField[]` to `fields?: GateField[]`)
4. Update `computeGateDefaults()` signature to accept `fields?: GateField[]` — internally treat `undefined` as `[]`
5. Export `GateScript` from the shared module barrel
6. **Update all `computeGateDefaults` call sites** that pass `gate.fields` or `gateDef.fields` — since `fields` is now optional, these call sites remain valid because `computeGateDefaults` accepts `undefined`. Verify by checking:
   - `channel-router.ts` lines 594, 728, 741
   - `node-agent-tools.ts` lines 585, 621
   - `gate-data-repository.ts` documentation (line 112)
   - `channel-router.test.ts` (multiple call sites)

**Acceptance criteria:**
- `Gate` type compiles with `label`, `color`, `script` all optional, `fields` optional
- `computeGateDefaults(undefined)` returns `{}`
- `computeGateDefaults([])` returns `{}`
- `computeGateDefaults(someFields)` returns the same result as before
- No existing code breaks — all `computeGateDefaults(gate.fields)` call sites still work because `gate.fields` is `GateField[] | undefined` and the function now accepts that
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
4. Add `validateGate(gate: unknown): string[]` — top-level validator that:
   - Calls `validateGateFields()` when `fields` is present
   - Calls `validateGateColor()`, `validateGateLabel()`, `validateGateScript()`
   - Validates that at least one of `fields` (non-empty) or `script` is present

**Acceptance criteria:**
- `validateGate({ id: 'g1', fields: [], resetOnCycle: false })` returns errors (empty fields, no script)
- `validateGate({ id: 'g1', fields: [{ ... }], resetOnCycle: false })` returns `[]`
- `validateGate({ id: 'g1', script: { interpreter: 'node', source: '...' }, resetOnCycle: false })` returns `[]`
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
2. Define `RESTRICTED_ENV_PATTERNS` — list of env var prefixes/keys to strip. **Threat model:** scripts are trusted (workspace-author-configured) but env is restricted as defense-in-depth:
   - Prefixes: `ANTHROPIC_`, `CLAUDE_`, `GLM_`, `ZHIPU_`, `COPILOT_`, `NEOKAI_SECRET_`
   - Exact keys: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `DATABASE_URL`, `PRIVATE_KEY`, any key matching `/SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i`
   - Always allow: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TERM`, `TMPDIR`
3. Implement `buildRestrictedEnv(): Record<string, string | undefined>`:
   - Start with `process.env` copy
   - Strip keys matching restricted patterns
   - Preserve allowed keys
4. Implement `deepMergeWithDepthLimit(target, source, maxDepth = 5): Record<string, unknown>`:
   - Recursive merge of source into target
   - Reject keys named `__proto__`, `constructor`, `prototype`
   - Stop recursing at `maxDepth` (return source value as-is at limit)
5. Implement `parseJsonStdout(raw: string): Record<string, unknown> | null`:
   - Trim whitespace, parse as JSON
   - Return null if parse fails or result is not a plain object
6. Implement `executeGateScript(script: GateScript, context: { workspacePath: string; gateId: string; runId: string }): Promise<GateScriptResult>`:
   - Build restricted env; inject `NEOKAI_GATE_ID`, `NEOKAI_WORKFLOW_RUN_ID`, `NEOKAI_WORKSPACE_PATH`
   - Set `cwd` to `context.workspacePath`
   - Determine interpreter binary: `bash` -> `['bash', '-c', script.source]`, `node` -> `['node', '-e', script.source]`, `python3` -> `['python3', '-c', script.source]`
   - Spawn with `Bun.spawn()`, capture stdout + stderr
   - Apply `timeoutMs` (default 30000) — if Bun.spawn `timeout` option works reliably, use it; otherwise use `setTimeout` + `process.kill(pid, 'SIGKILL')` as fallback
   - **`maxBuffer` enforcement via streaming**: read stdout chunk-by-chunk from `proc.stdout` using a loop (e.g., `proc.stdout.getReader()` or `for await (const chunk of proc.stdout)`), accumulating byte count. If accumulated bytes exceed 1MB, kill the process and return failure. This avoids buffering everything before checking size.
   - On exit code 0: parse stdout as JSON, deep-merge with depth limit into empty object, return `{ success: true, data }`
   - On non-zero exit or timeout: return `{ success: false, error: stderr.trim() || 'exit code N' }`

**Acceptance criteria:**
- `executeGateScript({ interpreter: 'node', source: 'console.log(JSON.stringify({done:true}))' }, context)` returns `{ success: true, data: { done: true } }`
- Script with non-zero exit returns `{ success: false, error: ... }`
- Script exceeding timeout is killed and returns failure
- Restricted env does not leak `ANTHROPIC_API_KEY` or other credential keys
- Deep merge with depth limit stops at max depth
- Prototype pollution keys are rejected
- Empty/non-JSON stdout returns `{ success: true, data: {} }` (no error, just no data)
- `maxBuffer` is enforced during streaming, not after full buffer

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 2.2: Unit tests for gate script executor

**New file:** `packages/daemon/tests/unit/space/gate-script-executor.test.ts`

**Subtasks:**
1. Test successful script execution with JSON stdout (all three interpreters: bash, node, python3)
2. Test non-zero exit code handling
3. Test timeout enforcement
4. Test maxBuffer enforcement (script that outputs >1MB)
5. Test restricted env does not leak credentials (including keys matching `API_KEY` pattern, `SECRET` pattern, etc.)
6. Test deep merge with depth limit
7. Test prototype pollution prevention (`__proto__`, `constructor`, `prototype`)
8. Test non-JSON stdout handling (returns empty data, no error)
9. Test `workspacePath` is set as `cwd` and injected as `NEOKAI_WORKSPACE_PATH`
10. Test `NEOKAI_GATE_ID` and `NEOKAI_WORKFLOW_RUN_ID` are injected

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
2. Make `evaluateGate()` async: `async evaluateGate(gate: Gate, data: Record<string, unknown>, scriptExecutor?: GateScriptExecutorFn): Promise<GateEvalResult>`
   - `GateScriptExecutorFn` type: `(script: GateScript, context: { workspacePath: string; gateId: string; runId: string }) => Promise<GateScriptResult>`
3. If `gate.script` is defined and `scriptExecutor` is provided:
   - Call `scriptExecutor(gate.script, context)`
   - On failure: return `{ open: false, reason: 'Script check failed: ' + result.error }`
   - On success: deep-merge `result.data` into `data` (via `deepMergeWithDepthLimit`)
4. Then call `evaluateFieldsSync(gate, mergedData)` as before
5. If `gate.script` is undefined or `scriptExecutor` is not provided: call `evaluateFieldsSync` directly (no async overhead for existing gates — just returns a resolved Promise wrapping the sync result)
6. **Keep `isChannelOpen()` synchronous** — it is a convenience function for checking gate status from data already in hand, not for triggering script execution. It does not need a `scriptExecutor` parameter. It continues to call `evaluateFieldsSync` directly.
7. `GateEvalResult` remains a plain synchronous type (the async is only in evaluation, not the result type)

**Frontend note:** `packages/web/src/components/space/WorkflowCanvas.tsx` has its own independent `evaluateGateStatus()` function (line 123) that is sync and field-only. It is **not** affected by this backend change — it does not import or call the backend `evaluateGate`. No changes needed in `WorkflowCanvas.tsx`.

**Acceptance criteria:**
- Existing tests for `evaluateGate` continue to pass (with `await` added since it is now async)
- `isChannelOpen` remains synchronous and unmodified
- Gate without script evaluates synchronously under the hood (returns immediately-resolved Promise)
- Gate with script runs script before field evaluation
- Script failure blocks the gate immediately
- Script success merges stdout data before field checks

**Dependencies:** Task 1.1, Task 2.1
**Agent type:** coder

---

### Task 3.2: Update ChannelRouter for async gate evaluation

**File:** `packages/daemon/src/lib/space/runtime/channel-router.ts`

**Subtasks:**
1. Import `executeGateScript` and the `GateScriptExecutorFn` type
2. Add `workspacePath?: string` to `ChannelRouterConfig` — **this is critical** because `ChannelRouter` currently has no workspace path, and scripts must run from the space workspace directory. Without this, scripts would run from `process.cwd()` (the daemon working directory) and silently break workspace-relative checks.
3. Add `maxConcurrentScripts?: number` to `ChannelRouterConfig` (default: 4) — global concurrency cap for script executions across all gates to prevent resource exhaustion.
4. Implement a global concurrency semaphore (simple counter-based, not a library):
   ```ts
   private scriptSemaphore: { acquired: number; waiters: Array<() => void> }
   ```
5. Implement per-gate evaluation coalescing **with re-run-if-dirty**:
   - `gateEvaluations: Map<string, Promise<GateEvalResult>>` — tracks in-flight evaluations
   - `gateDirtyFlags: Map<string, boolean>` — marks gates that need re-evaluation after current eval completes
   - In `evaluateGateById()`: if an evaluation is in-flight for this gateId, set the dirty flag and await the in-flight result. After the in-flight result resolves, if dirty flag is set, clear it and start a new evaluation.
6. Update `evaluateGateById()` to async: wrap script execution in semaphore acquire/release, pass `scriptExecutor` to `evaluateGate()`
7. Update `canDeliver()` and `deliverMessage()` to await the async `evaluateGateById()` (these methods are already async, so this is minimal)
8. Update `onGateDataChanged()` to await the async `evaluateGateById()` with re-run-if-dirty support

**Acceptance criteria:**
- `canDeliver()`, `deliverMessage()`, `onGateDataChanged()` work correctly with async script evaluation
- Concurrent `onGateDataChanged()` calls for the same gateId are coalesced (share one result), but if new data arrives during execution, a re-evaluation is triggered
- Different gateIds can evaluate concurrently (up to `maxConcurrentScripts` limit)
- Gates without scripts continue to evaluate without semaphore overhead
- `workspacePath` is available in the config and passed to `executeGateScript`
- Existing ChannelRouter tests pass (updated for async where needed)

**Dependencies:** Task 2.1, Task 3.1
**Agent type:** coder

---

### Task 3.3: Wire ChannelRouter construction sites with workspacePath and scriptExecutor

**Files:**
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (lines 622, 1440, 1755)
- `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` (line 309)

**Subtasks:**
1. **`task-agent-manager.ts` line 622** (main task ChannelRouter): add `workspacePath` to `ChannelRouterConfig`. `workspacePath` is already available in scope at line 636 (passed to `createTaskAgentMcpServer`). Import `executeGateScript` and pass it as the script executor function.
2. **`task-agent-manager.ts` line 1440** (rehydration ChannelRouter): add `workspacePath` to config. The workspace path is available via `this.config.space.workspacePath`.
3. **`task-agent-manager.ts` line 1755** (node agent ChannelRouter): add `workspacePath` to config. This is where `createNodeAgentMcpServer` is called, and `workspacePath` is available via the space object. **This is the critical injection point** — the node agent's `write_gate` MCP tool triggers `onGateDataChanged()` which evaluates gates. Without wiring `workspacePath` here, gate scripts in node agent workflows would fail.
4. **`space-runtime-service.ts` line 309**: add `workspacePath` to config. The workspace path is available via `space.workspacePath`.
5. At each site, create a thin script executor wrapper that binds the workspace path:
   ```ts
   const scriptExecutor = (script: GateScript, ctx: ScriptContext) =>
     executeGateScript(script, { ...ctx, workspacePath });
   ```
   (Or pass `executeGateScript` directly if the ChannelRouter can bind `workspacePath` internally.)

**Acceptance criteria:**
- All four `new ChannelRouter(...)` call sites include `workspacePath` in their config
- Node agent MCP server's `write_gate` tool can trigger script evaluation with correct workspace path
- Rehydration ChannelRouter preserves script evaluation capability
- No TypeScript errors at any call site

**Dependencies:** Task 2.1, Task 3.2
**Agent type:** coder

---

### Task 3.4: Update node-agent-tools.ts for async gate evaluation

**File:** `packages/daemon/src/lib/space/tools/node-agent-tools.ts`

**Subtasks:**
1. Update the two `evaluateGate()` call sites (lines 624 and 699) to `await evaluateGate()`
   - Line 624 is in `list_gates` — reports gate status. Since `list_gates` does not have a `scriptExecutor`, it uses the sync-only path (no script execution in listing). This is acceptable — gate status shown in listing reflects field evaluation only; script status would be shown separately.
   - Line 699 is in `write_gate` — the hot path invoked by agents. This call site already has the ChannelRouter context which now supports async. Update to `await`.
2. Pass `scriptExecutor` if available in the tools config (from the ChannelRouter)
3. Update `NodeAgentToolsConfig` if needed to carry `scriptExecutor`

**Acceptance criteria:**
- `list_gates` tool works correctly (shows field-based gate status, no script execution)
- `write_gate` tool correctly triggers async gate evaluation including script execution
- Gate status in `list_reachable_agents` includes field-based evaluation results
- No breaking changes to existing tool behavior

**Dependencies:** Task 3.2, Task 3.3
**Agent type:** coder

---

### Task 3.5: Unit tests for async gate evaluation + migration

**Files:**
- `packages/daemon/tests/unit/space/gate-evaluator.test.ts`
- `packages/daemon/tests/unit/space/channel-router.test.ts`

**Subtasks:**
1. Update existing `evaluateGate` tests to use `await` (since it is now async)
2. Add tests for `evaluateGate` with script pre-check:
   - Script passes, fields pass → gate opens
   - Script fails → gate closed immediately
   - Script passes but merges data that satisfies a field check
   - Script passes but field check still fails
   - Script returns non-JSON stdout → field evaluation proceeds with original data
   - No scriptExecutor provided → falls back to sync field evaluation
3. Add tests for per-gate evaluation coalescing in ChannelRouter:
   - Concurrent `onGateDataChanged()` for same gateId shares one in-flight result
   - New data arriving during execution triggers re-evaluation (dirty flag)
   - Different gateIds evaluate concurrently
4. Add tests for global concurrency semaphore:
   - More than `maxConcurrentScripts` gates with scripts → excess gates wait
   - After one completes, next one starts
5. Add tests for backward compatibility: gates without `script` field evaluate as before
6. Verify `isChannelOpen` remains synchronous

**Acceptance criteria:**
- All existing gate evaluator tests pass (updated for async)
- All new async evaluation tests pass
- Per-gate coalescing tests verify shared-result + dirty-flag re-run behavior
- Semaphore tests verify concurrency cap
- `isChannelOpen` tests confirm no async changes

**Dependencies:** Task 3.1, Task 3.2
**Agent type:** coder

---

## Milestone 4: Frontend — Customizable Badge Rendering

### Task 4.1: Update semantic graph to pass gate label/color (bidirectional)

**File:** `packages/web/src/components/space/visual-editor/semanticWorkflowGraph.ts`

**Subtasks:**
1. Add `gateLabel?: string`, `gateColor?: string`, `hasScript?: boolean` to `SemanticWorkflowEdge` interface
2. Add corresponding `reverseGateLabel?: string`, `reverseGateColor?: string`, `reverseHasScript?: boolean` for bidirectional edges
3. Update `PairAggregate` (line 37-48) to add:
   - `lowToHighGateLabel?: string`, `lowToHighGateColor?: string`, `lowToHighHasScript?: boolean`
   - `highToLowGateLabel?: string`, `highToLowGateColor?: string`, `highToLowHasScript?: boolean`
4. Change `resolveSemanticGateType()` return type to `{ type: SemanticWorkflowEdge['gateType']; label?: string; color?: string; hasScript: boolean }`:
   - Continue returning the heuristic `type` as before
   - Additionally return `gate.label`, `gate.color`, and `!!gate.script` when the gate defines them
   - When `gate.label` is not set, return `undefined` for label (caller will use heuristic-based label)
   - When `gate.color` is not set, return `undefined` for color (caller will use heuristic-based color)
5. In `buildSemanticWorkflowEdges()`: update the aggregate logic (lines 164-186) and collapse logic (lines 193-210) to propagate `label`, `color`, and `hasScript` alongside `gateType`:
   - For bidirectional edges: `lowToHighGateLabel`/`highToLowGateLabel` and `lowToHighGateColor`/`highToLowGateColor` each track their respective direction's gate label/color
   - In the collapse (lines 193-210): set `gateLabel`/`gateColor`/`hasScript` from `lowToHigh*` fields, and `reverseGateLabel`/`reverseGateColor`/`reverseHasScript` from `highToLow*` fields

**Acceptance criteria:**
- `SemanticWorkflowEdge` includes `gateLabel`, `gateColor`, `hasScript` and their `reverse*` counterparts
- Gates with `label` set propagate the label to the correct edge direction
- Gates without `label` return `undefined` (heuristic fallback applied in EdgeRenderer)
- Bidirectional edges with different gates on each direction correctly track both label/color pairs
- `PairAggregate` intermediate type fully tracks label/color/hasScript per direction
- Existing semantic graph tests pass (updated for new return type)

**Dependencies:** Task 1.1
**Agent type:** coder

---

### Task 4.2: Update EdgeRenderer to use gate label/color

**File:** `packages/web/src/components/space/visual-editor/EdgeRenderer.tsx`

**Subtasks:**
1. Add `gateLabel?: string`, `gateColor?: string`, `hasScript?: boolean` to `ResolvedWorkflowChannel` interface
2. Also add `reverseGateLabel?`, `reverseGateColor?`, `reverseHasScript?` for bidirectional edges
3. In the channel edge rendering section (around lines 749-756), update badge rendering:
   - Use `channel.gateColor ?? CHANNEL_GATE_BADGE_COLORS[effectiveGateType]` for the badge color
   - Use `channel.gateLabel ?? CHANNEL_GATE_BADGE_LABELS[effectiveGateType]` for the badge label
   - When `channel.hasScript` is true, add a small script icon (e.g., `</>` or terminal icon) next to the badge
4. Apply gate color to arrow polygon fills as well
5. No change to the loop badge (it is independent of gate configuration)

**Acceptance criteria:**
- Badge renders with custom label when `gateLabel` is set
- Badge renders with custom color when `gateColor` is set
- Heuristic labels/colors still work when custom ones are not set
- Arrow fills match the badge color (custom or heuristic)
- Script icon appears when `hasScript` is true
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
   - Show character count indicator (e.g., "3/20")
2. Add "Badge Color" color picker — placed next to label input or below it:
   - Use `<input type="color">` for hex color selection (natively produces `#rrggbb`)
   - `data-testid="gate-editor-color"`
   - Value bound to `gate.color ?? '#3b82f6'` (blue default)
   - On change: `updateGate({ color: value })`
   - Add a "Reset" button to clear the custom color and revert to heuristic
3. Show a preview of the badge with the current label and color next to the inputs

**Acceptance criteria:**
- Label input accepts up to 20 characters with count indicator
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
   - "Lint Check" — `bash` with `npm run lint 2>/dev/null; echo $?` → **Note:** exit code 0/1 as text is not valid JSON. The preset should be: `bash` with `npm run lint 2>/dev/null && echo '{"passed":true}' || echo '{"passed":false}'`
   - "Type Check" — `node` with `console.log(JSON.stringify({passed: true}))`
   - Presets help users understand the expected format (JSON stdout for data merging, exit code for pass/fail)

**Acceptance criteria:**
- Script section can be toggled on/off
- Interpreter dropdown shows three options
- Source textarea accepts multiline script code
- Timeout defaults to 30 and maxes at 120
- Preset buttons populate the form correctly with valid JSON-outputting scripts
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
3. Show a script indicator icon when the gate has a script check configured
4. No functional changes — just visual display of the gate's `label`, `color`, and `script` in the summary

**Acceptance criteria:**
- Gate summary shows custom label when set
- Gate summary shows color indicator when set
- Gate summary shows script icon when script is configured
- Gate summary falls back to standard display when not set

**Dependencies:** Task 4.3
**Agent type:** coder

---

### Task 4.6: Surface script error reason in frontend gate status UI

**File:** `packages/web/src/components/space/visual-editor/ChannelEdgeConfigPanel.tsx` (and/or `GateArtifactsView.tsx` if it exists)

**Subtasks:**
1. When a gate evaluation fails due to a script check, the `GateEvalResult.reason` field contains the error message (e.g., "Script check failed: <stderr output>")
2. In the channel edge config panel's gate summary, display the `reason` when the gate is blocked due to a script failure
3. Style the error reason distinctively (e.g., red text, warning icon) so users can see why their script check failed
4. For field-check failures, continue showing the existing behavior (no change)

**Acceptance criteria:**
- Script failure reason is visible in the gate status UI
- Error reason is styled distinctively from normal gate status text
- Field-check failures are unaffected
- Reason is shown in real-time as gate evaluations complete

**Dependencies:** Task 3.1 (for `reason` field in `GateEvalResult`), Task 4.5
**Agent type:** coder

---

### Task 4.7: Update visual editor tests for badge customization

**Files:**
- `packages/web/src/components/space/visual-editor/__tests__/semanticWorkflowGraph.test.ts`

**Subtasks:**
1. Update `semanticWorkflowGraph.test.ts`:
   - Add tests for gates with `label` set — verify `gateLabel` on semantic edge
   - Add tests for gates with `color` set — verify `gateColor` on semantic edge
   - Add tests for gates with `script` set — verify `hasScript` on semantic edge
   - Add tests for bidirectional edges where each direction has different gate label/color — verify both `gateLabel`/`reverseGateLabel` and `gateColor`/`reverseGateColor`
   - Add tests for gates without `label`/`color` — verify heuristic fallback (`gateLabel` is `undefined`, `gateColor` is `undefined`)
2. Verify backward compatibility in all tests

**Acceptance criteria:**
- All semantic graph tests pass including new label/color/hasScript tests
- Bidirectional edge tests cover both directions independently
- No regressions in existing tests

**Dependencies:** Task 4.1
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
2. Configure a simple `node` script (e.g., `console.log(JSON.stringify({ done: true }))`) — **use `node` interpreter only**, not `python3` or `bash`, to avoid CI environment dependency issues (`python3` may not be on PATH in all CI environments)
3. Trigger the gate evaluation (by sending a message through the gated channel)
4. Verify the gate opens when the script succeeds
5. Configure a failing script (e.g., `process.exit(1)`)
6. Verify the gate blocks when the script fails
7. Verify error message (from `stderr` or exit code) is shown in the frontend gate status UI

**Acceptance criteria:**
- E2E test passes against dev server
- Script execution result correctly opens/blocks the gate
- Error feedback is visible in the UI (leveraging Task 4.6)
- Test runs with `make run-e2e TEST=tests/features/space-gate-script-check.e2e.ts`
- Test only uses `node` interpreter (no `python3` dependency)

**Dependencies:** Task 3.2, Task 3.3, Task 4.4, Task 4.6
**Agent type:** coder

---

## Summary

| Milestone | Tasks | Key Deliverable |
|-----------|-------|-----------------|
| 1. Shared Type Changes | 1.1, 1.2, 1.3 | Gate interface with label, color, script; validation; persistence tests |
| 2. Script Execution Engine | 2.1, 2.2 | `gate-script-executor.ts` with Bun.spawn(), restricted env, deep merge |
| 3. Async Gate Evaluation | 3.1, 3.2, 3.3, 3.4, 3.5 | Async evaluateGate, per-gate coalescing+dirty-flag, ChannelRouter migration, workspacePath wiring |
| 4. Frontend Badge/Editor | 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7 | Custom badge rendering (bidirectional), label/color picker, script editor UI, error surfacing |
| 5. E2E Testing | 5.1, 5.2 | End-to-end tests for badge customization and script checks |

**Total tasks:** 17
**Critical path:** 1.1 → 1.2 → 2.1 → 3.1 → 3.2 → 3.3 → 3.4 (backend) and 1.1 → 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 (frontend), converging at 5.1 + 5.2

## Changes from v1 (reviewer feedback)

### P1 fixes
- **Task 4.1**: Now explicitly calls out `PairAggregate` intermediate type and the collapse logic as in-scope. Added `reverseGateLabel`/`reverseGateColor`/`reverseHasScript` for bidirectional edge support.
- **Task 1.1**: Added explicit subtask to update all `computeGateDefaults` call sites. Fixed AC to show correct signature change `(fields?: GateField[])`.
- **Task 3.2**: Added `workspacePath` to `ChannelRouterConfig` — critical missing piece.
- **New Task 3.3**: Dedicated task for wiring all four `ChannelRouter` construction sites with `workspacePath` and `scriptExecutor`, including the node-agent MCP server injection point.
- **New Task 4.6**: Surface script error reason in frontend gate status UI.

### P2 fixes
- **Task 3.1**: `isChannelOpen()` kept synchronous. Added explicit note that `WorkflowCanvas.tsx` has its own independent `evaluateGateStatus()` and is unaffected.
- **Task 3.2**: Per-gate evaluation queue now uses coalescing + re-run-if-dirty pattern (not just coalescing). Added global concurrency semaphore (default: 4) for cross-gate script limits.
- **Task 4.4**: Fixed "Lint Check" preset to output valid JSON (`{"passed":true}` / `{"passed":false}`) instead of bare exit code.
- **Task 5.2**: Added dependency on Task 4.4 (script editor UI) and Task 4.6 (error surfacing). Restricted E2E script tests to `node` interpreter only.

### P3 fixes
- Removed withdrawn CVE-2025-8022 citation. Replaced with plain-language security reasoning.
- Added `maxBuffer` streaming enforcement detail (chunk-by-chunk byte counting).
- Added restricted env threat model documentation (defense-in-depth for trusted scripts).
- Clarified `computeGateDefaults` signature change in Task 1.1 AC.
