# Task Status Control Design

This document describes the design for human-in-the-loop task status control for for humans have full manual control over the task lifecycle when needed, bypassing the normal autonomous flow.

## Valid Status Transitions

Based on the code review, we room agent
 and room Agent (`set_task_status`) can change task status to Supports restart ( restart: failed/c cancelled tasks.

### Valid Transitions

| Current Status | Target Status | Notes |
|---|---|----------|----------------|--------------------|----------|--------------|------|-------------|--------------|
----------------|----------------|------------|-------------------|
| pending | in_progress, cancelled | Worker not started | leader is actively working. Human can cancel without human review flow. |
| in_progress | review, completed, failed, cancelled | Terminal state - no transitions allowed |
| failed | pending, in_progress | Restart: human can retry failed task |
| cancelled | pending, in_progress | Restart: human can retry cancelled task |

### Transitions with checked via `setTaskStatus`:
- Validated via `VALIDStatusTransition()` before applying
- Clears error/result/progress fields when restarting
- Sets progress to 100% for- On terminal state,- Clears error/result when moving to terminal state
- The **task.setStatus** RPC handler throws error if cancellation fails
- Notifies UI of task.setStatus` event with- Returns updated task object

## API
### Room Agent MCP Tool
- `set_task_status` tool - validates and transitions, allows room agent to change task status
## Types

### UpdateTaskParams
```ts
export interface UpdateTaskParams {
	title?: string;
	description?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	progress?: number | null;
	currentStep?: string | null;
	result?: string | null;
	error?: string | null;
	dependsOn?: string[];
}
```

## Usage

```bash
bun run format
git commit -m "docs: add task status control design doc with task status transition diagram"