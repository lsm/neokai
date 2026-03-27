# Restructure Agent Orchestration with Exploration and Fact-Checking

## Goal Summary

Restructure the planner, coder, and reviewer agents to support proper multi-stage orchestration with exploration, fact-checking, and delegation capabilities. The core changes are:

1. **Planner** gains a 3-phase sequential pipeline: explorer -> fact-checker -> plan-writer (replacing the broken "spawn Explore agents" instruction)
2. **Coder** always uses the agent/agents pattern with built-in explorer and tester sub-agents (removing the conditional branch on `room.config.agentSubagents.worker`)
3. **Reviewer** gains exploration and fact-checking sub-agents for deeper code understanding
4. **Leader** is updated to always produce reviewers with the agent/agents pattern

## High-Level Approach

- Each agent type gets built-in sub-agent definitions that are always available (no room config dependency)
- Sub-agents are one-level only (no recursive spawning)
- The `agentSubagents.worker` config path continues to work for user-defined custom helpers, but built-in sub-agents (explorer, tester, fact-checker) are always present
- Token overhead is minimized by keeping sub-agent prompts concise and only including them in the agents map (not inlined into the parent prompt)

## Milestones

1. **Coder always-on agent/agents** - Remove conditional branching, always provide Task/TaskOutput/TaskStop with built-in explorer and tester sub-agents
2. **Planner 3-phase pipeline** - Replace plan-writer's broken Explore instruction with sequential explorer -> fact-checker -> plan-writer sub-agents
3. **Reviewer exploration and fact-checking** - Add explorer and fact-checker sub-agents to reviewer, always use agent/agents pattern
4. **Leader always-on agent/agents** - Update leader to always use agent/agents pattern even without room-configured reviewers
5. **Unit tests** - Comprehensive unit tests for all restructured agent factories
6. **Online tests** - Dev-proxy-based online tests verifying agent orchestration behavior
7. **Integration verification** - End-to-end verification that room runtime correctly wires all restructured agents

## Cross-Milestone Dependencies

- Milestone 1 (Coder) and Milestone 2 (Planner) are independent and can proceed in parallel
- Milestone 3 (Reviewer) depends on the pattern established in Milestone 1
- Milestone 4 (Leader) depends on Milestone 3 (reviewer sub-agents feed into leader's agents map)
- Milestone 5 (Unit tests) depends on Milestones 1-4
- Milestone 6 (Online tests) depends on Milestone 5
- Milestone 7 (Integration) depends on Milestones 5-6

## Key Sequencing Decisions

- The coder is restructured first because it establishes the always-on pattern that reviewer and leader will follow
- The planner is restructured independently since its 3-phase pipeline is a distinct pattern
- Tests are grouped into a separate milestone to avoid mixing implementation and test concerns in PRs

## Total Estimated Task Count

19 tasks across 7 milestones
