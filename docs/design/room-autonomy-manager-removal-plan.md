# Room Autonomy Redesign Plan: Remove Manager Agent Completely

## Objective

Remove the **manager agent/session concept** from code and product design, and move all orchestration responsibility to:
- `room:chat:{roomId}` agent (human-driven mode)
- `room:self:{roomId}` agent (autonomous mode)

End goal: make room autonomy work end-to-end with a single orchestration model and worker-only execution sessions.

---

## Product Rules (Target)

1. **No manager role exists** (no manager session type, manager prompts, manager tools, manager bridge).
2. `room:chat` and `room:self` have **identical orchestration capabilities**.
3. The only difference is **operating mode**:
   - `room:chat`: reacts to human messages/commands.
   - `room:self`: reacts to goals, tasks, events, idle/proactive checks, and session updates.
4. Tools and prompts are **single-source owned** (shared orchestration definition), not split/duplicated by mode.
5. Workers execute implementation; room agents orchestrate only.

---

## Why Remove Manager (Critical Findings)

- Current architecture duplicates orchestration across `room:self` and manager session logic.
- Manager-specific surface area increases failure modes and complexity:
  - `packages/daemon/src/lib/agent/manager-tools.ts`
  - `packages/daemon/src/lib/room/session-bridge.ts`
  - manager prompt template in `packages/shared/src/prompts/templates.ts`
  - manager references in `packages/shared/src/neo-prompt/prompt.ts` and `packages/neo/src/room-neo.ts`
- Bridge wiring is inconsistent by path:
  - `room.createPair` RPC starts `SessionBridge`
  - direct `SessionPairManager.createPair()` usage from room-self flow does not rely on that same path
- Net effect: more moving parts, less deterministic autonomy.

---

## Target Architecture

## 1) Single Orchestrator Capability Layer

Create one shared orchestration module used by both `room:chat` and `room:self`:

- Shared tool contract (read state, create/update tasks/goals/jobs, spawn workers, session controls, escalation/review).
- Shared orchestration prompt core.
- Shared policy constraints (orchestrate, never execute direct code/shell/file ops).

Suggested ownership:
- Prompt core: `packages/shared/src/prompts/room-agent.ts` (single source)
- Tools: `packages/daemon/src/lib/agent/room-agent-tools.ts` (single source)

Mode-specific behavior is injected as a lightweight runtime context (not separate prompt/tool stacks).

## 2) Worker-Only Execution Model

- Replace manager+worker pairs with worker-only task execution.
- Room orchestrator directly supervises worker lifecycle:
  - create worker
  - send task instructions
  - monitor session state/output
  - decide retry/escalation/complete

## 3) Unified Trigger Model

- `room:chat` triggers:
  - human messages
  - explicit commands
  - optional user-invoked planning
- `room:self` triggers:
  - idle checks
  - recurring jobs
  - task/goal transitions
  - room/session events

Both run the same decision loop and toolset.

---

## Removal Scope

## A. Remove manager concept and APIs

- Remove manager artifacts:
  - `packages/daemon/src/lib/agent/manager-tools.ts`
  - `packages/daemon/src/lib/room/session-bridge.ts`
- Remove manager session type usage (`sessionType: 'manager'`) and paired manager metadata.
- Remove/replace RPCs tied to manager-pair mental model:
  - `room.createPair`, `room.getPair(s)`, `room.archivePair` (replace with worker-run APIs).

## B. Remove manager prompts and docs

- Remove manager template IDs/content from:
  - `packages/shared/src/prompts/templates.ts`
  - `packages/shared/src/prompts/types.ts`
- Remove ManagerAgent wording from:
  - `packages/shared/src/neo-prompt/prompt.ts`
  - `packages/neo/src/room-neo.ts`
  - tests/docs referencing manager-worker architecture.

## C. Refactor room execution orchestration

- Refactor `RoomSelfService` to spawn/manage workers directly (no manager intermediary).
- Refactor room chat orchestration path to use same shared orchestrator loop with human-trigger mode.
- Keep worker creation/start deterministic (`startStreamingQuery` + initial instruction injection).

---

## Implementation Phases

## Phase 1 — Introduce unified orchestration core
- Extract common orchestration prompt/tool contract.
- Add mode context (`human_driven` vs `autonomous`) as runtime input only.
- Verify both room agents can call the exact same tools.

## Phase 2 — Add worker-only orchestration path
- Implement worker lifecycle service:
  - spawn worker for task
  - task->session binding
  - completion detection and summary capture
  - retries/timeouts/escalations
- Switch `room:self` to worker-only flow first.

## Phase 3 — Remove manager runtime and bridge
- Delete manager tools/bridge/session type behavior.
- Remove `room.createPair`/pair-centric pathways.
- Replace with worker-run RPC/state model.

## Phase 4 — Align room:chat with room:self capabilities
- Route `room:chat` agent through same orchestration core and tools.
- Keep behavior difference only at trigger source and response style.

## Phase 5 — Cleanup + migrations + docs
- Remove dead code/tests/types/schemas tied to manager concept.
- Update architecture docs and prompt docs.
- Ensure no UI/backend copy still references manager-agent/pairs.

---

## Data & API Migration Notes

- Session schema: remove/ignore `manager` type and paired manager-only metadata.
- Session pair tables: replace with worker-run tracking table or task-session linkage.
- Event stream: replace pair events (`pair.task_completed`) with worker/task lifecycle events.
- Backward compatibility window:
  - convert existing active pair records to task history
  - avoid hard failure on legacy data during rollout.

---

## Test Plan (Must Pass)

1. Unit tests:
   - shared orchestration prompt/tool builder
   - worker lifecycle transitions
   - room agent mode behavior (chat vs self) with identical capabilities
2. Integration tests:
   - room:self autonomous task progression from pending goal/task to completion
   - room:chat request to worker execution and completion report
3. E2E:
   - create room, start autonomous mode, observe task creation and worker execution to completion
   - user sends room chat request, room orchestrates worker, returns result
4. Regression:
   - no manager-only symbols or RPC handlers remain.

---

## Risks & Mitigations

- **Risk:** temporary loss of completion signaling while removing pair bridge  
  **Mitigation:** introduce worker completion events before deleting pair events.
- **Risk:** duplicated logic reappears in room:chat vs room:self  
  **Mitigation:** enforce shared orchestration module + shared tool contract.
- **Risk:** migration breaks existing persisted pair/session data  
  **Mitigation:** explicit migration adapter and compatibility read path during transition.

---

## Definition of Done

- Manager concept is absent from runtime, prompts, APIs, schema surface, and docs.
- `room:chat` and `room:self` use one orchestration capability set.
- Only behavior difference is working mode (human-triggered vs autonomous-triggered).
- Worker orchestration runs reliably end-to-end for autonomous room operation.
