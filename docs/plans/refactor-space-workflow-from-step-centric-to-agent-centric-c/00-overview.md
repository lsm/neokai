# Refactor Space Workflow from Step-Centric to Agent-Centric Collaboration Model

## Goal Summary

Transform the Space workflow system from a sequential step/pipeline model (directed graph of nodes with a central `advance()` function driving step-by-step progression) to an agent-centric collaboration model (collaboration graph of agents with gated communication channels). The `advance()` function, `advance_workflow` tool, `WorkflowTransition` type, and `currentNodeId` tracking are all removed and replaced with agent-driven messaging, gated channels, and all-agents-done completion detection.

**The Space workflow feature is not yet released, so backward compatibility is NOT needed.** This allows a clean cutover — we can directly replace the old step-centric model with the new agent-centric model without maintaining dual paths, deprecation warnings, or migration scripts.

## Current Architecture (Step-Centric — to be replaced)

The current system treats workflows as directed graphs of sequential steps:

- **`WorkflowNode`** -- a step in the graph, assigned one or more agents
- **`WorkflowTransition`** -- directed edges between steps with optional `WorkflowCondition` guards (always, human, condition, task_result)
- **`SpaceWorkflowRun`** -- tracks execution with a single `currentNodeId` (one active step at a time)
- **`WorkflowExecutor.advance()`** -- step-by-step progression *(to be deleted in Milestone 3)*, condition evaluation
- **`SpaceRuntime.executeTick()`** -- polls for completed step tasks, calls `advance()` to move forward *(to be rewritten in Milestones 3-4)*
- **`TaskAgentManager`** -- manages Task Agent sessions (orchestrator per task) that use MCP tools (`spawn_step_agent`, `check_step_status`, `advance_workflow` *(to be deleted)*, `report_result`) to drive workflows
- **`WorkflowChannel`** -- currently node-scoped messaging topology for inter-agent communication within a step (no gates, just topology)

## Target Architecture (Agent-Centric Collaboration)

### Two Concepts: Node and Agent

The messaging model uses only two concepts:

- **Node** = a channel. Has a prompt template, tools, and model config. Spawns 1 or more agents as runtime instances.
  - Node with 1 agent = DM channel
  - Node with 3 agents = group chat (agents can DM each other within it)
  - No separate "node group" concept — the node IS the group
- **Agent** = a running instance within a node. Gets the node's template. Has a globally unique name within the workflow.

**No "role" concept exists** anywhere in channels, messaging, or addressing. The existing `WorkflowNodeAgent.role` field is renamed to `name` (Task 1.1), and `SpaceTask.slotRole` is renamed to `agentName` (Task 8.2) to align the internal data model with the conceptual model.

### Target Addressing: Plain Strings

`target: z.string()` — one field, resolves to either:
- Agent name → DM to that specific agent
- Node name → fan-out to ALL agents in that node

Router logic: agent lookup → DM, node lookup → fan-out, neither → error.

Maps to Slack: node = `#channel`, agent = `@username`, target = type a name and hit enter.

### ONE Unified Channel Type

One `WorkflowChannel` type for everything — within-node DMs, within-node broadcast, cross-node DMs, cross-node fan-out:

```ts
interface WorkflowChannel {
  id: string;
  from: string;           // sender: agent name or node name
  to: string;             // recipient: agent name or node name
  direction: 'one-way' | 'bidirectional';
  isCyclic?: boolean;
  gate?: WorkflowCondition;
  label?: string;
}
```

One resolver. One router. One DB column. One set of tests.

### Session Group Semantics

Each node gets exactly one `SpaceSessionGroup`. All agents spawned on that node are members of that group. Agents from different nodes never share a session group — the `ChannelRouter` delivers cross-node messages by injecting them into the target's session group. This keeps the session group model simple: one group per node, one message stream per group.

### Key Architectural Principles

