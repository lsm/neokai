# Fix Pi-Mono Integration for Transparent Multi-Provider Support

## Goal

Make the pi-mono path fully transparent under our agent session layer so we can use any provider/model it supports (GitHub Copilot, OpenAI, Google, etc.) just like we use Anthropic models today.

**Success Criteria:**
- Tool use works correctly with pi-mono backed providers
- Can seamlessly switch between Anthropic and pi-mono providers via config
- All provider-specific features are abstracted at the agent session layer

## Root Cause Analysis

### The Real Problem: Using the Wrong Layer

**Current (Wrong) Approach:**
- Uses `@mariozechner/pi-agent-core` - the **low-level** agent framework
- Imports `Agent` class and manually handles tool execution via `ToolExecutionCallback`
- We're building custom tool execution infrastructure from scratch
- Located in: `/packages/daemon/src/lib/providers/pimono-adapter.ts`

**Correct Approach:**
- Should use `@mariozechner/pi-coding-agent` - the **high-level** coding agent SDK
- Provides `createAgentSession` with built-in tool handling
- Has SessionManager, AuthStorage, ModelRegistry
- Built-in tools: read, bash, edit, write, grep, find, ls
- **Tools are already implemented and working!**

### Current Dependencies (package.json)
```json
"@mariozechner/pi-ai": "^0.57.1",
"@mariozechner/pi-agent-core": "^0.57.1"
// MISSING: "@mariozechner/pi-coding-agent"
```

### Why Tools Don't Work Now

The `pimono-adapter.ts` creates an `Agent` from `pi-agent-core` but passes `undefined` for the tool executor:

```typescript
// openai-provider.ts:317 and github-copilot-provider.ts:265
return piMonoQueryGenerator(
    prompt, options, context, 'openai', modelId,
    undefined  // <-- No tool executor!
);
```

We were trying to build tool execution infrastructure, but `pi-coding-agent` already has this built-in.

## Task Breakdown

### Task 1: Add pi-coding-agent Dependency and Research API with Proof-of-Concept
**Agent:** coder

**Description:**
Add `@mariozechner/pi-coding-agent` to dependencies, research its API, and create a proof-of-concept to verify the integration works before full migration.

**Implementation Steps:**

**Step 1: Add Dependency**
```bash
cd packages/daemon && bun add @mariozechner/pi-coding-agent
```

**Step 2: Create Proof-of-Concept**
Create a minimal test file that verifies:
- `createAgentSession` can be called successfully
- Messages can be iterated via async generator
- Built-in tools are available and work
- Message format can be translated to `SDKMessage`

```typescript
// packages/daemon/tests/unit/providers/pi-coding-agent-poc.test.ts
import { createAgentSession } from '@mariozechner/pi-coding-agent';

describe('pi-coding-agent PoC', () => {
    it('should create session and iterate messages', async () => {
        // Mock the HTTP layer to avoid real API calls
        const session = await createAgentSession({
            provider: 'github-copilot',
            model: 'gpt-4',
            cwd: '/tmp/test',
            systemPrompt: 'You are a helpful assistant.',
            // Verify correct config option name for tools
        });

        const messages = [];
        for await (const msg of session.messages()) {
            messages.push(msg);
            if (messages.length >= 3) break; // Just verify first few
        }

        expect(messages.length).toBeGreaterThan(0);
    });
});
```

**Step 3: Document API Findings**
Update this plan or add code comments with answers to:
1. Does `pi-coding-agent` export an async generator or event emitter for messages?
2. What is the exact message format from `pi-coding-agent`?
3. How does `pi-coding-agent` handle streaming text deltas?
4. What configuration options does `createAgentSession` accept? (Verify if `tools: 'builtin'` is correct)
5. How do we map NeoKai's session ID to `pi-coding-agent`'s session system?
6. How does `pi-coding-agent` handle MCP server tools? (Can they be passed through?)
7. Does `pi-coding-agent` have its own permission system, or can we integrate ours?

**Files to modify:**
- `packages/daemon/package.json` - add dependency
- `packages/daemon/tests/unit/providers/pi-coding-agent-poc.test.ts` (NEW) - proof-of-concept

**Acceptance Criteria:**
- `@mariozechner/pi-coding-agent` added to dependencies
- Proof-of-concept test passes (with mocked HTTP)
- API exploration documented
- All 7 open questions answered

---

### Task 2: Refactor pimono-adapter to Use pi-coding-agent
**Agent:** coder
**Depends on:** Task 1

**Description:**
Replace the low-level `pi-agent-core` Agent with `pi-coding-agent`'s `createAgentSession`.

**Migration Strategy: Complete Rewrite**

The existing `pimono-adapter.ts` is ~800 lines with significant complexity. Given the architectural change, we will:

1. **Create a new adapter file** (`pimono-adapter-v2.ts`) using `pi-coding-agent`
2. **Keep the old file** temporarily for reference (rename to `pimono-adapter.deprecated.ts`)
3. **Delete old file** after Task 3 proves the new adapter works

This approach:
- Allows easy rollback if issues arise
- Provides reference during migration
- Results in cleaner code (not a gradual refactor of fundamentally wrong architecture)

