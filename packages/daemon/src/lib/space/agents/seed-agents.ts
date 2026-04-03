/**
 * Space Preset Agent Seeding
 *
 * Seeds the six default SpaceAgent records when a new Space is created.
 * Preset agents are regular SpaceAgent rows — fully editable by users — that
 * have sensible defaults for tools and model.
 * SpaceRuntime resolves all agents by ID at runtime; there is no special
 * builtin code path.
 *
 * Preset agents seeded per Space:
 *   - Coder    — implementation worker
 *   - General  — general-purpose worker (Done node agent)
 *   - Planner  — planning/orchestration worker
 *   - Research — research specialist (investigates topics, writes findings, opens PRs)
 *   - Reviewer — code review specialist
 *   - QA       — quality assurance specialist
 */

import type { SpaceAgent } from '@neokai/shared';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgentManager, SpaceAgentResult } from '../managers/space-agent-manager';

// ---------------------------------------------------------------------------
// Sub-session features
// ---------------------------------------------------------------------------

/**
 * Features for all sub-session agents (node agents spawned by the Task Agent).
 * Sub-sessions are internal and should not expose rewind, worktree, coordinator,
 * archive, or sessionInfo UI features.
 */
export const SUB_SESSION_FEATURES = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
} as const;

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

/** Research uses the same toolset as coder (needs write access to commit findings and open PRs) */
const RESEARCH_TOOLS = CODER_TOOLS;

/** Reviewers read-only — no Write or Edit */
const REVIEWER_TOOLS: string[] = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

/** QA: read-only + bash for running tests — no Write or Edit */
const QA_TOOLS: string[] = ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

/**
 * Tool profiles per preset agent name. Exported for testing and external consumption.
 */
export const ROLE_TOOLS: Record<string, string[]> = {
	coder: CODER_TOOLS,
	general: DONE_TOOLS,
	planner: PLANNER_TOOLS,
	research: RESEARCH_TOOLS,
	reviewer: REVIEWER_TOOLS,
	qa: QA_TOOLS,
};

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

interface PresetDefinition {
	name: string;
	description: string;
	tools: string[];
	systemPrompt: string;
	instructions: string;
}

const PRESET_AGENTS: PresetDefinition[] = [
	{
		name: 'Coder',
		description:
			'Implementation worker. Writes code, runs tests, commits changes, and opens pull requests.',
		tools: CODER_TOOLS,
		systemPrompt:
			'You are an expert software engineer. You write clean, well-tested code following the ' +
			"project's existing conventions. You always commit your work, keep the working tree clean, " +
			'and open pull requests for review.',
		instructions:
			'Before finishing: ensure all tests pass, commit all changes, and open a PR with a clear description.',
	},
	{
		name: 'General',
		description:
			'Done node agent. Reads gate data from completed workflow stages and produces a ' +
			'comprehensive human-readable summary of what was accomplished.',
		tools: DONE_TOOLS,
		systemPrompt:
			'You are a summarization agent. You read completed task outputs and gate data, then produce ' +
			'a clear, human-readable summary of what was accomplished.',
		instructions:
			'Read all available gate data and workflow outputs. Write a comprehensive summary of the completed work.',
	},
	{
		name: 'Planner',
		description:
			'Planning agent. Breaks down goals into actionable tasks and drafts implementation plans.',
		tools: PLANNER_TOOLS,
		systemPrompt:
			'You are a technical project manager. You analyze goals, break them down into clear actionable ' +
			'tasks, identify dependencies, and produce structured implementation plans.',
		instructions:
			'Produce a concrete plan with clear steps. Write the plan to a file and commit it.',
	},
	{
		name: 'Research',
		description:
			'Research agent. Investigates topics, gathers information, writes findings to docs, and opens pull requests with research results.',
		tools: RESEARCH_TOOLS,
		systemPrompt:
			'You are a research specialist. You investigate topics thoroughly using web search and code ' +
			'exploration, synthesize findings clearly, and document results in well-structured markdown files.',
		instructions:
			'Save all findings to a markdown file, commit the file, and open a PR with a summary of what you found.',
	},
	{
		name: 'Reviewer',
		description:
			'Code review specialist. Reviews pull requests for correctness, style, and test coverage.',
		tools: REVIEWER_TOOLS,
		systemPrompt:
			'You are an expert code reviewer. You review pull requests for correctness, security, performance, ' +
			'style, and test coverage. You give specific, actionable feedback.',
		instructions:
			'Review the open PR thoroughly. If satisfied, call report_done(). If changes are needed, provide ' +
			'specific feedback and send back for revision.',
	},
	{
		name: 'QA',
		description:
			'Quality assurance specialist. Verifies test coverage, runs test suites, and checks CI pipeline status.',
		tools: QA_TOOLS,
		systemPrompt:
			'You are a quality assurance engineer. You verify test coverage, run test suites, check CI status, ' +
			'and ensure the codebase meets quality standards before release.',
		instructions:
			"Run the full test suite. Write result='passed' or result='failed' to the gate with specific details on any failures.",
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
 * Seed the six preset SpaceAgents for a newly-created Space.
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
			description: preset.description,
			tools: preset.tools,
			systemPrompt: preset.systemPrompt,
			instructions: preset.instructions,
		});

		if (result.ok) {
			seeded.push(result.value);
		} else {
			errors.push({ name: preset.name, error: result.error });
		}
	}

	return { seeded, errors };
}
