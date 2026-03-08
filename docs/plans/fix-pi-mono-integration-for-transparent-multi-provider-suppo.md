# Fix Pi-Mono Integration for Transparent Multi-Provider Support

## Goal

Make the pi-mono path fully transparent under our agent session layer so we can use any provider/model it supports (GitHub Copilot, OpenAI, Google, etc.) just like we use Anthropic models today.

**Success Criteria:**
- Tool use works correctly with pi-mono backed providers
- Can seamlessly switch between Anthropic and pi-mono providers via config
- All provider-specific features are abstracted at the agent session layer

## Root Cause Analysis

Investigation revealed three critical issues preventing pi-mono tool use:

### Issue 1: Tools Not Passed to Custom Providers
**Location:** `packages/daemon/src/lib/agent/query-runner.ts:228`

```typescript
const customQueryOptions: ProviderQueryOptions = {
    // ...
    tools: [], // Tools are handled by SDK in standard mode; custom providers handle their own tools
};
```

The comment is misleading. Tools are hardcoded to an empty array, so pi-mono providers never receive tool definitions.

### Issue 2: No Tool Executor Callback
**Locations:**
- `packages/daemon/src/lib/providers/openai-provider.ts:317` - passes `undefined`
- `packages/daemon/src/lib/providers/github-copilot-provider.ts:265` - passes `undefined`

Both providers pass `undefined` as the `toolExecutor` parameter to `piMonoQueryGenerator()`. When pi-agent-core's Agent calls tools, it receives "No tool executor available" error.

### Issue 3: No Permission Handling Bridge
There's no mechanism to route tool permission checks from pi-mono to the `canUseTool` callback used by the SDK path. The SDK handles permissions via `options.canUseTool`, but pi-mono has no equivalent.

## Task Breakdown

### Task 1: Pass Tool Definitions to Custom Query Providers
**Agent:** coder

**Description:**
Extract tool definitions from SDK query options and pass them to custom query providers via `ProviderQueryOptions.tools`.

Currently in `query-runner.ts`:
```typescript
tools: [], // hardcoded empty
```

Need to:
1. Get available tools from the SDK options (via `optionsBuilder` or introspection)
2. Convert SDK tool format to `ToolDefinition[]` format
3. Populate `customQueryOptions.tools` with actual tool definitions

**Files to modify:**
- `packages/daemon/src/lib/agent/query-runner.ts`
- `packages/shared/src/provider/query-types.ts` (if ToolDefinition needs enhancement)

**Acceptance Criteria:**
- Tool definitions are extracted from SDK options and passed to custom providers
- `customQueryOptions.tools` contains actual tool definitions (not empty array)
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2: Implement Tool Execution Bridge for Pi-Mono
**Agent:** coder
**Depends on:** Task 1

**Description:**
Create a tool executor callback that routes tool execution from pi-mono to NeoKai's existing tool handlers.

The `piMonoQueryGenerator` function accepts a `ToolExecutionCallback` parameter:
```typescript
export type ToolExecutionCallback = (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string
) => Promise<{ output: unknown; isError: boolean }>;
```

Need to:
1. Create a tool executor in `QueryRunner` that can execute tools via NeoKai's existing infrastructure
2. Pass this executor through the provider's `createQuery` method
3. Update `Provider.createQuery` signature to accept the tool executor
4. Update `piMonoQueryGenerator` calls in providers to use the provided executor

**Files to modify:**
- `packages/daemon/src/lib/agent/query-runner.ts`
- `packages/shared/src/provider/types.ts` (add toolExecutor to createQuery context)
- `packages/shared/src/provider/query-types.ts` (extend ProviderQueryContext)
- `packages/daemon/src/lib/providers/pimono-adapter.ts`
- `packages/daemon/src/lib/providers/openai-provider.ts`
- `packages/daemon/src/lib/providers/github-copilot-provider.ts`

**Acceptance Criteria:**
- Tool executor callback is created and passed through the provider chain
- When pi-agent-core Agent calls a tool, it executes via NeoKai's tool handlers
- Tool results are properly returned to the pi-agent-core Agent
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 3: Implement Permission Handling for Pi-Mono Tools
**Agent:** coder
**Depends on:** Task 2

**Description:**
Integrate the `canUseTool` permission callback with the pi-mono tool execution flow.