1. **Workflow = collaboration graph of agents with gated communication channels**
   - Nodes are the structural units (prompt, tools, model templates)
   - Agents are the runtime instances (unique names, individual sessions)
   - One `WorkflowChannel` type for all connections (within-node and cross-node)
   - Channels carry gates (policies on who can talk to whom)

2. **Agents are primary execution units**
   - Each agent has its own session and decides what to do based on intelligence
   - The system provides guardrails (rules = behavioral prompts) and enforcement (gates = policy checks)
   - Multiple agents can run on the same node (e.g., `coder1`, `coder2` on a "coding" node)

3. **Gates on WorkflowChannel replace WorkflowTransition guards**
   - Channel-level gates are **policies** that enforce when messages can flow
   - Gates enforce rules like "can't send to reviewers until PR exists and CI passes"

4. **advance() is fully removed**
   - Agents drive themselves by sending messages through gated channels
   - The executor becomes a channel-routing + gate-enforcement layer
   - Completion is detected when all agents report done

5. **Task Agent role changes**
   - Collaboration manager that coordinates agents, monitors gates, handles human escalation

6. **Lazy target-node activation**
   - Router lazily creates tasks/sessions when channels fire to inactive nodes

## Key Architectural Decisions

1. **No backward compatibility needed**: The Space workflow feature is unreleased. Clean replacement.

2. **One unified WorkflowChannel type**: Same type for within-node and cross-node. One resolver, one router, one DB column.

3. **Node + Agent, string-based addressing**: `send_message` target is a plain string. Resolved as: agent name → DM, node name → fan-out. No structured objects, no role references.

4. **Incremental delivery**: 8 milestones, each independently testable and deployable.

5. **Channel gates are optional**: Not all channels need gates. Unconditional channels work like `always` transitions.

6. **Agent completion signaling**: Agents explicitly report done (via tool call). A timeout-based liveness guard auto-completes stuck agents.

7. **Gate evaluation reuses existing infrastructure**: `WorkflowCondition` type and `evaluateCondition()` logic move to channels.

8. **Dynamic migration numbers**: Use next available at implementation time.

9. **Milestones 1 & 2 parallel**, Milestones 7 can start once M1 and M2 are done.

## Milestones

1. **Unified Channel Type and Gates** -- Extend `WorkflowChannel` with gates, one resolver, gate evaluator, DB schema (7 tasks)
2. **Agent Completion Signaling** -- `report_done` tool, liveness guard, completion state (6 tasks)
3. **Agent-Driven Advancement** -- ChannelRouter, lazy activation, string-based addressing, remove `advance()` (7 tasks)
4. **Completion Detection** -- All-agents-done detector, tick loop, status lifecycle (4 tasks)
5. **Task Agent Refactoring** -- Collaboration manager prompt, `report_workflow_done` (5 tasks)
6. **Built-in Workflow Replacement** -- Replace 3 built-in workflows (2 tasks)
7. **UI Updates** -- Visual editor, gate config UI, agent completion state (4 tasks)
8. **Final Cleanup** -- Remove old code, comprehensive tests (3 tasks)

## Cross-Milestone Dependencies

- Milestone 1 is standalone (unified channel types + gates)
- Milestone 2 is standalone (agent completion signaling)
- Milestone 3 depends on Milestones 1 and 2 (needs channels + completion)
- Milestone 4 depends on Milestones 2 and 3 (needs completion detection + agent-driven advancement)
- Milestone 5 depends on Milestone 4 (needs the new advancement model before refactoring Task Agent)
- Milestone 6 depends on Milestone 5 (needs new model before updating built-in workflows)
- Milestone 7 depends on Milestones 1 and 2 (needs channel types + completion state)
- Milestone 8 depends on all prior milestones (final cleanup)

Key sequencing decisions:
- **Milestones 1 and 2 can be developed in parallel** (no dependencies between them)
- **Milestone 7 can start once M1 and M2 are done** (parallel with M3–M6)
- Milestones 3–6 are sequential
- Milestone 8 is the final milestone

## Total Estimated Task Count

38 tasks across 8 milestones.
