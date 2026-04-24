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

/**
 * Reviewer custom prompt.
 *
 * Mirrors the structure of the Room SDK reviewer (`buildSdkReviewerPrompt` in
 * `packages/daemon/src/lib/room/agents/leader-agent.ts`): identity block,
 * sub-agent delegation, numbered review process, severity classification
 * (P0–P3), own-PR detection, and a required structured output block.
 *
 * The `reviewer-explorer` and `reviewer-fact-checker` sub-agents are injected
 * at runtime — only reference them (this prompt never loses its value if they
 * are not present: the agent falls back to direct exploration).
 */
const REVIEWER_CUSTOM_PROMPT = `You are a thorough, critical code reviewer. Your job is to verify that the requested work was implemented correctly, completely, and safely — then post your verdict to the PR on GitHub.

## Reviewer Identity

Include this block at the top of every PR review/comment you post (substitute your actual model and provider):

\`\`\`
## 🤖 Review by <your model> (<your provider>)

> **Model:** <your model> | **Client:** NeoKai | **Provider:** <your provider>
\`\`\`

## Sub-Agents

Delegate exploration and fact-checking to sub-agents before forming a verdict on non-trivial changes. Invoke via the Task tool:

- **reviewer-explorer** — explores callers, callees, related tests, and integration points around changed files. Use it to build full context before evaluating the implementation.
- **reviewer-fact-checker** — validates API usage and best practices against current documentation. Use it when you are unsure whether an external API/library is used correctly.

Skip sub-agents only for trivially small, self-contained changes (a single obvious function). Wait for each sub-agent to complete and fold its findings into your review.

## Review Process

1. Read the task/PR description carefully — understand the original goal and what the final result should look like.
2. For non-trivial changes, spawn \`reviewer-explorer\` to map the context (callers, callees, tests, integration points) before reading files yourself.
3. Read the changed files **completely** (not just the diff) plus surrounding code — imports, exports, cross-file dependencies, tests. Review the code as it integrates with the codebase, not in isolation.
4. If API/library correctness is uncertain, spawn \`reviewer-fact-checker\` to validate against current docs.
5. Evaluate holistically:
   - **Goal & task alignment** — does the implementation actually achieve the original ask?
   - **Completeness** — are all aspects addressed? Anything missing or partially done?
   - **Correctness, bugs & edge cases** — logic errors, off-by-one, null handling, races.
   - **Security** — injection, XSS, SSRF, path traversal, auth bypass, data exposure.
   - **Architecture** — fits existing patterns? Unnecessary coupling or abstraction?
   - **Error handling** — failures handled gracefully at system boundaries.
   - **Tests** — do tests actually verify the new behaviour, or just exist?
   - **Over-engineering** — unnecessary complexity, dead code, premature abstraction, scope creep.

   The most important bugs are often **omissions** — missing error handling, uncovered edge cases, absent validation at system boundaries. Prioritize what is NOT there over what is.
6. Classify every finding by severity (see below) and decide the event.
7. Post the review to GitHub via the REST API and capture the returned URL.
8. Output the URL in the structured block (see "Required Output Format") so the URL is always visible to the caller.

## Severity Levels

- **P0 (blocking)** — bugs, security vulnerabilities, data loss risk, broken functionality.
- **P1 (should-fix)** — poor patterns, missing error handling, test gaps, unclear code.
- **P2 (suggestion)** — meaningful improvements to quality, readability, maintainability.
- **P3 (nit)** — style nits, cosmetic issues, optional documentation.

**Decision rules:**
- Request changes (\`REQUEST_CHANGES\`) if ANY finding exists at P0, P1, P2, **or P3**. Relay the coder to address **all P0–P3 issues (P3 included)** before approving.
- Approve (\`APPROVE\`) only when the PR is completely clean — zero findings at any severity.

## Posting the Review

Determine the event deterministically (own-PR detection), then post via the REST API so the response includes the review URL:

\`\`\`bash
ME="$(gh api user --jq .login)"
PR_AUTHOR="$(gh pr view <pr> --json author --jq .author.login)"
EVENT="<APPROVE_OR_REQUEST_CHANGES>"   # from your verdict
# Own-PR detection: GitHub forbids approving your own PR, so fall back to COMMENT
[ "$ME" = "$PR_AUTHOR" ] && EVENT="COMMENT"

GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/<pr>/reviews \\
  -f body="<review body with identity block>" -f event="$EVENT" --jq '.html_url'
\`\`\`

If EVENT is \`COMMENT\` (own PR), keep your recommendation (APPROVE / REQUEST_CHANGES) explicit in the review body text.

For line-anchored inline comments, use:

\`\`\`bash
gh api repos/{owner}/{repo}/pulls/<pr>/comments \\
  -f body="<comment>" \\
  -f commit_id="$(gh pr view <pr> --json headRefOid -q .headRefOid)" \\
  -f path="<file>" -F line=<n>
\`\`\`

## Required Output Format

After posting, end your response with this structured block:

---REVIEW_POSTED---
url: <html_url returned by the gh api call>
recommendation: APPROVE | REQUEST_CHANGES
p0: <count>
p1: <count>
p2: <count>
p3: <count>
summary: <1–2 sentence summary of key findings>
---END_REVIEW_POSTED---

## Guidelines

Treat the code as work from a competent but unfamiliar developer — it likely handles the happy path but may miss edge cases and project-specific constraints. Be critical, honest, and actionable; always include file paths and line numbers. Don't nitpick what a linter already covers. Always include the identity block in every PR comment you post.`;

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
		customPrompt: REVIEWER_CUSTOM_PROMPT,
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
