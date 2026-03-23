/**
 * General Agent Factory - Creates AgentSessionInit for General (fallback worker) sessions
 *
 * The General agent handles non-coding tasks within a session group. It has access
 * to the same Claude Code tools as the Coder agent but uses a more generic system
 * prompt that doesn't assume a coding context.
 *
 * Used when the Planner assigns a task that doesn't fit a specific agent type.
 */

import type { AgentSessionInit } from '../../agent/agent-session';
import type { Room, RoomGoal, NeoTask, SessionFeatures } from '@neokai/shared';

const DEFAULT_GENERAL_MODEL = 'claude-sonnet-4-5-20250929';

const GENERAL_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export interface GeneralAgentConfig {
	task: NeoTask;
	goal: RoomGoal | null;
	room: Room;
	sessionId: string;
	workspacePath: string;
	model?: string;
	/** Provider ID for this session — auto-detected from model if omitted */
	provider?: string;
	/** Summaries of previously completed tasks in the same goal */
	previousTaskSummaries?: string[];
}

/**
 * Build the behavioral system prompt for the General agent.
 *
 * Contains ONLY role definition and behavioral rules.
 * Task-specific context (title, description, goal, room background) is delivered
 * via the initial user message built by buildGeneralTaskMessage().
 */
export function buildGeneralSystemPrompt(): string {
	const sections: string[] = [];

	sections.push(`You are a General Agent working on a task within a larger goal.`);
	sections.push(`Your job is to complete the task described below to the best of your ability.`);
	sections.push(`Work carefully and produce concrete deliverables, then finish your response.`);

	// Mandatory Git workflow
	sections.push(`\n## Git Workflow (MANDATORY)\n`);
	sections.push(
		`You are working in an isolated git worktree on a feature branch. ` +
			`The branch has already been created for you. Follow this workflow:`
	);
	sections.push(
		`1. **Sync with the default branch first** — run all three lines as a **single bash invocation** (variables persist within one call):\n` +
			`   \`\`\`bash\n` +
			`   DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')\n` +
			`   [ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')\n` +
			`   git fetch origin && git rebase origin/$DEFAULT_BRANCH\n` +
			`   \`\`\`\n` +
			`   **If the rebase fails with conflicts, stop immediately and report the error** — do NOT continue on a stale base`
	);
	sections.push(
		`2. Complete the task and create durable artifacts in the repo (docs, reports, scripts, or other files appropriate to the task)`
	);
	sections.push(`3. Commit your changes with a clear message`);
	sections.push(`4. Push your branch: \`git push -u origin HEAD\``);
	sections.push(
		`5. Create a pull request — detect the default branch inside the subshell (no persistent variable needed):\n` +
			`   \`\`\`bash\n` +
			`   gh pr create --fill --base $(b=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'); [ -z "$b" ] && b=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p'); echo "$b")\n` +
			`   \`\`\``
	);
	sections.push(`6. Finish your response`);
	sections.push(``);
	sections.push(
		`**IMPORTANT**: Do NOT commit directly to the main/dev/master branch. ` +
			`The runtime enforces this — you will be sent back if no feature branch and PR exist.`
	);

	// Bypass markers for research/verification tasks
	sections.push(`\n## Bypassing Git/PR Gates for Research-Only Tasks\n`);
	sections.push(
		`For **research-only**, **verification-only**, or **investigation-only** tasks that do NOT modify any files, ` +
			`you can bypass the git/PR requirements by starting your final output with one of these markers:`
	);
	sections.push(
		`- \`RESEARCH_ONLY:\` — For pure research tasks (e.g., "Analyze and document X")\n` +
			`- \`VERIFICATION_COMPLETE:\` — For verification tasks (e.g., "Verify Y is correct")\n` +
			`- \`INVESTIGATION_RESULT:\` — For investigation tasks (e.g., "Investigate why Z fails")\n` +
			`- \`ANALYSIS_COMPLETE:\` — For analysis tasks (e.g., "Analyze performance")`
	);
	sections.push(
		`**Example**:\n` +
			`\`\`\`\n` +
			`RESEARCH_ONLY:\n\n` +
			`I have researched the codebase and documented the following findings:\n` +
			`1. The authentication module lives in packages/daemon/src/lib/auth\n` +
			`2. It supports both API key and OAuth token flows\n\n` +
			`No code changes are needed for this task.\n` +
			`\`\`\``
	);
	sections.push(
		`**Important**: Only use bypass markers when the task genuinely requires NO file changes. ` +
			`If you need to create or modify any files, follow the normal git/PR workflow instead.`
	);

	// Review feedback handling
	sections.push(`\n## Addressing Review Feedback\n`);
	sections.push(
		`When you receive feedback containing GitHub review URLs, fetch each review by its ID:`
	);
	sections.push(
		`1. Extract the review ID from the URL (e.g. \`#pullrequestreview-3900806436\` → ID is \`3900806436\`)`
	);
	sections.push(
		`2. Fetch each review: \`GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews/{review_id} --jq '.body'\``
	);
	sections.push(`3. Read the review body and address the requested changes`);
	sections.push(`4. Push your updates: \`git push\``);
	sections.push(
		`5. Finish your response — the leader will continue the review workflow for the next round`
	);

	return sections.join('\n');
}

/**
 * Build the initial user message for the General agent.
 *
 * Contains task-specific context: task title/description, goal context,
 * project background, room instructions, and previous task summaries.
 * This is what the user sees in the UI as the agent's starting prompt.
 */
export function buildGeneralTaskMessage(config: GeneralAgentConfig): string {
	const { task, goal, room, previousTaskSummaries } = config;

	const sections: string[] = [];

	// Task context
	sections.push(`## Task\n`);
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) {
		sections.push(`**Priority:** ${task.priority}`);
	}

	// Goal context (only if a goal is linked)
	if (goal) {
		sections.push(`\n## Goal Context\n`);
		sections.push(`**Goal:** ${goal.title}`);
		if (goal.description) {
			sections.push(`**Description:** ${goal.description}`);
		}
	}

	// Room context
	if (room.background) {
		sections.push(`\n## Project Context\n`);
		sections.push(room.background);
	}
	if (room.instructions) {
		sections.push(`\n## Instructions\n`);
		sections.push(room.instructions);
	}

	// Previous task summaries
	if (previousTaskSummaries && previousTaskSummaries.length > 0) {
		sections.push(`\n## Previous Work on This Goal\n`);
		sections.push(`The following tasks have already been completed for this goal:`);
		for (const summary of previousTaskSummaries) {
			sections.push(`- ${summary}`);
		}
	}

	sections.push(`\nBegin working on this task.`);

	return sections.join('\n');
}

/**
 * Create an AgentSessionInit for a General agent session.
 *
 * The General agent uses the Claude Code preset (standard tools)
 * with a behavioral system prompt appended. Task-specific context is
 * delivered via the initial user message (buildGeneralTaskMessage).
 */
export function createGeneralAgentInit(config: GeneralAgentConfig): AgentSessionInit {
	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: buildGeneralSystemPrompt(),
		},
		features: GENERAL_FEATURES,
		context: { roomId: config.room.id },
		type: 'general',
		model: config.model ?? DEFAULT_GENERAL_MODEL,
		provider: config.provider,
		contextAutoQueue: false,
	};
}
