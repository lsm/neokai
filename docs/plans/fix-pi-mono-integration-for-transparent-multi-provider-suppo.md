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

**Implementation Approach:**

The SDK's `queryOptions` object (built by `QueryOptionsBuilder`) contains:
- `options.tools` - preset string like 'BashReadEditFiles' or array of tool names
- `options.allowedTools` - tools to auto-approve
- `options.disallowedTools` - tools to block

However, the SDK doesn't expose the actual tool definitions with schemas - it handles tool registration internally. We have two options:

**Option A (Recommended): Hardcode tool definitions from SDK's built-in presets**
Create a `ToolDefinitions` module that maps tool names to their JSON Schema definitions, matching what the SDK uses internally. This is maintainable because the SDK's built-in tools are stable.

```typescript
// packages/shared/src/provider/builtin-tools.ts
export const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
    Read: { name: 'Read', description: '...', inputSchema: { type: 'object', properties: {...} } },
    Bash: { name: 'Bash', description: '...', inputSchema: { type: 'object', properties: {...} } },
    // ...
};
```

**Option B: Fetch tools from SDK subprocess**
Query the SDK for available tools at startup. This is more dynamic but adds complexity and startup latency.

We'll use **Option A** - it's simpler, more reliable, and the SDK tools rarely change.

**Files to modify:**
- `packages/daemon/src/lib/agent/query-runner.ts` - import tool definitions and pass to `customQueryOptions`
- `packages/shared/src/provider/builtin-tools.ts` (NEW) - tool definitions with JSON Schemas
- `packages/shared/src/provider/query-types.ts` - ensure `ToolDefinition` type is complete

**Acceptance Criteria:**
- Tool definitions are extracted from a lookup table matching SDK's built-in tools
- `customQueryOptions.tools` contains actual tool definitions (not empty array)
- Only tools allowed by `allowedTools`/`disallowedTools` are included

---

### Task 2: Implement Tool Execution Bridge for Pi-Mono
**Agent:** coder
**Depends on:** Task 1

**Description:**
Create a tool executor callback that routes tool execution from pi-mono to the SDK's subprocess for actual execution.

**Implementation Approach:**

The SDK handles tool execution internally via a subprocess. For pi-mono providers, we need to execute tools ourselves since pi-agent-core's Agent only calls our callback. The key insight is:

**NeoKai's "existing infrastructure" = the SDK subprocess itself**

When using pi-mono, we still spawn an SDK subprocess (via `query()`) but use it ONLY for tool execution, not for LLM calls. The architecture becomes:

```
pi-mono (LLM) → toolExecutor callback → SDK subprocess (tool execution) → result → pi-mono
```

However, this approach is complex. A simpler approach:

**Simpler Approach: Direct tool execution via SDK's tool implementations**

The SDK exports tool implementations we can call directly. We'll:

1. Import tool implementations from SDK (or recreate them in NeoKai)
2. Create a `ToolExecutor` class that:
   - Receives tool name, input, and toolUseId
   - Validates against `allowedTools`/`disallowedTools`
   - Calls `canUseTool` callback for permission
   - Executes the tool
   - Returns `{ output, isError }`

**Implementation:**

```typescript
// packages/daemon/src/lib/agent/tool-executor.ts
export class ToolExecutor {
    constructor(
        private ctx: {
            canUseTool?: CanUseTool;
            allowedTools?: string[];
            disallowedTools?: string[];
            cwd: string;
        }
    ) {}

    async execute(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<{
        output: unknown;
        isError: boolean;
    }> {
        // 1. Check disallowed
        // 2. Call canUseTool for permission
        // 3. Execute tool
        // 4. Return result
    }
}
```

**Files to modify:**
- `packages/daemon/src/lib/agent/tool-executor.ts` (NEW) - ToolExecutor class
- `packages/daemon/src/lib/agent/query-runner.ts` - create ToolExecutor, pass to provider
- `packages/shared/src/provider/types.ts` - add `toolExecutor` to `createQuery` context
- `packages/shared/src/provider/query-types.ts` - extend `ProviderQueryContext`
- `packages/daemon/src/lib/providers/openai-provider.ts` - use passed toolExecutor
- `packages/daemon/src/lib/providers/github-copilot-provider.ts` - use passed toolExecutor

**Acceptance Criteria:**
- `ToolExecutor` class created with execute method
- Tool executor is passed through `ProviderQueryContext` to providers
- `piMonoQueryGenerator` receives and uses the tool executor
- When pi-agent-core Agent calls a tool, it executes via ToolExecutor

---

### Task 3: Implement Permission Handling for Pi-Mono Tools
**Agent:** coder
**Depends on:** Task 2