**Implementation Approach:**

Current code:
```typescript
import { Agent } from '@mariozechner/pi-agent-core';

const agent = new Agent({
    initialState: { model, tools, messages, ... },
    sessionId,
    getApiKey,
});
await agent.prompt(messages);
```

New code (exact config TBD in Task 1):
```typescript
import { createAgentSession } from '@mariozechner/pi-coding-agent';

const session = await createAgentSession({
    provider: provider,  // 'github-copilot' or 'openai'
    model: modelId,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    // tools config TBD based on Task 1 findings
    // (may be 'builtin', or an array, or a different option)
    sessionId: context.sessionId,  // Map NeoKai session ID
});

// Iterate over session messages
for await (const message of session.messages()) {
    const sdkMessage = translateToSDKMessage(message, context.sessionId);
    yield sdkMessage;
}
```

**Key Integration Points:**
1. Message format translation: `pi-coding-agent` messages → NeoKai `SDKMessage`
2. Streaming: Ensure text deltas stream correctly
3. Tool execution: Let `pi-coding-agent` handle it internally
4. Error handling: Map errors to NeoKai's error system

**Files to modify:**
- `packages/daemon/src/lib/providers/pimono-adapter.ts` → rename to `pimono-adapter.deprecated.ts`
- `packages/daemon/src/lib/providers/pimono-adapter.ts` (NEW) - fresh implementation

**Acceptance Criteria:**
- `pi-coding-agent`'s `createAgentSession` is used instead of `pi-agent-core`'s `Agent`
- Built-in tools work automatically (no manual tool executor needed)
- Message format is correctly translated to `SDKMessage`
- Old adapter preserved as `.deprecated.ts` for reference

---

### Task 3: Update OpenAI and GitHub Copilot Providers
**Agent:** coder
**Depends on:** Task 2

**Description:**
Update the provider implementations to use the refactored `pimono-adapter`.

Since the adapter will now use `pi-coding-agent`, the provider code should be simpler:
- Remove `undefined` tool executor parameter
- Let `pi-coding-agent` handle authentication via its `AuthStorage` OR keep NeoKai's auth (see below)
- Simplify the call signature

**NeoKai Tool Integration Questions (Answered in Task 1, Implemented Here):**

**MCP Server Tools:**
- If `pi-coding-agent` supports custom tools: Pass MCP tools through
- If not: MCP tools will only work with Anthropic SDK path (document this limitation)

**Permission System (`canUseTool`):**
- If `pi-coding-agent` has its own permission callback: Use it
- If not: We'll need to wrap the tool execution to add our permission layer

**Current assessment (to verify in Task 1):**
Most likely, `pi-coding-agent` handles tool execution internally without exposing a permission hook. In that case, we have two options:
1. **Accept pi-coding-agent's built-in behavior** - simpler, but loses NeoKai's permission UI
2. **Configure pi-coding-agent with `autoApprove: false`** (if supported) and handle permissions

**Session Management:**
NeoKai's session management (`AgentSession`, `SessionManager`) wraps the provider layer. We will:
- Keep NeoKai's session management as the outer layer
- Pass NeoKai's `sessionId` to `pi-coding-agent` for correlation
- `pi-coding-agent`'s internal session management is an implementation detail

Architecture:
```
NeoKai Session (outer layer - our management)
    ↓
pi-coding-agent session (inner layer - for tool execution)
```

We do NOT need to use `pi-coding-agent`'s `SessionManager` - NeoKai already has one.

**Files to modify:**
- `packages/daemon/src/lib/providers/openai-provider.ts`
- `packages/daemon/src/lib/providers/github-copilot-provider.ts`
- `packages/daemon/src/lib/providers/pimono-adapter.deprecated.ts` - DELETE after providers work

**Acceptance Criteria:**
- Providers use the refactored `pimono-adapter`
- No more `undefined` tool executor passed
- Authentication flows still work correctly
- MCP tools work OR limitation is documented
- Permission system works OR acceptable alternative documented
- Old deprecated adapter deleted

---

### Task 4: Add Unit Tests for Refactored Pi-Mono Adapter
**Agent:** coder
**Depends on:** Task 2, Task 3

**Description:**
Create unit tests for the refactored `pimono-adapter` using `pi-coding-agent`.

**Mock Strategy:**

Mock `pi-coding-agent` at the module level:
```typescript
vi.mock('@mariozechner/pi-coding-agent', () => ({
    createAgentSession: vi.fn(async (config) => ({
        messages: vi.fn(async function* () {
            yield { type: 'text', content: 'Hello' };
            yield { type: 'tool_use', name: 'Read', input: { path: '/test' } };
            yield { type: 'tool_result', output: 'file contents' };
        }),
        abort: vi.fn(),
    })),
}));
```

