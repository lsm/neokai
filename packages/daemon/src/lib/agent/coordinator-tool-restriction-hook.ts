/**
 * Coordinator Tool Restriction Hook
 *
 * Enforces coordinator mode tool restrictions via SDK hooks.
 * The coordinator agent should only use orchestration tools (Task, TodoWrite, etc.)
 * and must delegate all direct work to specialist sub-agents.
 *
 * Background (SDK issue #162):
 * The SDK's internal ALL_AGENT_DISALLOWED_TOOLS constant strips orchestration tools
 * (Task, TaskOutput, etc.) from all agents before intersecting with the agent's tools
 * whitelist. This makes AgentDefinition.tools/disallowedTools ineffective for the
 * main-thread coordinator. canUseTool is skipped in bypassPermissions mode.
 *
 * Strategy:
 * - Track active sub-agents via SubagentStart/SubagentStop hooks
 * - In PreToolUse, when no sub-agent is active (coordinator/main-thread context),
 *   block tools in the coordinator's disallowedTools list
 * - When sub-agents are active, allow all tools (the call is from a sub-agent)
 * - Hook deny decisions bypass bypassPermissions mode entirely
 *
 * Limitation:
 * PreToolUse hooks don't receive agent context. If the coordinator makes a direct
 * tool call while a sub-agent is also running, the counter heuristic would allow it.
 * In practice this is rare since tool calls are sequential per agent turn.
 */

import type {
	HookCallback,
	PreToolUseHookInput,
	SubagentStartHookInput,
	SubagentStopHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '../logger';
import { COORDINATOR_AGENT } from './coordinator/coordinator';

/**
 * Tools the coordinator is not allowed to use directly.
 * Derived from COORDINATOR_AGENT.disallowedTools.
 */
const COORDINATOR_DISALLOWED_TOOLS = new Set(COORDINATOR_AGENT.disallowedTools ?? []);

export interface CoordinatorRestrictionHooks {
	preToolUse: HookCallback;
	subagentStart: HookCallback;
	subagentStop: HookCallback;
}

/**
 * Creates hooks that enforce coordinator tool restrictions.
 *
 * Returns three hook callbacks that share closure state (activeSubagentCount).
 * Register them for PreToolUse, SubagentStart, and SubagentStop events respectively.
 */
export function createCoordinatorRestrictionHooks(): CoordinatorRestrictionHooks {
	const logger = new Logger('CoordinatorToolRestriction');

	// Closure-scoped counter tracking active sub-agents.
	// When > 0, tool calls originate from sub-agents and should be allowed.
	// When == 0, tool calls originate from the coordinator and restricted tools are blocked.
	let activeSubagentCount = 0;

	const preToolUse: HookCallback = async (input, _toolUseID, _options) => {
		if (input.hook_event_name !== 'PreToolUse') return {};

		const { tool_name } = input as PreToolUseHookInput;

		logger.log(`PreToolUse hook called: tool=${tool_name}, activeSubagents=${activeSubagentCount}`);

		// Sub-agents are active → tool call is from a sub-agent, allow it
		if (activeSubagentCount > 0) return {};

		// No sub-agents active → coordinator context, enforce restrictions
		if (COORDINATOR_DISALLOWED_TOOLS.has(tool_name)) {
			const reason = `The coordinator cannot use ${tool_name} directly. Delegate this work to a specialist sub-agent via the Task tool instead.`;
			logger.log(`Blocking coordinator direct use of ${tool_name}`);
			return {
				decision: 'block' as const,
				reason,
				hookSpecificOutput: {
					hookEventName: 'PreToolUse' as const,
					permissionDecision: 'deny' as const,
					permissionDecisionReason: reason,
				},
			};
		}

		return {};
	};

	const subagentStart: HookCallback = async (input, _toolUseID, _options) => {
		if (input.hook_event_name !== 'SubagentStart') return {};

		const { agent_id, agent_type } = input as SubagentStartHookInput;
		activeSubagentCount++;
		logger.log(`Sub-agent started: ${agent_type} (${agent_id}), active: ${activeSubagentCount}`);

		return {};
	};

	const subagentStop: HookCallback = async (input, _toolUseID, _options) => {
		if (input.hook_event_name !== 'SubagentStop') return {};

		const { agent_id } = input as SubagentStopHookInput;
		activeSubagentCount = Math.max(0, activeSubagentCount - 1);
		logger.log(`Sub-agent stopped: ${agent_id}, active: ${activeSubagentCount}`);

		return {};
	};

	return { preToolUse, subagentStart, subagentStop };
}