**Description:**
Integrate the `canUseTool` permission callback with the pi-mono tool execution flow.

**Implementation Approach:**

The permission check will happen **inside** the `ToolExecutor.execute()` method, **before** executing the tool:

```typescript
async execute(toolName: string, input: Record<string, unknown>, toolUseId: string) {
    // 1. Check disallowed tools list (deny without asking)
    if (this.ctx.disallowedTools?.some(d => matchesPattern(d, toolName))) {
        return { output: `Tool ${toolName} is disallowed`, isError: true };
    }

    // 2. Check allowed tools list (auto-approve)
    const isAllowed = this.ctx.allowedTools?.some(a => matchesPattern(a, toolName));

    // 3. If not auto-approved, call canUseTool for user permission
    if (!isAllowed && this.ctx.canUseTool) {
        const permission = await this.ctx.canUseTool({ toolName, input, toolUseId });
        if (!permission.allowed) {
            return { output: `Tool ${toolName} permission denied`, isError: true };
        }
    }

    // 4. Execute the tool
    return this.executeToolInternal(toolName, input);
}
```

The `canUseTool` callback is already created by `AskUserQuestionHandler.createCanUseToolCallback()` and passed to `QueryOptionsBuilder`. We'll pass it through to `ToolExecutor`.

**Files to modify:**
- `packages/daemon/src/lib/agent/tool-executor.ts` - add permission logic
- `packages/daemon/src/lib/agent/query-runner.ts` - pass canUseTool to ToolExecutor

**Acceptance Criteria:**
- Tools in `disallowedTools` are blocked without user prompt
- Tools in `allowedTools` are auto-approved
- Other tools trigger `canUseTool` callback for user permission
- Permission denials are returned as error results to pi-agent-core

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

**Recommended Approach: Use `Type.Unsafe()`**

TypeBox's `Type.Unsafe()` allows wrapping existing JSON Schema without conversion:

```typescript
import { Type } from '@mariozechner/pi-ai';

export function jsonSchemaToTSchema(schema: Record<string, unknown>): TSchema {
    // Type.Unsafe preserves the original JSON Schema
    return Type.Unsafe(schema) as unknown as TSchema;
}
```

This is the simplest approach and maintains full schema fidelity. The pi-ai library will pass the schema through to the LLM unchanged.

**Alternative Considered: Full conversion to TypeBox**
Converting JSON Schema to TypeBox's builder format (`Type.Object({ ... })`) is complex and error-prone for nested schemas. Not recommended.

**Files to modify:**
- `packages/daemon/src/lib/providers/pimono-adapter.ts` - update `convertToAgentTools`

**Acceptance Criteria:**
- `convertToAgentTools` uses `Type.Unsafe()` to wrap `inputSchema`
- LLMs receive accurate parameter schemas with proper types, descriptions, and constraints

---

### Task 5: Add Unit Tests for Pi-Mono Tool Execution
**Agent:** coder
**Depends on:** Task 2, Task 3, Task 4

**Description:**
Create comprehensive unit tests for the pi-mono tool execution path.

**Mock Strategy:**

Following the existing test patterns in `packages/daemon/tests/unit/`, we'll:

1. **Mock pi-agent-core's Agent class** - Instead of using the real Agent, create a mock that:
   - Accepts the same configuration
   - Simulates tool calls by invoking the `execute` callback
   - Returns predetermined responses

```typescript
// In test setup
vi.mock('@mariozechner/pi-agent-core', () => ({
    Agent: vi.fn().mockImplementation((config) => ({
        subscribe: vi.fn((callback) => {
            // Simulate tool call event
            config.initialState.tools[0].execute('call-123', { path: '/test' });
            callback({ type: 'tool_execution_start', toolName: 'Read', toolCallId: 'call-123' });
            callback({ type: 'tool_execution_end', toolName: 'Read', toolCallId: 'call-123' });
            return vi.fn(); // unsubscribe
        }),
        prompt: vi.fn(),
        abort: vi.fn(),
    })),
}));
```

2. **Mock @mariozechner/pi-ai's getModel** - Return a minimal mock model:
```typescript
vi.mock('@mariozechner/pi-ai', () => ({
    getModel: vi.fn(() => ({ id: 'test-model', contextWindow: 128000, maxTokens: 4096 })),
    Type: { Unsafe: vi.fn((s) => s) },
}));
```

**Test coverage:**
- `convertToAgentTools` schema conversion
- `sdkToAgentMessage` message translation
- `ToolExecutor` permission checking and execution
- `piMonoQueryGenerator` event handling and message yielding