The SDK path uses `options.canUseTool` callback for permission prompts. The pi-mono path needs equivalent handling:
1. Pass `canUseTool` callback to the tool executor
2. Check permissions before executing tools
3. Handle permission denials gracefully

**Files to modify:**
- `packages/daemon/src/lib/agent/query-runner.ts`
- `packages/shared/src/provider/query-types.ts`
- `packages/daemon/src/lib/providers/pimono-adapter.ts`

**Acceptance Criteria:**
- Tool permission checks work for pi-mono providers
- Permission denials are communicated back to the agent
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 4: Fix Input Schema Conversion in convertToAgentTools
**Agent:** coder
**Depends on:** Task 1

**Description:**
The current schema conversion in `pimono-adapter.ts` uses a generic "any object" schema:
```typescript
parameters: Type.Record(Type.String(), Type.Any()) as unknown as TSchema,
```

This loses the actual input schema from `ToolDefinition.inputSchema`. Need to properly convert JSON Schema to pi-ai's `TSchema` format.

**Files to modify:**
- `packages/daemon/src/lib/providers/pimono-adapter.ts`

**Acceptance Criteria:**
- Tool input schemas are properly converted to pi-ai TSchema format
- LLMs receive accurate parameter schemas for tools
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 5: Add Unit Tests for Pi-Mono Tool Execution
**Agent:** coder
**Depends on:** Task 2, Task 3, Task 4

**Description:**
Create comprehensive unit tests for the pi-mono tool execution path.

**Test coverage:**
- Tool definition extraction and passing
- Tool executor callback invocation
- Permission handling
- Schema conversion
- Error handling

**Files to create/modify:**
- `packages/daemon/tests/unit/providers/pimono-adapter.test.ts`
- `packages/daemon/tests/unit/agent/query-runner-custom-provider.test.ts`

**Acceptance Criteria:**
- Unit tests cover all pi-mono tool execution paths
- Tests pass with >80% coverage on modified code
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 6: Add Online Integration Tests for Pi-Mono Providers
**Agent:** coder
**Depends on:** Task 5

**Description:**
Create online integration tests that verify end-to-end tool execution with pi-mono providers (OpenAI, GitHub Copilot).

These tests should:
1. Use mock mode by default (NEOKAI_TEST_ONLINE=false)
2. Support real API testing with NEOKAI_TEST_ONLINE=true
3. Test actual tool calling and execution

**Files to create/modify:**
- `packages/daemon/tests/online/pimono-tool-execution.test.ts`

**Acceptance Criteria:**
- Integration tests verify tool execution works end-to-end
- Mock mode tests run in CI
- Real API tests can be run manually for verification
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

## Dependency Graph

```
Task 1 (Tool Definitions)
    ├── Task 2 (Tool Executor) ──┐
    │       ├── Task 3 (Permissions)
    │       └── Task 4 (Schema Conversion)
    └── Task 5 (Unit Tests)
            └── Task 6 (Integration Tests)
```

Tasks 2, 3, 4 can run in parallel after Task 1 completes.
Task 5 depends on Tasks 2, 3, 4.
Task 6 depends on Task 5.

## Implementation Order

1. **Task 1** - Foundation: Pass tool definitions to custom providers
2. **Tasks 2, 3, 4** (parallel) - Core implementation
3. **Task 5** - Unit tests for all core changes
4. **Task 6** - Integration tests

## Technical Notes

### Provider Interface Changes

The `Provider.createQuery` method may need to accept additional context:

```typescript
createQuery?(
    prompt: AsyncGenerator<SDKUserMessage>,
    options: ProviderQueryOptions,
    context: ProviderQueryContext & {
        toolExecutor?: ToolExecutionCallback;
        canUseTool?: CanUseToolCallback;
    }
): Promise<AsyncGenerator<SDKMessage> | null>;
```

### Tool Definition Sources

Tool definitions can be sourced from:
1. SDK's built-in tools (from `options.tools` preset)
2. MCP server tools
3. Custom agent tools

The `QueryOptionsBuilder` constructs the full tool set - we need to extract this for pi-mono.

### Pi-AI Schema Conversion

Pi-ai uses TypeBox for schemas (`Type.*` builders). We need to convert JSON Schema to TypeBox format. Options:
1. Use `Type.Unsafe()` to wrap existing JSON Schema
2. Implement a proper converter
3. Use a library like `json-schema-to-typescript` concepts
