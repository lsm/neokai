/**
 * Space Preset Agent Seeding
 *
 * Seeds the four default SpaceAgent records when a new Space is created.
 * Preset agents are regular SpaceAgent rows — fully editable by users — that
 * happen to have a well-known role label and sensible defaults for system
 * prompt, tools, and model. SpaceRuntime resolves all agents by ID at
 * runtime; there is no special builtin code path.
 *
 * Preset agents seeded per Space:
 *   - Coder    (role: 'coder')    — implementation worker
 *   - General  (role: 'general')  — general-purpose worker
 *   - Planner  (role: 'planner')  — planning/orchestration worker
 *   - Reviewer (role: 'reviewer') — code review specialist
 */

import type { SpaceAgent } from '@neokai/shared';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgentManager, SpaceAgentResult } from '../managers/space-agent-manager';

// ---------------------------------------------------------------------------
// Tool defaults per role
// ---------------------------------------------------------------------------

/** Full coding toolset: read, write, shell, search, web */
const CODER_TOOLS = KNOWN_TOOLS.filter(
	(t) => !['Task', 'TaskOutput', 'TaskStop'].includes(t)
) as string[];

/** Same as coder — general agents have the same toolset */
const GENERAL_TOOLS = CODER_TOOLS;

/** Planner uses the same toolset as coder (orchestration patterns reserved for future) */
const PLANNER_TOOLS = CODER_TOOLS;

/** Reviewers read and run tests — no file write/edit by default */
const REVIEWER_TOOLS: string[] = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

interface PresetDefinition {
	name: string;
	role: SpaceAgent['role'];
	description: string;
	tools: string[];
	injectWorkflowContext?: boolean;
}

const PRESET_AGENTS: PresetDefinition[] = [
	{
		name: 'Coder',
		role: 'coder',
		description:
			'Implementation worker. Writes code, runs tests, commits changes, and opens pull requests.',
		tools: CODER_TOOLS,
	},
	{
		name: 'General',
		role: 'general',
		description: 'General-purpose worker. Handles broad tasks that do not fit a specialized role.',
		tools: GENERAL_TOOLS,
	},
	{
		name: 'Planner',
		role: 'planner',
		description:
			'Planning agent. Breaks down goals into actionable tasks and drafts implementation plans.',
		tools: PLANNER_TOOLS,
		// Planners need full workflow structure in their task message so they can
		// create tasks aligned with the current workflow step. Driven by data, not
		// by a hardcoded role check in prompt builders.
		injectWorkflowContext: true,
	},
	{
		name: 'Reviewer',
		role: 'reviewer',
		description:
			'Code review specialist. Reviews pull requests for correctness, style, and test coverage.',
		tools: REVIEWER_TOOLS,
	},
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SeedPresetAgentsResult {
	/** Agents that were successfully created */
	seeded: SpaceAgent[];
	/** Errors for agents that failed to seed (e.g. name already taken) */
	errors: Array<{ name: string; error: string }>;
}

/**
 * Seed the four preset SpaceAgents for a newly-created Space.
 *
 * Idempotent by design: if a preset name is already taken in this Space
 * (e.g. because this was called twice), the error is recorded but does not
 * abort the remaining seeds.
 *
 * @param spaceId - The Space to seed agents into
 * @param agentManager - The SpaceAgentManager to use for creation
 * @returns Summary of seeded agents and any errors
 */
export async function seedPresetAgents(
	spaceId: string,
	agentManager: SpaceAgentManager
): Promise<SeedPresetAgentsResult> {
	const seeded: SpaceAgent[] = [];
	const errors: Array<{ name: string; error: string }> = [];

	for (const preset of PRESET_AGENTS) {
		const result: SpaceAgentResult<SpaceAgent> = await agentManager.create({
			spaceId,
			name: preset.name,
			role: preset.role,
			description: preset.description,
			tools: preset.tools,
			injectWorkflowContext: preset.injectWorkflowContext,
		});

		if (result.ok) {
			seeded.push(result.value);
		} else {
			errors.push({ name: preset.name, error: result.error });
		}
	}

	return { seeded, errors };
}