**Files to create:**
- `packages/daemon/tests/unit/providers/pimono-adapter.test.ts`
- `packages/daemon/tests/unit/agent/tool-executor.test.ts`

**Acceptance Criteria:**
- Unit tests cover all pi-mono tool execution paths
- Tests mock pi-agent-core and pi-ai as described
- Tests pass with >80% coverage on modified code

---

### Task 6: Add Online Integration Tests for Pi-Mono Providers
**Agent:** coder
**Depends on:** Task 5

**Description:**
Create online integration tests that verify end-to-end tool execution with pi-mono providers.

**Test Strategy:**

Follow the existing pattern in `packages/daemon/tests/online/`:
- Mock mode by default (`NEOKAI_TEST_ONLINE=false` or unset)
- Real API mode with `NEOKAI_TEST_ONLINE=true`

**Mock Mode Implementation:**

When not running online tests, mock the HTTP layer:
```typescript
// Mock fetch for OpenAI/GitHub Copilot API calls
global.fetch = vi.fn().mockImplementation(async (url) => {
    if (url.includes('api.openai.com')) {
        return new Response(JSON.stringify({
            choices: [{ message: { content: 'Mock response' } }]
        }));
    }
    // ...
});
```

**Test Scenarios:**
1. Tool definition passing to provider
2. Tool execution with permission approval
3. Tool execution with permission denial
4. Multi-turn tool calling
5. Error handling (API errors, tool errors)

**Files to create:**
- `packages/daemon/tests/online/pimono-tool-execution.test.ts`

**Acceptance Criteria:**
- Integration tests verify tool execution works end-to-end
- Mock mode tests run in CI
- Real API tests can be run manually for verification

---

### Task 7: Add E2E Tests for Pi-Mono Provider Tool Use
**Agent:** coder
**Depends on:** Task 6

**Description:**
Add Playwright E2E tests to verify the full user flow works with pi-mono providers.

**Test Scenarios:**
1. Create a session with GitHub Copilot provider
2. Send a message that triggers tool use
3. Verify tool execution appears in UI
4. Verify agent response includes tool results

**Mock Strategy for E2E:**

Since E2E tests run against a real server, we'll:
1. Use a mock provider configuration that simulates pi-mono behavior
2. Or use a test API key stored securely in CI environment variables
3. Focus on the UI flow rather than actual LLM responses

**Files to create:**
- `packages/e2e/tests/features/pimono-tool-use.e2e.ts`

**Acceptance Criteria:**
- E2E test covers session creation with pi-mono provider
- E2E test verifies tool use UI flow works correctly
- Test runs in CI with mocked provider or test credentials

---

## Dependency Graph

```
Task 1 (Tool Definitions)
    ├── Task 2 (Tool Executor) ──→ Task 3 (Permissions)
    │              │
    │              └──→ Task 4 (Schema Conversion)
    │                        │
    └────────────────────────┴──→ Task 5 (Unit Tests)
                                          │
                                          └──→ Task 6 (Integration Tests)
                                                    │
                                                    └──→ Task 7 (E2E Tests)
```

- Tasks 2, 3, 4 can run in parallel after Task 1 completes
- Task 5 requires Tasks 2, 3, 4 to be complete
- Task 6 requires Task 5
- Task 7 requires Task 6

## Implementation Order

1. **Task 1** - Foundation: Pass tool definitions to custom providers
2. **Tasks 2, 3, 4** (parallel) - Core implementation
3. **Task 5** - Unit tests for all core changes
4. **Task 6** - Integration tests
5. **Task 7** - E2E tests

## Technical Notes

### Provider Interface Changes

The `Provider.createQuery` method will accept additional context via `ProviderQueryContext`:

```typescript
interface ProviderQueryContext {
    signal: AbortSignal;
    sessionId: string;
    // NEW additions:
    toolExecutor?: ToolExecutionCallback;
    allowedTools?: string[];
    disallowedTools?: string[];
}
```

### Tool Definition Sources

Tool definitions will be sourced from a new `builtin-tools.ts` module that maps tool names to their JSON Schema definitions, matching what the SDK uses internally.

### Permission Flow

```
pi-agent-core calls tool
    ↓
ToolExecutor.execute(toolName, input, toolUseId)
    ↓
Check disallowedTools → deny if matches
    ↓
Check allowedTools → approve if matches
    ↓
Call canUseTool({ toolName, input }) → user decision
    ↓
Execute tool → return result
    ↓
Result passed back to pi-agent-core
```

### Schema Conversion

Using `Type.Unsafe()` from TypeBox to wrap existing JSON Schema without conversion - maintains full schema fidelity with minimal code.