**Test Coverage:**
- Session creation with correct config
- Message format translation to SDKMessage
- Tool execution (verify it's handled by pi-coding-agent)
- Error handling
- Abort signal handling

**Files to create:**
- `packages/daemon/tests/unit/providers/pimono-adapter.test.ts`

**Acceptance Criteria:**
- Unit tests cover main code paths
- Tests mock `pi-coding-agent` appropriately
- Tests pass with >80% coverage on modified code

---

### Task 5: Add Online Integration Tests
**Agent:** coder
**Depends on:** Task 4

**Description:**
Create integration tests that verify end-to-end tool execution with pi-mono providers.

**Test Strategy:**
- Mock mode by default (mock HTTP requests)
- Real API mode with `NEOKAI_TEST_ONLINE=true`
- Test actual tool calling and execution flow

**Test Scenarios:**
1. Create session with pi-mono provider
2. Send message that triggers tool use
3. Verify tool is executed and results returned
4. Verify multi-turn conversation works
5. Verify permission system works (if applicable)

**Files to create:**
- `packages/daemon/tests/online/pimono-tool-execution.test.ts`

**Acceptance Criteria:**
- Integration tests verify tool execution works end-to-end
- Mock mode tests run in CI
- Real API tests can be run manually

---

### Task 6: Add E2E Tests for Pi-Mono Provider Tool Use
**Agent:** coder
**Depends on:** Task 5

**Description:**
Add Playwright E2E tests to verify the full user flow works with pi-mono providers.

**Test Scenarios:**
1. Create session with GitHub Copilot/OpenAI provider
2. Send message that triggers tool use (e.g., "read package.json")
3. Verify tool execution appears in UI
4. Verify agent response includes tool results

**Files to create:**
- `packages/e2e/tests/features/pimono-tool-use.e2e.ts`

**Acceptance Criteria:**
- E2E test covers session creation with pi-mono provider
- E2E test verifies tool use UI flow works correctly
- Test runs in CI (with mocked provider or test credentials)

---

## Dependency Graph

```
Task 1 (Add Dependency & PoC)
    │
    └──→ Task 2 (Refactor Adapter - Complete Rewrite)
              │
              └──→ Task 3 (Update Providers + Delete Old Code)
                        │
                        └──→ Task 4 (Unit Tests)
                                  │
                                  └──→ Task 5 (Integration Tests)
                                            │
                                            └──→ Task 6 (E2E Tests)
```

Tasks are sequential because each depends on the previous one being complete.

## Implementation Order

1. **Task 1** - Add dependency, create PoC, document API findings
2. **Task 2** - Core refactor to use `pi-coding-agent` (complete rewrite, keep old as `.deprecated.ts`)
3. **Task 3** - Update providers, verify MCP tools and permissions, delete deprecated code
4. **Task 4** - Unit tests
5. **Task 5** - Integration tests
6. **Task 6** - E2E tests

## Technical Notes

### Architecture Before (Wrong)

```
NeoKai AgentSession
    ↓
QueryRunner
    ↓
Provider.createQuery (OpenAI/Copilot)
    ↓
piMonoQueryGenerator
    ↓
pi-agent-core Agent (low-level)
    ↓
ToolExecutionCallback → undefined (BROKEN!)
```

### Architecture After (Correct)

```
NeoKai Session (NeoKai's session management - OUTER LAYER)
    ↓
NeoKai AgentSession
    ↓
QueryRunner
    ↓
Provider.createQuery (OpenAI/Copilot)
    ↓
piMonoQueryGenerator (refactored)
    ↓
pi-coding-agent createAgentSession (INNER session for tools)
    ↓
Built-in tools work automatically!
```

**Session Layers:**
- NeoKai's session management is the outer layer (we keep this)
- pi-coding-agent's session is an implementation detail (inner layer)

### Key Differences

| Aspect | pi-agent-core (Current) | pi-coding-agent (Target) |
|--------|-------------------------|--------------------------|
| Level | Low-level framework | High-level coding SDK |
| Tools | Manual via callback | Built-in (read, bash, edit, etc.) |
| Session | Manual state management | SessionManager built-in (but we use our own) |
| Auth | Manual | AuthStorage built-in (we may use ours instead) |
| Complexity | High (we build everything) | Low (SDK handles it) |
| MCP Tools | Would need manual integration | TBD (verify in Task 1) |
| Permissions | Would need manual callback | TBD (verify in Task 1) |

### Migration Strategy

| Phase | Action |
|-------|--------|
| Task 1 | Add new dependency, create PoC, answer questions |
| Task 2 | Create new adapter (keep old as `.deprecated.ts`) |
| Task 3 | Update providers, verify everything works, delete deprecated |
| Task 4-6 | Testing |

### Open Questions (Answered in Task 1)

1. Does `pi-coding-agent` export an async generator or event emitter for messages?
2. What is the exact message format from `pi-coding-agent`?
3. How does `pi-coding-agent` handle streaming text deltas?
4. What configuration options does `createAgentSession` accept? **(Verify if `tools: 'builtin'` is correct or if it's an array/object)**
5. How do we map NeoKai's session ID to `pi-coding-agent`'s session system?
6. **How does `pi-coding-agent` handle MCP server tools? Can they be passed through?**
7. **Does `pi-coding-agent` have its own permission system, or can we integrate our `canUseTool` callback?**
