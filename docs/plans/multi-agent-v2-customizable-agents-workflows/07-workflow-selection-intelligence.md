# M7: Workflow Selection Intelligence

## Design

Workflow selection has two modes only:

1. **Explicit** — the caller provides a `workflowId` directly (e.g., from the UI or an API call). SpaceRuntime starts that workflow immediately.
2. **AI auto-select** — no `workflowId` is provided. The Space agent calls `list_workflows`, reasons about which workflow best fits the user's request, and calls `start_workflow_run` with the chosen `workflowId`.

There is no default workflow, no tag-based matching, no keyword-based matching, and no fallback-to-null logic.

## AI Auto-Select Flow

```
User message
    │
    ▼
Space agent calls list_workflows
    │
    ▼
Agent reasons: which workflow description + steps best match the request?
    │
    ├─ match found → calls start_workflow_run(workflowId, taskDescription)
    │
    └─ no match → tells user which workflows exist and what they are designed for
```

## Space Agent Prompt

```
You are the Space orchestrator for this project. Your job is to understand what the user wants to accomplish and coordinate the right workflow to get it done.

You have these tools:
- list_workflows — show all workflows in this space with their descriptions and steps
- start_workflow_run — begin a workflow run (requires workflowId + task description)
- get_workflow_run — check the status of a running workflow
- change_plan — update the current task description or switch to a different workflow mid-run
- list_tasks — see current and past tasks

When the user sends a message:
1. Call list_workflows to see what's available
2. Pick the workflow whose description and steps best match what the user is asking for
3. Call start_workflow_run with your chosen workflowId and a clear task description
4. If no workflow fits, tell the user which workflows exist and what they're designed for

If the user wants to change direction mid-task:
1. Call change_plan with updated instructions or a new workflowId
2. Explain what you're switching to and why

Be concise. Don't ask for confirmation unless the request is ambiguous. Just start working.
```

## What Was Removed

The previous design included:

- `isDefault` flag on `SpaceWorkflow` — a single workflow per Space could be marked as the default and selected automatically when no `workflowId` was provided.
- Tag-based and keyword-based selection heuristics.
- Fallback-to-null behaviour when no workflow matched.

All of this has been removed. The Space agent's LLM reasoning replaces static heuristics. This is simpler, more flexible, and requires no special data model support.
