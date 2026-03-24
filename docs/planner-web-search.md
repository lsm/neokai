# Planner Web Search Capability

The Planner agent and its plan-writer sub-agent have built-in access to web search tools. This document records the current state to prevent accidental regression.

## Current State

Both agents have `WebFetch` and `WebSearch` in their active tool lists.

### Planner Agent

Defined in `packages/daemon/src/lib/room/agents/planner-agent.ts` — `createPlannerAgentInit()`:

```typescript
const plannerAgentDef: AgentDefinition = {
    // ...
    tools: [
        'Task',
        'TaskOutput',
        'TaskStop',
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Grep',
        'Glob',
        'WebFetch',   // ✅ Present
        'WebSearch',  // ✅ Present
    ],
    // ...
};
```

### Plan-Writer Sub-Agent

Defined in `packages/daemon/src/lib/room/agents/planner-agent.ts` — `buildPlanWriterAgentDef()`:

```typescript
return {
    description: 'Plan writer...',
    tools: [
        'Task',
        'TaskOutput',
        'TaskStop',
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Grep',
        'Glob',
        'WebFetch',   // ✅ Present
        'WebSearch',  // ✅ Present
    ],
    model: 'inherit',
    prompt,
};
```

## Tool Reference

### WebSearch

- **Use for**: Broad queries that require up-to-date information from the internet.
- **When to use**: Finding current documentation versions, checking npm package latest releases, searching for error messages, looking up API changes, researching library compatibility.
- **Example prompts**: "What is the latest version of Next.js?", "How do I configure ESLint for TypeScript projects?"

### WebFetch

- **Use for**: Reading the content of a specific URL.
- **When to use**: Reading npm package pages (registry.npmjs.org), GitHub release notes, specific documentation pages, changelogs, API references.
- **Example URLs**: `https://www.npmjs.com/package/express`, `https://developer.mozilla.org/en-US/docs/Web/JavaScript`, `https://github.com/org/repo/releases`

## How Tools Flow to the SDK

The tool lists above are embedded in each agent's `AgentDefinition` and passed directly to the SDK via `QueryOptionsBuilder.build()` in `packages/daemon/src/lib/agent/query-options-builder.ts`:

1. `config.agents` (containing the Planner and plan-writer definitions) is passed as `agents` to SDK query options.
2. The SDK spawns each agent with its own `tools` array — no filtering is applied to these agent-scoped tool lists.
3. For room-agent sessions, `roomAllowedBuiltinTools` (which includes `WebFetch` and `WebSearch`) is merged into the top-level `allowedTools`, but this is additive — it does not restrict agent-level tool choices.

No `disallowedTools` or `allowedTools` filter is applied to the Planner or plan-writer agent definitions that would block `WebFetch` or `WebSearch`.

## Maintenance Note

When modifying the Planner tool list, preserve `WebFetch` and `WebSearch`:

```typescript
// ✅ Correct — includes both web tools
tools: ['Task', 'TaskOutput', 'Read', 'Write', 'WebFetch', 'WebSearch', ...]

// ❌ Wrong — accidentally omits web tools
tools: ['Task', 'TaskOutput', 'Read', 'Write', ...]
```

Both the Planner agent definition (`createPlannerAgentInit`) and the plan-writer agent definition (`buildPlanWriterAgentDef`) must be updated together to keep capabilities consistent between the orchestrating agent and its sub-agent.
