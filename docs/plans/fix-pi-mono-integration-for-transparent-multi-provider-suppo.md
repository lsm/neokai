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

### Task 1: Add pi-coding-agent Dependency and Research API
**Agent:** coder

**Description:**
Add `@mariozechner/pi-coding-agent` to dependencies and research its API to understand the integration points.

**Implementation Steps:**
1. Add dependency: `bun add @mariozechner/pi-coding-agent` in `packages/daemon/`
2. Explore the package exports:
   - `createAgentSession` - main entry point
   - `SessionManager` - session lifecycle
   - `AuthStorage` - credential management
   - `ModelRegistry` - model configuration
   - Built-in tools availability
3. Document the API patterns and how they map to NeoKai's architecture

**Files to modify:**
- `packages/daemon/package.json` - add dependency

**Acceptance Criteria:**
- `@mariozechner/pi-coding-agent` added to dependencies
- API exploration documented in code comments or this plan
- Understand how `createAgentSession` yields messages compatible with NeoKai's `SDKMessage` format

---

### Task 2: Refactor pimono-adapter to Use pi-coding-agent
**Agent:** coder
**Depends on:** Task 1

**Description:**
Replace the low-level `pi-agent-core` Agent with `pi-coding-agent`'s `createAgentSession`.

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

New code (conceptual):
```typescript
import { createAgentSession } from '@mariozechner/pi-coding-agent';

const session = await createAgentSession({
    provider: 'github-copilot',  // or 'openai'
    model: modelId,
    cwd: options.cwd,
    systemPrompt: options.systemPrompt,
    tools: 'builtin',  // Use built-in coding tools
    // ... other config
});

// Iterate over session messages
for await (const message of session.messages()) {
    // Convert to SDKMessage format and yield
}
```

**Key Integration Points:**
1. Message format translation: `pi-coding-agent` messages → NeoKai `SDKMessage`
2. Streaming: Ensure text deltas stream correctly
3. Tool execution: Let `pi-coding-agent` handle it internally
4. Error handling: Map errors to NeoKai's error system

**Files to modify:**
- `packages/daemon/src/lib/providers/pimono-adapter.ts` - major refactor
- Possibly delete or simplify significantly

**Acceptance Criteria:**
- `pi-coding-agent`'s `createAgentSession` is used instead of `pi-agent-core`'s `Agent`
- Built-in tools work automatically (no manual tool executor needed)
- Message format is correctly translated to `SDKMessage`

---

### Task 3: Update OpenAI and GitHub Copilot Providers
**Agent:** coder
**Depends on:** Task 2

**Description:**
Update the provider implementations to use the refactored `pimono-adapter`.

Since the adapter will now use `pi-coding-agent`, the provider code should be simpler:
- Remove `undefined` tool executor parameter
- Let `pi-coding-agent` handle authentication via its `AuthStorage`
- Simplify the call signature

**Files to modify:**
- `packages/daemon/src/lib/providers/openai-provider.ts`
- `packages/daemon/src/lib/providers/github-copilot-provider.ts`

**Acceptance Criteria:**
- Providers use the refactored `pimono-adapter`
- No more `undefined` tool executor passed
- Authentication flows still work correctly

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
Task 1 (Add Dependency & Research)
    │
    └──→ Task 2 (Refactor Adapter)
              │
              └──→ Task 3 (Update Providers)
                        │
                        └──→ Task 4 (Unit Tests)
                                  │
                                  └──→ Task 5 (Integration Tests)
                                            │
                                            └──→ Task 6 (E2E Tests)
```

Tasks are sequential because each depends on the previous one being complete.

## Implementation Order

1. **Task 1** - Add dependency and research API
2. **Task 2** - Core refactor to use `pi-coding-agent`
3. **Task 3** - Update provider implementations
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
NeoKai AgentSession
    ↓
QueryRunner
    ↓
Provider.createQuery (OpenAI/Copilot)
    ↓
piMonoQueryGenerator (refactored)
    ↓
pi-coding-agent createAgentSession (high-level)
    ↓
Built-in tools work automatically!
```

### Key Differences

| Aspect | pi-agent-core (Current) | pi-coding-agent (Target) |
|--------|-------------------------|--------------------------|
| Level | Low-level framework | High-level coding SDK |
| Tools | Manual via callback | Built-in (read, bash, edit, etc.) |
| Session | Manual state management | SessionManager built-in |
| Auth | Manual | AuthStorage built-in |
| Complexity | High (we build everything) | Low (SDK handles it) |

### Message Format Translation

The `pi-coding-agent` likely has its own message format. We need to translate to NeoKai's `SDKMessage`:

```typescript
// Conceptual translation
function piCodingMessageToSdk(msg: PiCodingMessage): SDKMessage {
    switch (msg.type) {
        case 'text':
            return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: msg.content }] }, ... };
        case 'tool_use':
            return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: msg.id, name: msg.name, input: msg.input }] }, ... };
        // ... etc
    }
}
```

### Open Questions for Task 1

1. Does `pi-coding-agent` export an async generator or event emitter for messages?
2. What is the exact message format from `pi-coding-agent`?
3. How does `pi-coding-agent` handle streaming text deltas?
4. What configuration options does `createAgentSession` accept?
5. How do we map NeoKai's session ID to `pi-coding-agent`'s session system?
