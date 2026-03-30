/**
 * Space Preset Agent Seeding
 *
 * Seeds the five default SpaceAgent records when a new Space is created.
 * Preset agents are regular SpaceAgent rows — fully editable by users — that
 * happen to have a well-known role label and sensible defaults for tools and model.
 * SpaceRuntime resolves all agents by ID at
 * runtime; there is no special builtin code path.
 *
 * Preset agents seeded per Space:
 *   - Coder    (role: 'coder')    — implementation worker
 *   - General  (role: 'general')  — general-purpose worker
 *   - Planner  (role: 'planner')  — planning/orchestration worker
 *   - Reviewer (role: 'reviewer') — code review specialist
 *   - QA       (role: 'qa')       — quality assurance specialist
 */

import type { SpaceAgent, SessionFeatures } from '@neokai/shared';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgentManager, SpaceAgentResult } from '../managers/space-agent-manager';
// ---------------------------------------------------------------------------
// Feature flag profiles per role
// ---------------------------------------------------------------------------

/**
 * All sub-session roles disable UI features — sub-sessions are internal
 * and should not expose rewind, worktree, coordinator, archive, or sessionInfo.
 */
export const ROLE_FEATURES: Record<string, SessionFeatures> = {
	coder: { rewind: false, worktree: false, coordinator: false, archive: false, sessionInfo: false },
	general: {
		rewind: false,
		worktree: false,
		coordinator: false,
		archive: false,
		sessionInfo: false,
	},
	planner: {
		rewind: false,
		worktree: false,
		coordinator: false,
		archive: false,
		sessionInfo: false,
	},
	reviewer: {
		rewind: false,
		worktree: false,
		coordinator: false,
		archive: false,
		sessionInfo: false,
	},
	qa: { rewind: false, worktree: false, coordinator: false, archive: false, sessionInfo: false },
};

/** Default features for roles not explicitly listed in ROLE_FEATURES */
export const DEFAULT_ROLE_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

/**
 * Look up feature flags for a given role.
 * Falls back to DEFAULT_ROLE_FEATURES for unknown roles.
 */
export function getFeaturesForRole(role: string): SessionFeatures {
	return ROLE_FEATURES[role] ?? DEFAULT_ROLE_FEATURES;
}

// ---------------------------------------------------------------------------
// Tool defaults per role
// ---------------------------------------------------------------------------

/** Full coding toolset: read, write, shell, search, web */
const CODER_TOOLS = KNOWN_TOOLS.filter(
	(t) => !['Task', 'TaskOutput', 'TaskStop'].includes(t)
) as string[];

/** Done node agent: read-only summarization — no Write or Edit */
const DONE_TOOLS: string[] = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

/** Planner uses the same toolset as coder (orchestration patterns reserved for future) */
const PLANNER_TOOLS = CODER_TOOLS;

/** Reviewers read-only — no Write or Edit */
const REVIEWER_TOOLS: string[] = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

/** QA: read-only + bash for running tests — no Write or Edit */
const QA_TOOLS: string[] = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

/**
 * Tool profiles per role. Exported for testing and external consumption.
 * Keys match the SpaceAgent.role value.
 */
export const ROLE_TOOLS: Record<string, string[]> = {
	coder: CODER_TOOLS,
	general: DONE_TOOLS,
	planner: PLANNER_TOOLS,
	reviewer: REVIEWER_TOOLS,
	qa: QA_TOOLS,
};

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

interface PresetDefinition {
	name: string;
	role: SpaceAgent['role'];
	description: string;
	tools: string[];
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
		description:
			'Done node agent. Reads gate data from completed workflow stages and produces a ' +
			'comprehensive human-readable summary of what was accomplished.',
		tools: DONE_TOOLS,
	},
	{
		name: 'Planner',
		role: 'planner',
		description:
			'Planning agent. Breaks down goals into actionable tasks and drafts implementation plans.',
		tools: PLANNER_TOOLS,
	},
	{
		name: 'Reviewer',
		role: 'reviewer',
		description:
			'Code review specialist. Reviews pull requests for correctness, style, and test coverage.',
		tools: REVIEWER_TOOLS,
	},
	{
		name: 'QA',
		role: 'qa',
		description:
			'Quality assurance specialist. Verifies test coverage, runs test suites, and checks CI pipeline status.',
		tools: QA_TOOLS,
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
 * Seed the five preset SpaceAgents for a newly-created Space.
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
		});

		if (result.ok) {
			seeded.push(result.value);
		} else {
			errors.push({ name: preset.name, error: result.error });
		}
	}

	return { seeded, errors };
}
