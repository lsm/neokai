# System-Wide @ Referencing System

## Goal Summary

Design and implement a comprehensive @ referencing system that allows users to reference tasks, goals, files, and folders from any chat input in the application. When a user types @, an autocomplete menu appears similar to the / command experience, enabling semantic resolution of references that the agent can understand and act upon.

## High-Level Approach

1. **Reuse existing slash command infrastructure** - The autocomplete menu pattern from `useCommandAutocomplete` and `CommandAutocomplete` will serve as the foundation.
2. **Support multiple entity types** - Tasks (room tasks, space tasks), Goals/Missions, Files, and Folders.
3. **Semantic resolution** - The backend parses @ references from input text and resolves them to actual entity data before sending to the agent.
4. **Persistence as structured mentions** - @ references are stored in message content in a structured format that survives reloads.

## Milestones

1. **M1: Core Types and RPC Infrastructure** - Define shared types for references and create backend RPC handlers for reference resolution.
2. **M2: Frontend Autocomplete Menu** - Implement `useReferenceAutocomplete` hook and `ReferenceAutocomplete` component, extending the slash command pattern.
3. **M3: Backend Reference Resolution** - Implement message preprocessing to resolve @ references before sending to the agent.
4. **M4: Reference Token Rendering** - Implement styled mention tokens in the input and in rendered messages.
5. **M5: E2E Testing** - Comprehensive Playwright tests covering all entity types and edge cases.

## Cross-Milestone Dependencies

```
M1 (Types/RPC) ──┬──> M2 (Frontend Menu) ──> M4 (Token Rendering)
                 │
                 └──> M3 (Backend Resolution) ──> M5 (E2E Tests)
                                                    ^
                                                    │
                          M2 + M3 + M4 ──────────────┘
```

**Key sequencing decisions:**

- M1 must complete first as it provides types used by both frontend and backend.
- M2 and M3 can proceed in parallel after M1.
- M4 depends on M2 for the autocomplete selection mechanism.
- M5 requires M2, M3, and M4 to be complete for full integration testing.

## Total Estimated Task Count

~20 tasks across 5 milestones:
- M1: 4 tasks (types, RPC handlers, reference resolution service)
- M2: 5 tasks (hook, component, integration with InputTextarea, keyboard navigation, mobile UX)
- M3: 4 tasks (message preprocessing, entity fetchers, reference extraction, agent context injection)
- M4: 4 tasks (mention token component, message rendering integration, persistence format, reference display in history)
- M5: 3 tasks (basic autocomplete E2E, entity resolution E2E, edge cases E2E)

## Reference Syntax Design

```
@task-t-42        -> Reference to room task with shortId "t-42"
@task-st-15       -> Reference to space task with shortId "st-15"
@goal-g-7         -> Reference to goal/mission with shortId "g-7"
@file:src/lib.ts  -> Reference to file at path "src/lib.ts"
@folder:src/lib   -> Reference to folder at path "src/lib"
```

**Storage format in message content:**

```
[@:task:t-42](task-t-42)  -> Markdown-style link that renders as styled token
[@:goal:g-7](goal-g-7)    -> Preserves entity type and ID for backend parsing
[@:file:src/lib.ts](src/lib.ts) -> File path reference
```

## Key Technical Decisions

1. **Short IDs for entities** - Use existing `shortId` fields on tasks and goals for human-readable references (e.g., `t-42`, `g-7`).
2. **Fuzzy search** - Implement fuzzy matching across all entity types for intuitive discovery.
3. **Context-aware resolution** - Backend resolves references based on current session context (room ID, space ID, workspace path).
4. **Composability with slash commands** - @ references work anywhere in the message, including after slash commands (e.g., `/agent @task-t-42 fix the bug`).
5. **Agent context injection** - Resolved reference data is injected as structured context before the user message in the SDK message payload.

## Affected Areas

### Frontend (packages/web)
- `src/hooks/useReferenceAutocomplete.ts` (new)
- `src/hooks/useCommandAutocomplete.ts` (reference)
- `src/components/ReferenceAutocomplete.tsx` (new)
- `src/components/CommandAutocomplete.tsx` (reference)
- `src/components/InputTextarea.tsx` (modify)
- `src/components/MessageInput.tsx` (modify)
- `src/components/MentionToken.tsx` (new)
- `src/components/sdk/SDKUserMessage.tsx` (modify for rendering)
- `src/lib/reference-store.ts` (new - for entity search)

### Backend (packages/daemon)
- `src/lib/rpc-handlers/reference-handlers.ts` (new)
- `src/lib/agent/reference-resolver.ts` (new)
- `src/lib/agent/message-preprocessor.ts` (new or extend existing)
- `src/lib/rpc-handlers/session-handlers.ts` (modify message.send)

### Shared (packages/shared)
- `src/types/reference.ts` (new)
- `src/types/index.ts` (export new types)

### E2E Tests (packages/e2e)
- `tests/features/reference-autocomplete.e2e.ts` (new)
- `tests/helpers/reference-helpers.ts` (new)
