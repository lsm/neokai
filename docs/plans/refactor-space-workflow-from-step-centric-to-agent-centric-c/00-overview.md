# Refactor Space Workflow from Step-Centric to Agent-Centric Collaboration Model

## Goal Summary

Transform the Space workflow system from a sequential step/pipeline model (directed graph of nodes with a central `advance()` function driving step-by-step progression) to an agent-centric collaboration model (collaboration graph of agents with gated communication channels). The `advance()` function, `advance_workflow` tool, `WorkflowTransition` type, and `currentNodeId` tracking are all removed and replaced with agent-driven messaging, cross-node gated channels, and all-agents-done completion detection.

**The Space workflow feature is not yet released, so backward compatibility is NOT needed.** This allows a clean cutover — we can directly replace the old step-centric model with the new agent-centric model without maintaining dual paths, deprecation warnings, or migration scripts.

## Current Architecture (Step-Centric — to be replaced)

The current system treats workflows as directed graphs of sequential steps:

- **`WorkflowNode`** -- a step in the graph, assigned one or more agents
- **`WorkflowTransition`** -- directed edges between steps with optional `WorkflowCondition` guards (always, human, condition, task_result)
- **`SpaceWorkflowRun`** -- tracks execution with a single `currentNodeId` (one active step at a time)
- **`WorkflowExecutor.advance()`** -- step-by-step progression *(to be deleted in Milestone 4)*, condition evaluation
- **`SpaceRuntime.executeTick()`** -- polls for completed step tasks, calls `advance()` to move forward *(to be rewritten in Milestones 4-5)*
- **`TaskAgentManager`** -- manages Task Agent sessions (orchestrator per task) that use MCP tools (`spawn_step_agent`, `check_step_status`, `advance_workflow` *(to be deleted)*, `report_result`) to drive workflows
- **`WorkflowChannel`** -- currently node-scoped messaging topology for inter-agent communication within a step (no gates, just topology)

## Target Architecture (Agent-Centric Collaboration)

### Addressing Model: Node + Agent, String-Based

The addressing model uses **two concepts** with a **single string-based target**:

- **Node** — an entity in the workflow graph. Has a prompt, tools, and model. Can spawn 1 or more agents. Nodes are the structural unit — they define what kind of work happens (e.g., "planning", "coding", "reviewing"). Node names are globally unique within a workflow.
- **Agent** — a running instance within a node. Each agent gets the node's prompt/tools/model plus a unique name (e.g., `coder1`, `reviewer2`). Agent names are globally unique within a workflow.

**Target resolution** — the `target` parameter in `send_message` is a plain string. The router resolves it at delivery time:
- `target: 'reviewers'` → resolves to a **node** → fan-out message to all agents in that node (like a Slack group chat)
- `target: 'auditor1'` → resolves to an **agent** → DM to that specific agent
- `target: 'coder'` → if it's a single-agent node, resolves to the one agent; if multi-agent, resolves to the node (fan-out)

**No "role" concept** — there are only nodes (which define the template) and agents (which are the runtime instances). This keeps the mental model simple and maps cleanly to Slack: node = channel, agent = person, target = type a name and hit enter.

**Channel configuration** (`CrossNodeChannel`) defines the **policy layer** — which agents/nodes can communicate and under what conditions. The `target` in `send_message` is the **addressing layer**. The router matches them at delivery time.

**Non-agent nodes** — a node doesn't have to contain LLM agents. A "human" node or "external-service" node could exist as a routing target without spawning an agent. This enables future extensibility (e.g., "wait for human input" as a node).

### Key Architectural Principles

1. **Workflow = collaboration graph of agents with gated communication channels**
   - Nodes are the structural units (prompt, tools, model templates)
   - Agents are the runtime instances (unique names, individual sessions)
   - Cross-node channels carry gates (policies on who can talk to whom)

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

## Key Architectural Decisions

1. **No backward compatibility needed**: The Space workflow feature is unreleased. Clean replacement.

2. **Incremental delivery**: 9 milestones, each independently testable and deployable.

3. **Channel gates are optional**: Not all channels need gates. Unconditional channels work like `always` transitions.

4. **Agent completion signaling**: Agents explicitly report done (via tool call). A timeout-based liveness guard auto-completes stuck agents.

5. **Gate evaluation reuses existing infrastructure**: `WorkflowCondition` type and `evaluateCondition()` logic move to channels.

6. **Lazy target-node activation**: Router lazily creates tasks/sessions when cross-node channels fire.

7. **String-based target addressing**: `send_message` target is a plain string. Resolved as: agent name → DM, node name → fan-out. No structured objects, no role references.

8. **Dynamic migration numbers**: Use next available at implementation time.

9. **Milestones 1 & 3 parallel**, Milestones 7 & 8 parallel.

## Milestones

1. **Channel Gate Types** -- Add gate/condition support to `WorkflowChannel`, create `ChannelGateEvaluator` (4 tasks)
2. **Cross-Node Channel Infrastructure** -- `CrossNodeChannel` types (policy layer), DB schema, resolution (5 tasks)
3. **Agent Completion Signaling** -- `report_done` tool, liveness guard, completion state (6 tasks)
4. **Agent-Driven Advancement** -- Channel routing, lazy activation, string-based addressing, remove `advance()` (7 tasks)
5. **Completion Detection** -- All-agents-done detector, tick loop, status lifecycle (4 tasks)
6. **Task Agent Refactoring** -- Collaboration manager prompt, `report_workflow_done` (5 tasks)
7. **Built-in Workflow Replacement** -- Replace 3 built-in workflows (2 tasks)
8. **UI Updates** -- Visual editor, gate config UI, agent completion state (4 tasks)
9. **Final Cleanup** -- Remove old code, comprehensive tests (3 tasks)

## Cross-Milestone Dependencies

- Milestone 1 is standalone (types + evaluator)
- Milestone 2 depends on Milestone 1 (cross-node channels need gate support)
- Milestone 3 is largely standalone (completion signaling)
- Milestone 4 depends on Milestones 1 and 2 (needs gated cross-node channels)
- Milestone 5 depends on Milestones 3 and 4 (needs completion detection + agent-driven advancement)
- Milestone 6 depends on Milestone 5 (needs the new advancement model before refactoring Task Agent)
- Milestone 7 depends on Milestone 6 (needs new model before updating built-in workflows)
- Milestone 8 depends on Milestones 2, 3 (needs cross-node types + completion state)
- Milestone 9 depends on all prior milestones (final cleanup)

Key sequencing decisions:
- **Milestones 1 and 3 can be developed in parallel** (no dependencies between them)
- **Milestones 7 and 8 can be developed in parallel** (backend replacement vs UI updates)
- Milestone 2 can start after Milestone 1
- Milestones 4-6 are sequential
- Milestone 9 is the final milestone

## Total Estimated Task Count

40 tasks across 9 milestones.
