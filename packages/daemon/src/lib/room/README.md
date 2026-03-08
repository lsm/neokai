# Room Subsystem

Multi-agent orchestration: goals → tasks → session groups → Worker/Leader loop.

## Directory Structure

| Directory | Purpose |
|-----------|---------|
| `agents/` | Agent configs: leader, planner, coder, general. Prompt templates + MCP tool definitions. |
| `managers/` | GoalManager, TaskManager. CRUD + status transitions for goals and tasks. |
| `runtime/` | RoomRuntime orchestrator. Tick loop, session group lifecycle, stall detection, recovery. |
| `state/` | SessionGroupRepository. DB persistence for session groups + optimistic locking. |
| `tools/` | MCP tools exposed to room agents (create_task, fail_task, etc.) |

## State Machine

```
                    ┌─── feedback ───┐
                    ▼                │
awaiting_worker → awaiting_leader ──┤
                                    ├──→ awaiting_human → completed
                                    └──→ completed / failed
```

## Key Files

- `runtime/room-runtime.ts` — Main orchestrator. Tick loop, spawning, routing, leader tool handling.
- `runtime/task-group-manager.ts` — Session group lifecycle: spawn, route, complete, fail.
- `runtime/runtime-recovery.ts` — Daemon restart recovery: restore sessions, re-attach observers.
- `managers/task-manager.ts` — Task CRUD, retry logic, dependency checking.
- `managers/goal-manager.ts` — Goal CRUD, progress tracking, planning attempts.

## Common Modifications

- **Add a new agent role**: Create config in `agents/`, add branch in `room-runtime.ts:spawnGroupForTask`.
- **Add a new leader tool**: Add case in `room-runtime.ts:handleLeaderTool`, register in `agents/leader-agent.ts`.
- **Change retry behavior**: Modify `task-manager.ts:failTask` and its `autoRetry` option.
- **Change stall timeout**: Set `stallTimeoutMs` in RoomRuntime config.
