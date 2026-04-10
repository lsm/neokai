# Multi-Agent Thread Color Language

## Why

In agent-first workflows, humans spend most of their time in the message stream. This document defines the color language for that stream so it is scannable like an editor.

## Current color system (already implemented)

### Chat bubbles

- **User**: blue bubble (`bg-blue-500`, white text)
  - Source: `packages/web/src/lib/design-tokens.ts:79`
- **Assistant**: dark bubble (`bg-dark-800`, white text)
  - Source: `packages/web/src/lib/design-tokens.ts:87`

### Tool/action cards by category

Implemented via `getCategoryColors()`:
- **File ops** (`Read`, `Write`, `Edit`, `NotebookEdit`): blue
- **Search ops** (`Glob`, `Grep`): purple
- **Terminal ops** (`Bash`, `BashOutput`, `KillShell`): gray
- **Agent ops** (`Task`, `Agent`): indigo
- **Web ops** (`WebFetch`, `WebSearch`): green
- **Todo ops** (`TodoWrite`): amber
- **MCP ops** (`mcp__*`): pink
- **System ops** (`ExitPlanMode`, etc.): cyan
- **Thinking**: explicit amber override

### File tool icon rule (new)

For file tools, keep the same blue surface language, but use icon color to indicate mutating operations:

- `Read`: keep default file styling (blue icon + blue background/frame)
- `Write`, `Edit`, `NotebookEdit`: green icon, while keeping blue background/frame and blue text

This keeps file-domain consistency while making write operations instantly scannable.

Sources:
- `packages/web/src/components/sdk/tools/tool-registry.ts:222`
- `packages/web/src/components/sdk/tools/tool-registry.ts:35`
- `packages/web/src/components/sdk/tools/tool-registry.ts:65`
- `packages/web/src/components/sdk/tools/tool-registry.ts:81`
- `packages/web/src/components/sdk/tools/tool-registry.ts:107`
- `packages/web/src/components/sdk/tools/tool-registry.ts:123`
- `packages/web/src/components/sdk/tools/tool-registry.ts:139`
- `packages/web/src/components/sdk/tools/tool-registry.ts:159`
- `packages/web/src/components/sdk/tools/tool-registry.ts:175`
- `packages/web/src/components/sdk/tools/tool-registry.ts:203`

### Other message-type blocks

- **Result message**: success = green, error = red
  - Source: `packages/web/src/components/sdk/SDKResultMessage.tsx:31`
- **Rate-limit event**: allowed = amber, rejected = red
  - Source: `packages/web/src/components/sdk/SDKRateLimitEvent.tsx:24`
- **Synthetic message**: purple treatment
  - Source: `packages/web/src/components/sdk/SyntheticMessageBlock.tsx:107`
- **Error output block** (`<local-command-stderr>`): red treatment
  - Source: `packages/web/src/components/sdk/ErrorOutput.tsx:121`

