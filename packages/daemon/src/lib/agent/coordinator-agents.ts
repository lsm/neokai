/**
 * Coordinator Mode - Agent Definitions
 *
 * Re-exports the coordinator agent and specialist subagents from individual files.
 *
 * When coordinator mode is enabled:
 * - Options.agent = 'coordinator' restricts the main thread to orchestration tools
 * - Options.agents includes these specialists + any user-defined agents
 * - SDK built-in types (Explore, Plan, Bash) remain available alongside
 */

import type { AgentDefinition } from '@neokai/shared';
import { COORDINATOR_AGENT } from './coordinator/coordinator';
import { coderAgent } from './coordinator/coder';
import { debuggerAgent } from './coordinator/debugger';
import { testerAgent } from './coordinator/tester';
import { reviewerAgent } from './coordinator/reviewer';
import { vcsAgent } from './coordinator/vcs';
import { verifierAgent } from './coordinator/verifier';
import { executorAgent } from './coordinator/executor';

/**
 * Specialist subagent definitions.
 *
 * Note: Explore, Plan, and Bash are SDK built-in agent types that are always
 * available via the Task tool. We only define specialists that add capabilities
 * beyond the built-ins.
 */
const SPECIALIST_AGENTS: Record<string, AgentDefinition> = {
	coder: coderAgent,
	debugger: debuggerAgent,
	tester: testerAgent,
	reviewer: reviewerAgent,
	vcs: vcsAgent,
	verifier: verifierAgent,
	executor: executorAgent,
};

/**
 * Get the full agents record for coordinator mode.
 * Merges specialist bench with any user-defined agents.
 * Specialists take priority on name conflicts.
 */
export function getCoordinatorAgents(
	userAgents?: Record<string, AgentDefinition>
): Record<string, AgentDefinition> {
	return {
		coordinator: COORDINATOR_AGENT,
		...userAgents,
		...SPECIALIST_AGENTS, // Specialists win on conflict
	};
}
