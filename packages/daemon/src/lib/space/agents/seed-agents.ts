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
 *   - General  — general-purpose worker
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
// Tool defaults per preset agent
// ---------------------------------------------------------------------------

/** Full coding toolset: read, write, shell, search, web */
const CODER_TOOLS = KNOWN_TOOLS.filter(
	(t) => !['Task', 'TaskOutput', 'TaskStop'].includes(t)
) as string[];

/** General-purpose worker: full coding toolset */
const GENERAL_TOOLS = CODER_TOOLS;

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
export const PRESET_AGENT_TOOLS: Record<string, string[]> = {
	coder: CODER_TOOLS,
	general: GENERAL_TOOLS,
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
	/** Combined operator-supplied prompt (persona + operating procedure). */
	customPrompt: string;
}

const PRESET_AGENTS: PresetDefinition[] = [
	{
		name: 'Coder',
		description:
			'Implementation worker. Writes code, runs tests, commits changes, and opens pull requests.',
		tools: CODER_TOOLS,
		customPrompt:
			'You are an expert software engineer. You write clean, well-tested code following the ' +
			"project's existing conventions. You always commit your work, keep the working tree clean, " +
			'and open pull requests for review.\n\n' +
			'Before finishing: ensure all tests pass, commit all changes, and open a PR with a clear description.',
	},
	{
		name: 'General',
		description:
			'General-purpose worker. Handles a wide range of tasks including coding, documentation, ' +
			'debugging, and analysis.',
		tools: GENERAL_TOOLS,
		customPrompt:
			'You are a versatile software development assistant. You can write code, fix bugs, write documentation, ' +
			'analyze problems, and handle any general development task. You adapt to what is needed.\n\n' +
			'Understand the task, implement the solution, verify it works, and commit your changes.',
	},
	{
		name: 'Planner',
		description:
			'Planning agent. Breaks down goals into actionable tasks and drafts implementation plans.',
		tools: PLANNER_TOOLS,
		customPrompt:
			'You are a technical project manager. You analyze goals, break them down into clear actionable ' +
			'tasks, identify dependencies, and produce structured implementation plans.\n\n' +
			'Produce a concrete plan with clear steps. Write the plan to a file and commit it.',
	},
	{
		name: 'Research',
		description:
			'Research agent. Investigates topics, gathers information, writes findings to docs, and opens pull requests with research results.',
		tools: RESEARCH_TOOLS,
		customPrompt:
			'You are a research specialist. You investigate topics thoroughly using web search and code ' +
			'exploration, synthesize findings clearly, and document results in well-structured markdown files.\n\n' +
			'Save all findings to a markdown file, commit the file, and open a PR with a summary of what you found.',
	},
	{
		name: 'Reviewer',
		description:
			'Code review specialist. Reviews pull requests for correctness, style, and test coverage.',
		tools: REVIEWER_TOOLS,
		customPrompt:
			'You are an expert code reviewer. You review pull requests for correctness, security, performance, ' +
			'style, and test coverage. You give specific, actionable feedback.\n\n' +
			'Review the code thoroughly. If satisfied, summarize your findings. If changes are needed, provide ' +
			'specific feedback.',
	},
	{
		name: 'QA',
		description:
			'Quality assurance specialist. Verifies test coverage, runs test suites, and checks CI pipeline status.',
		tools: QA_TOOLS,
		customPrompt:
			'You are a quality assurance engineer. You verify test coverage, run test suites, check CI status, ' +
			'and ensure the codebase meets quality standards before release.\n\n' +
			'Run the full test suite and report results with specific details on any failures.',
	},
];

export type PresetAgentTemplate = PresetDefinition;

/**
 * Returns canonical preset agent templates from the same source used by seeding.
 * The result is cloned so callers can safely mutate without affecting globals.
 */
export function getPresetAgentTemplates(): PresetAgentTemplate[] {
	return PRESET_AGENTS.map((preset) => ({
		...preset,
		tools: [...preset.tools],
	}));
}

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
			customPrompt: preset.customPrompt,
		});

		if (result.ok) {
			seeded.push(result.value);
		} else {
			errors.push({ name: preset.name, error: result.error });
		}
	}

	return { seeded, errors };
}
