/**
 * Leader Agent Factory - Creates AgentSessionInit for Leader (reviewer) sessions
 *
 * The Leader agent reviews worker output and routes outcomes via MCP tools:
 * - send_to_worker(message, mode) - Forward feedback to worker (steer/queue)
 * - handoff_to_worker() - Explicitly return control to worker
 * - complete_task(summary) - Accept work, mark task done
 * - fail_task(reason) - Task is not achievable
 * - replan_goal(reason) - Fail task and trigger replanning with context
 *
 * Leader tools are MCP callbacks that route through the RoomRuntime.
 * The Leader adapts its review focus based on reviewContext:
 * - 'plan_review': Evaluates task breakdown quality, coverage, ordering
 * - 'code_review': Evaluates implementation correctness, completeness
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentSessionInit } from '../../agent/agent-session';
import type {
	Room,
	RoomGoal,
	NeoTask,
	SessionFeatures,
	McpServerConfig,
	AgentDefinition,
} from '@neokai/shared';
import type { GoalManager } from '../managers/goal-manager';
import type { TaskManager } from '../managers/task-manager';
import type { SessionGroupRepository } from '../state/session-group-repository';
import type { DaemonHub } from '../../daemon-hub';
import type { RoomRuntime } from '../runtime/room-runtime';
import { createRoomAgentMcpServer } from '../tools/room-agent-tools';

const DEFAULT_LEADER_MODEL = 'claude-sonnet-4-5-20250929';

const LEADER_FEATURES: SessionFeatures = {
	rewind: false,
	worktree: false,
	coordinator: false,
	archive: false,
	sessionInfo: false,
};

export type ReviewContext = 'plan_review' | 'code_review';

export interface LeaderToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

/**
 * Callback interface for Leader tool routing.
 * The RoomRuntime implements this to handle tool calls.
 */
export interface LeaderToolCallbacks {
	sendToWorker(
		groupId: string,
		message: string,
		mode?: 'steer' | 'queue'
	): Promise<LeaderToolResult>;
	handoffToWorker(groupId: string): Promise<LeaderToolResult>;
	completeTask(groupId: string, summary: string): Promise<LeaderToolResult>;
	failTask(groupId: string, reason: string): Promise<LeaderToolResult>;
	replanGoal(groupId: string, reason: string): Promise<LeaderToolResult>;
	submitForReview(groupId: string, prUrl: string): Promise<LeaderToolResult>;
}

export interface LeaderAgentConfig {
	task: NeoTask;
	goal: RoomGoal;
	room: Room;
	sessionId: string;
	workspacePath: string;
	groupId: string;
	model?: string;
	/** What type of work is being reviewed */
	reviewContext?: ReviewContext;
	/** Dependencies for room-agent-tools MCP server (optional - only needed when creating MCP server) */
	goalManager?: GoalManager;
	taskManager?: TaskManager;
	groupRepo?: SessionGroupRepository;
	/** Optional: DaemonHub for emitting events (used for UI notifications) */
	daemonHub?: DaemonHub;
	/** Optional: Runtime service for runtime operations */
	runtimeService?: {
		getRuntime(roomId: string): RoomRuntime | null;
	};
}

/**
 * Build the behavioral system prompt for the Leader agent.
 *
 * Contains ONLY role definition, tool contract, handling rules, and review guidelines.
 * Task-specific context (task title/description, goal context, review policy from
 * room.instructions) is delivered via buildLeaderTaskContext() which gets prepended
 * to the worker output envelope.
 *
 * Adapts review guidelines based on whether reviewing a plan or code.
 */
export function buildLeaderSystemPrompt(config: LeaderAgentConfig): string {
	const { reviewContext } = config;
	const isPlanReview = reviewContext === 'plan_review';

	const sections: string[] = [];

	if (isPlanReview) {
		sections.push(
			`You are a Leader Agent responsible for reviewing a plan created by a Planner Agent.`
		);
		sections.push(`Your job is to evaluate the task breakdown against the goal requirements.`);
	} else {
		sections.push(`You are a Leader Agent responsible for reviewing work done by a worker agent.`);
		sections.push(`Your job is to evaluate the worker's output against the task requirements.`);
	}

	// Tool contract
	sections.push(`\n## Tool Contract (CRITICAL)\n`);
	sections.push(`You MUST call tools (no text-only final responses).`);
	sections.push(
		`- \`send_to_worker\` — Forward feedback to worker without changing group ownership`
	);
	sections.push(
		`  - mode=\`queue\`: enqueue for next-turn processing (default, preferred for review URLs)`
	);
	sections.push(`  - mode=\`steer\`: inject for current-turn steering`);
	sections.push(`- \`handoff_to_worker\` — Explicitly return ownership to worker`);
	sections.push(`- \`complete_task\` — Accept the work if it meets all requirements`);
	sections.push(`- \`fail_task\` — Mark the task as not achievable`);
	sections.push(
		`- \`replan_goal\` — The current approach isn't working; fail this task and trigger replanning with context about what was tried`
	);
	sections.push(
		`- \`submit_for_review\` — Work is done with a PR ready; submit for peer review and human approval\n`
	);
	sections.push(`Do NOT respond with only text.`);

	// Post-approval workflow (when human approves after submit_for_review)
	// Differs by task type: planning tasks require a Phase 2 worker run to create tasks;
	// coder/general tasks are completed directly by the leader (merge + complete_task).
	sections.push(`\n## Post-Approval Workflow (CRITICAL)\n`);
	sections.push(
		`When the human message indicates approval (e.g., "approved", "merge it", "looks good"):`
	);

	if (isPlanReview) {
		// Planning tasks: planner must run Phase 2 (merge plan PR + create tasks)
		sections.push(
			`\nFor planning tasks the planner must run a second phase to create tasks.\n` +
				`**Do NOT merge the plan PR yourself — the planner handles merge + task creation.**\n`
		);
		sections.push(
			`1. **Send the planner back** — Call \`send_to_worker\` (mode: "queue") with:\n` +
				`   "The plan is approved. Please:\n` +
				`   1. Merge the plan PR: \`gh pr merge <PR_NUMBER> --merge\`\n` +
				`   2. Read the plan file under docs/plans/\n` +
				`   3. Create all tasks 1:1 from the plan using the \`create_task\` tool\n` +
				`   4. Finish your response after all tasks are created"`
		);
		sections.push(
			`2. **Hand off to planner** — Call \`handoff_to_worker\` so the planner can run.`
		);
		sections.push(
			`3. **After planner exits with tasks created** — When you next receive \`[PLANNER OUTPUT]\` showing ` +
				`"Phase 2 (task creation)" and "Tasks created: N", call \`complete_task\` with a summary.`
		);
		sections.push(
			`\n**IMPORTANT**: The planner must use the \`create_task\` tool to register tasks. ` +
				`You cannot call \`complete_task\` until tasks are created — the runtime gate will reject it.`
		);
	} else {
		sections.push(
			`\n1. **Merge the PR** — Use \`gh pr merge\` to merge the approved PR:\n` +
				`   \`\`\`bash\n   gh pr merge <PR_NUMBER> --squash --delete-branch\n   \`\`\`\n`
		);
		sections.push(`2. **Sync the root repo** — Pull the merged changes into the root workspace:`);
		sections.push(
			`   \`\`\`bash\n   DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')\n   ` +
				`[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')\n   ` +
				`git fetch origin && git pull origin $DEFAULT_BRANCH\n   \`\`\`\n`
		);
		sections.push(
			`3. **Call \`complete_task\`** — Mark the task done with a summary of what was accomplished.`
		);
		sections.push(
			`\n**IMPORTANT**: Do NOT send the worker back to do the merge. The leader handles merge and completion after human approval.`
		);
	}

	// Post-rejection workflow (when human rejects and provides feedback)
	sections.push(`\n## Post-Rejection Workflow\n`);
	sections.push(
		`When the human message indicates rejection with feedback (e.g., "fix the tests", "needs changes"):`
	);
	sections.push(
		`\n1. **Forward feedback to worker** — Call \`send_to_worker\` (mode: "queue") with the human's feedback`
	);
	sections.push(
		`2. **Hand off to worker** — Call \`handoff_to_worker\` so the worker can address the feedback`
	);
	sections.push(
		`\nAfter the worker addresses feedback and exits again, you will receive the updated output for review.`
	);

	// Handling worker questions
	sections.push(`\n## Handling Worker Questions\n`);
	sections.push(
		`If the worker output shows \`Terminal state: waiting_for_input\`, the worker is asking a question.`
	);
	sections.push(
		`- If you can answer the question from the goal/task context, call \`send_to_worker\` (mode: "steer") with the answer, then call \`handoff_to_worker\``
	);
	sections.push(
		`- If the question requires human judgment or information you don't have, use \`fail_task\` with the reason (e.g., "Worker needs human input: <question>")`
	);

	// Context-specific review guidelines
	if (isPlanReview) {
		// Check if room has reviewer sub-agents configured for plan review
		const roomConfig = config.room.config ?? {};
		const planReviewerConfigs = getLeaderSubagents(roomConfig);
		const hasPlanReviewers = planReviewerConfigs && planReviewerConfigs.length > 0;

		if (hasPlanReviewers) {
			// Build reviewer names using the same logic as buildReviewerAgents
			const usedNames = new Set<string>();
			const reviewerNames: string[] = [];
			for (const reviewer of planReviewerConfigs!) {
				reviewerNames.push(toReviewerName(reviewer, usedNames));
			}

			sections.push(`\n## Available Specialists (via Task subagent_type)\n`);
			sections.push(`Custom: ${reviewerNames.join(', ')}\n`);

			sections.push(`## Plan Review Orchestration Workflow\n`);
			sections.push(
				`You are a coordinator. You do NOT review the plan yourself. You delegate reviews to specialist reviewer sub-agents, collect their review links, and forward those links to the worker.\n`
			);
			sections.push(
				`**Every iteration follows the same workflow** — including after the worker addresses feedback. Always re-dispatch reviewers; never evaluate the fix yourself.\n`
			);

			sections.push(`### Step 1: Understand the Plan`);
			sections.push(
				`Read the planner's output to understand what plan was created and what PR was opened.`
			);
			sections.push(
				`Extract the PR number (look for "PR #123", GitHub PR URLs, or \`gh pr create\` output).`
			);
			sections.push(
				`If no PR was created, call \`send_to_worker\` (mode: "queue") asking the planner to create one before review can proceed, then call \`handoff_to_worker\`.\n`
			);

			sections.push(`### Step 2: Dispatch Reviewer Sub-agents`);
			sections.push(
				`Use the Task tool to dispatch each reviewer to review the plan PR. Spawn all reviewers in parallel.\n`
			);
			for (const name of reviewerNames) {
				sections.push(
					`- Task(subagent_type: "${name}", prompt: "Review PR #<NUMBER>. This is a PLAN review (not code). The planner created a plan to break down a goal into tasks. Review the plan for completeness, task scoping, ordering, acceptance criteria, and feasibility. Post your honest, critical, and actionable feedback using gh pr review.")`
				);
			}

			sections.push(`\n### Step 3: Collect Review Results`);
			sections.push(
				`Each reviewer returns a \`---REVIEW_POSTED---\` block containing the review URL, recommendation, and P0/P1/P2/P3 issue counts.\n`
			);
			sections.push(`### Step 4: Route\n`);
			sections.push(
				`- **Any P0/P1/P2 issues** → call \`send_to_worker\` with \`mode: "queue"\` and ONLY the review URLs (one per line). Do NOT summarize or interpret the reviews — the worker will fetch the full review content from GitHub.`
			);
			sections.push(
				`  - You may call \`send_to_worker\` multiple times as reviewer results arrive. When done forwarding for this cycle, call \`handoff_to_worker\`.`
			);
			sections.push(
				`- **Only P3 nits or no issues** → \`submit_for_review\` with the PR URL for human approval`
			);
			sections.push(
				`- **TIMEOUT or ERROR** → Ignore that reviewer's result. Route based on the remaining reviewers' results. If all reviewers timed out/errored, \`submit_for_review\` with the PR URL (let human decide).`
			);
			sections.push(`- **Fundamentally unplannable** → \`fail_task\` or \`replan_goal\``);
			sections.push(
				`\nDo NOT call \`complete_task\` after Phase 1 — the plan must be reviewed by a human first. ` +
					`After the planner runs Phase 2 and you receive \`[PLANNER OUTPUT] — Phase 2 (task creation)\`, call \`complete_task\`.`
			);
		} else {
			sections.push(`\n## Plan Review Guidelines\n`);
			sections.push(
				`**Phase 1 (plan document)**: When you receive \`[PLANNER OUTPUT] — Phase 1 (plan document)\`, follow this workflow:`
			);
			sections.push(`1. Read the planner output and extract the PR number/URL.`);
			sections.push(
				`2. If no PR exists yet, use \`send_to_worker\` (mode: "queue") to request one, then call \`handoff_to_worker\`.`
			);
			sections.push(
				`3. Review the plan PR yourself and post your honest, critical, and actionable feedback on the PR using \`gh pr review\`.`
			);
			sections.push(`4. Route strictly by severity from your posted review:`);
			sections.push(
				`   - **Any P0/P1/P2 issues** → \`send_to_worker\` (mode: "queue") with ONLY your review URL(s), one per line. Do NOT paste full review text into the worker message. Then call \`handoff_to_worker\`.`
			);
			sections.push(
				`   - **Only P3 nits or no issues** → \`submit_for_review\` with the PR URL for human approval.`
			);
			sections.push(
				`   - **Review post TIMEOUT/ERROR** → \`submit_for_review\` with the PR URL (let human decide).`
			);
			sections.push(`5. **Fundamentally unplannable** → \`fail_task\` or \`replan_goal\`.`);
			sections.push(
				`6. Do NOT call \`complete_task\` after Phase 1 — the plan must be reviewed by a human first.`
			);
			sections.push(
				`\n**Phase 2 (task creation)**: When you receive \`[PLANNER OUTPUT] — Phase 2 (task creation)\` showing "Tasks created: N", call \`complete_task\` with a summary of the tasks created.`
			);
		}
	} else {
		// Check if room has reviewer sub-agents configured
		const roomConfig = config.room.config ?? {};
		const reviewerConfigs = getLeaderSubagents(roomConfig);
		const hasReviewers = reviewerConfigs && reviewerConfigs.length > 0;

		if (hasReviewers) {
			// Build reviewer names using the same logic as buildReviewerAgents
			const usedNames = new Set<string>();
			const reviewerNames: string[] = [];
			for (const reviewer of reviewerConfigs!) {
				reviewerNames.push(toReviewerName(reviewer, usedNames));
			}

			sections.push(`\n## Available Specialists (via Task subagent_type)\n`);
			sections.push(`Custom: ${reviewerNames.join(', ')}\n`);

			sections.push(`## Review Orchestration Workflow\n`);
			sections.push(
				`You are a coordinator. You do NOT review code yourself. You delegate reviews to specialist reviewer sub-agents, collect their review links, and forward those links to the worker.\n`
			);
			sections.push(
				`**Every iteration follows the same workflow** — including after the worker addresses feedback. Always re-dispatch reviewers; never evaluate the fix yourself.\n`
			);

			sections.push(`### Step 1: Understand What Was Done`);
			sections.push(
				`Read the worker's output to understand what was implemented and which files changed.`
			);
			sections.push(
				`Extract the PR number if one was created (look for "PR #123", GitHub PR URLs, or \`gh pr create\` output).`
			);
			sections.push(
				`If no PR was created, call \`send_to_worker\` (mode: "queue") asking the worker to create one before review can proceed, then call \`handoff_to_worker\`.\n`
			);

			sections.push(`### Step 2: Dispatch Reviewer Sub-agents`);
			sections.push(
				`Use the Task tool to dispatch each reviewer. Spawn all reviewers in parallel.\n`
			);
			for (const name of reviewerNames) {
				sections.push(
					`- Task(subagent_type: "${name}", prompt: "Review PR #<NUMBER>. The task was: <description>. The worker implemented: <summary>. Review the code and post your honest, critical, and actionable feedback using gh pr review.")`
				);
			}

			sections.push(`\n### Step 3: Collect Review Results`);
			sections.push(
				`Each reviewer returns a \`---REVIEW_POSTED---\` block containing the review URL, recommendation, and P0/P1/P2/P3 issue counts.\n`
			);
			sections.push(`### Step 4: Route\n`);
			sections.push(
				`- **Any P0/P1/P2 issues** → call \`send_to_worker\` with \`mode: "queue"\` and ONLY the review URLs (one per line). Do NOT summarize or interpret the reviews — the worker will fetch the full review content from GitHub.`
			);
			sections.push(
				`  - You may call \`send_to_worker\` multiple times as reviewer results arrive. When done forwarding for this cycle, call \`handoff_to_worker\`.`
			);
			sections.push(`- **Only P3 nits or no issues** → \`submit_for_review\` with the PR URL`);
			sections.push(
				`- **TIMEOUT or ERROR** → Ignore that reviewer's result. Route based on the remaining reviewers' results. If all reviewers timed out/errored, \`submit_for_review\` with the PR URL (let human decide).`
			);
			sections.push(`- **Fundamentally broken** → \`fail_task\` or \`replan_goal\``);
		} else {
			sections.push(`\n## Code Review Guidelines\n`);
			sections.push(
				`**Every iteration follows the same workflow** — including after the worker addresses feedback.`
			);
			sections.push(`1. Read the worker output and extract the PR number/URL.`);
			sections.push(
				`2. Require a PR before final approval. If no PR exists yet, use \`send_to_worker\` (mode: "queue") to request one, then call \`handoff_to_worker\`.`
			);
			sections.push(
				`3. Review the PR yourself and post your honest, critical, and actionable feedback on the PR using \`gh pr review\`.`
			);
			sections.push(`4. Route strictly by severity from your posted review:`);
			sections.push(
				`   - **Any P0/P1/P2 issues** → \`send_to_worker\` (mode: "queue") with ONLY your review URL(s), one per line. Do NOT paste full review text into the worker message. Then call \`handoff_to_worker\`.`
			);
			sections.push(`   - **Only P3 nits or no issues** → \`submit_for_review\` with the PR URL.`);
			sections.push(
				`   - **Review post TIMEOUT/ERROR** → \`submit_for_review\` with the PR URL (let human decide).`
			);
		}

		sections.push(
			`\n- Use \`fail_task\` if this specific task is not achievable but the overall plan is still sound`
		);
		sections.push(
			`- Use \`replan_goal\` if the failure reveals the overall approach needs rethinking — this cancels remaining tasks and triggers a fresh plan`
		);
	}

	return sections.join('\n');
}

/**
 * Build the task context string for the Leader agent's initial message.
 *
 * Contains the task title/description, goal context, and review policy from
 * room.instructions. This is prepended to the worker output envelope so the
 * Leader knows what task is being reviewed without it being in the system prompt.
 */
export function buildLeaderTaskContext(config: LeaderAgentConfig): string {
	const { task, goal, room } = config;
	const sections: string[] = [];

	// Task context
	sections.push(`## Task Under Review\n`);
	sections.push(`**Title:** ${task.title}`);
	sections.push(`**Description:** ${task.description}`);
	if (task.priority) {
		sections.push(`**Priority:** ${task.priority}`);
	}

	// Goal context
	sections.push(`\n## Goal Context\n`);
	sections.push(`**Goal:** ${goal.title}`);
	if (goal.description) {
		sections.push(`**Description:** ${goal.description}`);
	}

	// Room review policy
	if (room.instructions) {
		sections.push(`\n## Review Policy\n`);
		sections.push(room.instructions);
	}

	return sections.join('\n');
}

/**
 * Create testable Leader tool handler functions.
 * These delegate to the provided callbacks which route through RoomRuntime.
 */
export function createLeaderToolHandlers(groupId: string, callbacks: LeaderToolCallbacks) {
	return {
		async send_to_worker(args: {
			message: string;
			mode?: 'steer' | 'queue';
		}): Promise<LeaderToolResult> {
			return callbacks.sendToWorker(groupId, args.message, args.mode);
		},
		async handoff_to_worker(): Promise<LeaderToolResult> {
			return callbacks.handoffToWorker(groupId);
		},
		async complete_task(args: { summary: string }): Promise<LeaderToolResult> {
			return callbacks.completeTask(groupId, args.summary);
		},
		async fail_task(args: { reason: string }): Promise<LeaderToolResult> {
			return callbacks.failTask(groupId, args.reason);
		},
		async replan_goal(args: { reason: string }): Promise<LeaderToolResult> {
			return callbacks.replanGoal(groupId, args.reason);
		},
		async submit_for_review(args: { pr_url: string }): Promise<LeaderToolResult> {
			return callbacks.submitForReview(groupId, args.pr_url);
		},
	};
}

/**
 * Create an MCP server with Leader review tools.
 * Tool callbacks route through the RoomRuntime via LeaderToolCallbacks.
 */
export function createLeaderMcpServer(groupId: string, callbacks: LeaderToolCallbacks) {
	const handlers = createLeaderToolHandlers(groupId, callbacks);

	const tools = [
		tool(
			'send_to_worker',
			'Send feedback to the worker agent. mode=queue (default) enqueues for next turn; mode=steer injects current-turn guidance.',
			{
				message: z.string().describe('Specific, actionable feedback for the worker agent'),
				mode: z
					.enum(['steer', 'queue'])
					.optional()
					.describe('Delivery mode: queue (default) or steer (immediate)'),
			},
			(args) => handlers.send_to_worker(args)
		),
		tool(
			'handoff_to_worker',
			'Explicitly return ownership to the worker after forwarding feedback',
			{},
			() => handlers.handoff_to_worker()
		),
		tool(
			'complete_task',
			'Accept the work and mark the task as completed',
			{
				summary: z
					.string()
					.describe('Summary of what was accomplished and how it meets requirements'),
			},
			(args) => handlers.complete_task(args)
		),
		tool(
			'fail_task',
			'Mark the task as not achievable',
			{
				reason: z.string().describe('Explanation of why the task cannot be completed'),
			},
			(args) => handlers.fail_task(args)
		),
		tool(
			'replan_goal',
			'Fail this task and trigger replanning — use when the overall approach needs rethinking',
			{
				reason: z
					.string()
					.describe('What was tried, what went wrong, and why a different approach is needed'),
			},
			(args) => handlers.replan_goal(args)
		),
		tool(
			'submit_for_review',
			'Work is done with a PR ready — free the group slot and park the task for human approval',
			{
				pr_url: z.string().min(1).describe('The GitHub PR URL for human review'),
			},
			(args) => handlers.submit_for_review(args)
		),
	];

	return createSdkMcpServer({ name: 'leader-agent-tools', tools });
}

/**
 * Sub-agent configuration (used in room.config.agentSubagents.{role})
 */
interface SubagentConfig {
	/** Model ID (e.g., 'claude-opus-4-6', 'gpt-5.3-codex') or CLI agent short name */
	model: string;
	/** Provider name (e.g., 'anthropic', 'openai', 'google') */
	provider?: string;
	/** Marks this reviewer as CLI-based (external tool orchestrated via Bash) */
	type?: 'cli';
	/** Full model ID when different from the short name in 'model' */
	modelId?: string;
	/** Model the CLI tool should use internally (e.g., copilot --model gpt-5.3-codex) */
	cliModel?: string;
}

/**
 * Read leader sub-agents from room config.
 * Path: room.config.agentSubagents.leader
 */
function getLeaderSubagents(roomConfig: Record<string, unknown>): SubagentConfig[] | undefined {
	const agentSubagents = roomConfig.agentSubagents as Record<string, SubagentConfig[]> | undefined;
	if (agentSubagents?.leader && agentSubagents.leader.length > 0) {
		return agentSubagents.leader;
	}
	return undefined;
}

/**
 * Extract a short, human-friendly name from a model ID.
 * e.g., 'claude-sonnet-4-5-20250929' → 'sonnet'
 *       'claude-haiku-4-5-20251001' → 'haiku'
 *       'gpt-5.3-codex' → 'codex'
 *       'codex-review' → 'codex-review'
 */
export function toShortModelName(modelId: string): string {
	const lower = modelId.toLowerCase();
	if (lower.includes('opus')) return 'opus';
	if (lower.includes('haiku')) return 'haiku';
	if (lower.includes('sonnet')) return 'sonnet';
	// 'codex-review' must be checked before 'codex' to avoid matching the shorter name
	if (lower === 'codex-review') return 'codex-review';
	if (lower.includes('codex')) return 'codex';
	if (lower.includes('copilot')) return 'copilot';
	// Fallback: take the first meaningful segment
	return modelId
		.replace(/[^a-zA-Z0-9]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 20);
}

/**
 * Map a full model ID to a valid AgentModel for the SDK.
 * The SDK only accepts: 'sonnet' | 'opus' | 'haiku' | 'inherit'
 */
export function toAgentModel(modelId: string): AgentDefinition['model'] {
	const lower = modelId.toLowerCase();
	if (lower.includes('opus')) return 'opus';
	if (lower.includes('haiku')) return 'haiku';
	if (lower.includes('sonnet')) return 'sonnet';
	// Default to 'sonnet' for unknown models
	return 'sonnet';
}

/** Restricted tools for reviewer sub-agents (read-only + gh CLI) */
const REVIEWER_TOOLS: AgentDefinition['tools'] = [
	'Read',
	'Grep',
	'Glob',
	'Bash',
	'WebFetch',
	'WebSearch',
];

const REVIEWER_OUTPUT_FORMAT = `
## Required Output Format

After posting your review, end your response with this structured block:

---REVIEW_POSTED---
url: <the html_url returned by the gh api call>
recommendation: APPROVE | REQUEST_CHANGES
p0: <count of P0 issues>
p1: <count of P1 issues>
p2: <count of P2 issues>
p3: <count of P3 issues>
summary: <1-2 sentence summary of key findings>
---END_REVIEW_POSTED---

Severity levels:
- P0 (blocking): Bugs, security vulnerabilities, data loss risks, broken functionality
- P1 (should-fix): Poor patterns, missing error handling, test gaps, unclear code
- P2 (important suggestion): Meaningful improvements to quality, readability, maintainability
- P3 (nit): Style nits, minor cosmetic issues, optional documentation

Decision rules:
- Use "REQUEST_CHANGES" when any P0, P1, or P2 issues exist
- Use "APPROVE" when only P3 issues or no issues exist`;

/**
 * Build prompt for an SDK-native reviewer agent (reviews code directly).
 */
function buildSdkReviewerPrompt(model: string, provider?: string): string {
	const displayProvider = provider ?? 'anthropic';

	return `You are a thorough code reviewer. Your job is to review the codebase in this worktree to verify that the requested work was correctly implemented.

## Reviewer Identity

- **Model:** ${model}
- **Client:** NeoKai
- **Provider:** ${displayProvider}
You MUST include this identity block at the top of every PR comment you post.

## Review Process

1. Read the task prompt carefully — it describes what was requested and what was implemented
2. Understand the original ask: what was the goal? What should the final result look like?
3. Explore the codebase thoroughly (use Read, Grep, Glob to understand the full picture):
   - Read the changed/new files completely, not just diffs
   - Read surrounding code to understand integration points
   - Check imports, exports, and cross-file dependencies
   - Look at test files to verify coverage
4. Evaluate the implementation holistically:
   - **Correctness**: Does the code actually achieve the original ask?
   - **Completeness**: Are all aspects of the request addressed? Any missing pieces?
   - **Bugs & edge cases**: Logic errors, off-by-one, null handling, race conditions
   - **Security**: Injection, XSS, SSRF, path traversal, auth bypass, data exposure
   - **Architecture**: Does this fit the existing patterns? Any unnecessary coupling?
   - **Error handling**: Are failures handled gracefully at system boundaries?
   - **Tests**: Do tests actually verify the new behavior? Are edge cases covered?
   - **Over-engineering**: Is there unnecessary complexity, dead code, or premature abstraction?

   The most critical bugs are often **omissions** — missing error handling, uncovered edge cases, absent validation at system boundaries. Prioritize what's NOT there over what is.
5. Post your review via the REST API, which returns the review URL directly:
   \`\`\`bash
   # For APPROVE:
   GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews \\
     -f body="<review body>" -f event="APPROVE" --jq '.html_url'

   # For REQUEST_CHANGES:
   GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews \\
     -f body="<review body>" -f event="REQUEST_CHANGES" --jq '.html_url'
   \`\`\`

   Determine the event **before posting** (deterministic, no trial/error):
   \`\`\`bash
   ME="$(gh api user --jq .login)"
   PR_AUTHOR="$(gh pr view {pr} --json author --jq .author.login)"
   EVENT="<APPROVE_OR_REQUEST_CHANGES>"
   [ "$ME" = "$PR_AUTHOR" ] && EVENT="COMMENT"

   GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews \\
     -f body="<review body>" -f event="$EVENT" --jq '.html_url'
   \`\`\`

   If EVENT is \`COMMENT\` (own PR), keep your recommendation (APPROVE/REQUEST_CHANGES) in the review body text.

   Include this header in your review body:
   \`\`\`
   ## 🤖 Review by ${model} (${displayProvider})

   > **Model:** ${model} | **Client:** NeoKai | **Provider:** ${displayProvider}
   \`\`\`
6. The \`--jq '.html_url'\` output is the review URL — use it in the structured output block below

## Guidelines

Treat the code as you would work from a competent but unfamiliar developer — it likely handles the happy path but may miss edge cases and project-specific constraints.

- Review the code as a whole, not just the diff — understand how changes integrate with the existing codebase
- Check how changes interact with callers, dependencies, and shared state — code that works in isolation often breaks at integration boundaries
- Verify the original request is fully achieved, not just partially implemented
- Be constructive and specific — always include file paths and line numbers
- Focus on issues that matter — don't nitpick formatting or style if a linter handles it
- Check that tests actually test the new/changed behavior, not just exist
- ALWAYS include the identity block in PR comments
${REVIEWER_OUTPUT_FORMAT}`;
}

/**
 * Return specific CLI invocation instructions based on the tool name.
 */
function getCliInstructions(cliTool: string, cliModel?: string): string {
	const tool = cliTool.toLowerCase();
	const modelFlag = cliModel ? ` --model ${cliModel}` : '';

	// 'codex-review' must be checked before 'codex' to avoid matching the shorter name
	if (tool === 'codex-review') {
		return `### Codex Review (OpenAI)

Use the dedicated \`codex review\` subcommand which is purpose-built for code review:

\`\`\`bash
codex review${modelFlag} --base <BASE_BRANCH> "<YOUR REVIEW INSTRUCTIONS HERE>" 2>&1
\`\`\`

- \`--base <BASE_BRANCH>\` reviews changes against the specified base branch (e.g., \`main\`, \`dev\`).${cliModel ? '' : '\n- Do NOT pass `--model` — Codex uses its default model.'}
- This uses the Codex review quota (separate from the exec/agent quota).
- Capture stdout — the review output is printed there.`;
	}

	if (tool.includes('codex')) {
		return `### Codex CLI (OpenAI)

Run Codex in non-interactive mode to review the code:

\`\`\`bash
codex exec${modelFlag} --sandbox read-only "<YOUR REVIEW PROMPT HERE>" 2>&1
\`\`\`

- The \`--sandbox read-only\` flag ensures Codex can read files but not modify them.${cliModel ? '' : '\n- Do NOT pass `--model` — Codex uses its default model.'}
- This uses the Codex agent/exec quota.
- Capture stdout — the review output is printed there.`;
	}

	if (tool.includes('copilot')) {
		return `### GitHub Copilot CLI

Run Copilot CLI in non-interactive mode to review the code:

\`\`\`bash
copilot -s --autopilot --yolo --no-ask-user --max-autopilot-continues 10${modelFlag} \\
  -p "<YOUR REVIEW PROMPT HERE>" \\
  2>/dev/null
\`\`\`

- The \`-s\` (silent) flag outputs only the agent response with no stats — ideal for capturing output.
- The \`--no-ask-user\` flag ensures the agent works autonomously.${cliModel ? '' : '\n- Do NOT pass `--model` — Copilot uses its default model.'}
- Capture stdout — the final review output is printed there.`;
	}

	if (tool === 'pi') {
		return `### Pi CLI (GitHub Copilot Provider)

Run Pi in one-shot mode to review the code via the GitHub Copilot provider:

\`\`\`bash
pi -p --no-session --provider github-copilot${modelFlag} \\
  --tools read,bash,grep,find,ls \\
  "<YOUR REVIEW PROMPT HERE>" 2>&1
\`\`\`

- \`-p\` runs one-shot and exits; \`--no-session\` keeps it ephemeral.
- \`--provider github-copilot\` ensures parity with native Copilot CLI model routing.
- \`--tools read,bash,grep,find,ls\` keeps the review read-only.${cliModel ? '' : '\n- Do NOT pass `--model` — Pi uses the provider default model.'}
- Capture stdout — the final review output is printed there.`;
	}

	// Generic fallback for unknown CLI tools
	return `### ${cliTool} CLI

Run the ${cliTool} CLI tool to review the code.${cliModel ? ` Use model: ${cliModel}.` : ''} Consult the tool's documentation for the correct non-interactive invocation syntax. Pass the changed files as input and capture the review output.`;
}

/**
 * Build prompt for a CLI-based reviewer agent (drives an external CLI tool).
 * The driver model MUST act as a strict relay — only orchestrate the CLI tool,
 * parse its output, and post. Do NOT do independent code review.
 */
function buildCliReviewerPrompt(
	cliTool: string,
	provider?: string,
	modelId?: string,
	cliModel?: string
): string {
	const cliInstructions = getCliInstructions(cliTool, cliModel);
	const displayProvider = provider ?? 'unknown';
	const displayModel = cliModel ?? modelId ?? cliTool;

	return `You are a RELAY agent that orchestrates the ${cliTool} CLI tool to perform code review. You MUST NOT review the code yourself — your ONLY job is to run the CLI tool, parse its output, and post the results.

## Reviewer Identity

- **Model:** ${displayModel}
- **Client:** ${cliTool}
- **Provider:** ${displayProvider}
You MUST include this identity block at the top of every PR comment you post.

## CRITICAL RULES

1. You are a RELAY, not a reviewer. Do NOT read code files yourself to form opinions.
2. Do NOT add your own findings or analysis. Only relay what the CLI tool reports.
3. If the CLI tool exits with an error, report the error — do not fall back to reviewing yourself.
4. Your only tools interaction should be: extracting PR info, running the CLI tool, and posting the review.
5. **ALWAYS run the CLI tool synchronously** — set \`timeout: 600000\` (10 minutes) on the Bash call. Do NOT use \`run_in_background\`. The output will be returned when the command completes. Do NOT poll, sleep, or check for output in separate steps.
6. If the CLI tool times out or errors, do NOT retry. Do NOT post a GitHub review. Instead, output the structured block with \`recommendation: TIMEOUT\` (or \`ERROR\`), \`url: none\`, and a summary describing what happened. The leader will decide how to proceed.

## Review Process

1. Read the task prompt carefully — extract the PR number and task description
2. Run the CLI tool synchronously (with \`timeout: 600000\`):

${cliInstructions}

   The command will complete and return the full output in one response. Do NOT run it in background or poll for output.
3. Parse the CLI tool's output and map findings to severity levels (P0/P1/P2/P3)
4. Post findings as a proper PR review via the REST API (returns the review URL directly):
   \`\`\`bash
   # For APPROVE:
   GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews \\
     -f body="<review body>" -f event="APPROVE" --jq '.html_url'

   # For REQUEST_CHANGES:
   GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews \\
     -f body="<review body>" -f event="REQUEST_CHANGES" --jq '.html_url'
   \`\`\`

   Determine the event **before posting** (deterministic, no trial/error):
   \`\`\`bash
   ME="$(gh api user --jq .login)"
   PR_AUTHOR="$(gh pr view {pr} --json author --jq .author.login)"
   EVENT="<APPROVE_OR_REQUEST_CHANGES>"
   [ "$ME" = "$PR_AUTHOR" ] && EVENT="COMMENT"

   GH_PAGER=cat gh api repos/{owner}/{repo}/pulls/{pr}/reviews \\
     -f body="<review body>" -f event="$EVENT" --jq '.html_url'
   \`\`\`

   If EVENT is \`COMMENT\` (own PR), keep your recommendation (APPROVE/REQUEST_CHANGES) in the review body text.

   Include this header:
   \`\`\`
   ## 🤖 Review by ${cliTool} (${displayProvider})

   > **Model:** ${displayModel} | **Client:** ${cliTool} | **Provider:** ${displayProvider}
   \`\`\`
5. The \`--jq '.html_url'\` output is the review URL — use it in the structured output block below

## Guidelines

- The CLI tool does ALL the reviewing — you are strictly a relay
- Map the CLI tool's output to severity levels (P0/P1/P2/P3)
- Do NOT do independent analysis, read source files for review, or add your own findings
- Be specific about file paths and line numbers (from the CLI output)
- ALWAYS include the identity block in PR comments
${REVIEWER_OUTPUT_FORMAT}`;
}

/**
 * Build a short, unique reviewer agent name from a SubagentConfig.
 * e.g., 'claude-sonnet-4-5-20250929' → 'reviewer-sonnet'
 *       'gpt-5.3-codex' → 'reviewer-codex'
 * Appends a counter suffix if names collide.
 */
export function toReviewerName(reviewer: SubagentConfig, existingNames: Set<string>): string {
	const shortName = toShortModelName(reviewer.model);
	let candidate = `reviewer-${shortName}`;
	let counter = 2;
	while (existingNames.has(candidate)) {
		candidate = `reviewer-${shortName}-${counter}`;
		counter++;
	}
	existingNames.add(candidate);
	return candidate;
}

/**
 * Build reviewer AgentDefinition records from sub-agent configs.
 * Each sub-agent becomes a named agent the leader can spawn via Task tool.
 */
/**
 * Auto-resolve provider name from known CLI agent names and model IDs.
 */
function resolveProvider(reviewer: SubagentConfig): string {
	if (reviewer.provider) {
		const provider = reviewer.provider.toLowerCase();
		if (provider === 'anthropic') return 'Anthropic';
		if (provider === 'glm') return 'GLM';
		if (provider === 'minimax') return 'MiniMax';
		if (provider === 'openai') return 'OpenAI';
		if (provider === 'github-copilot' || provider === 'github') return 'GitHub';
		if (provider === 'google') return 'Google';
		return reviewer.provider;
	}
	const m = reviewer.model.toLowerCase();
	if (m.includes('codex') || m.includes('gpt') || m.includes('openai')) return 'OpenAI';
	if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku'))
		return 'Anthropic';
	if (m.includes('glm')) return 'GLM';
	if (m.includes('minimax')) return 'MiniMax';
	if (m.includes('gemini') || m.includes('google')) return 'Google';
	if (m.includes('copilot') || m === 'pi') return 'GitHub';
	return 'unknown';
}

/**
 * Resolve the full model ID for a reviewer config.
 * If modelId is explicitly set, use that. Otherwise, map known short names.
 */
function resolveModelId(reviewer: SubagentConfig): string {
	if (reviewer.modelId) return reviewer.modelId;
	const m = reviewer.model.toLowerCase();
	// Map common short names to full model IDs
	if (m === 'opus') return 'claude-opus-4-6';
	if (m === 'sonnet') return 'claude-sonnet-4-6';
	if (m === 'haiku') return 'claude-haiku-4-5';
	if (m === 'codex' || m === 'codex-review') return 'gpt-5.3-codex';
	if (m === 'pi') return 'github-copilot';
	return reviewer.model;
}

export function buildReviewerAgents(
	reviewers: SubagentConfig[],
	leaderModel?: string
): Record<string, AgentDefinition> {
	const agents: Record<string, AgentDefinition> = {};
	const usedNames = new Set<string>();
	const runtimeModelLabel = leaderModel ?? 'sonnet';

	for (const reviewer of reviewers) {
		const name = toReviewerName(reviewer, usedNames);
		const provider = resolveProvider(reviewer);
		const modelId = resolveModelId(reviewer);

		if (reviewer.type === 'cli') {
			const orchestratorModel = runtimeModelLabel;
			// CLI-based reviewer: always inherit Leader runtime model.
			agents[name] = {
				description: `Code reviewer using ${reviewer.model} CLI (${provider} via ${orchestratorModel}). Runs the CLI tool via Bash and posts findings as PR reviews.`,
				tools: REVIEWER_TOOLS,
				model: 'inherit',
				prompt: buildCliReviewerPrompt(reviewer.model, provider, modelId, reviewer.cliModel),
			};
		} else {
			// SDK reviewers use the closest SDK tier for the configured model.
			// This allows Anthropic-compatible providers (e.g. GLM/MiniMax) to
			// route reviewer tiers via ANTHROPIC_DEFAULT_*_MODEL env mapping.
			agents[name] = {
				description: `Code reviewer using ${modelId} (${provider}). Reviews code changes for correctness, quality, and security.`,
				tools: REVIEWER_TOOLS,
				model: toAgentModel(modelId),
				prompt: buildSdkReviewerPrompt(modelId, provider),
			};
		}
	}

	return agents;
}

/**
 * Create an AgentSessionInit for a Leader agent session.
 *
 * Uses the agent/agents pattern: the Leader is defined as a named AgentDefinition
 * and the session is configured with `agent: 'Leader'` to designate it as the main thread.
 * Reviewer sub-agents (if configured) are merged into the `agents` map alongside Leader.
 *
 * This is analogous to coordinatorMode but custom: we define the Leader agent explicitly
 * rather than using the SDK's built-in coordinator. This preserves the leader's system
 * prompt and MCP tools while still allowing sub-agent dispatch via the Task tool.
 *
 * DESIGN NOTE: The Leader agent definition includes built-in tools (Task, Read, etc.)
 * but NOT MCP tools (leader-agent-tools__send_to_worker, etc.). MCP tools are provided
 * via the mcpServers config and should be available to the main agent thread regardless
 * of the agent's tools list. If this assumption is wrong and MCP tools are NOT available,
 * add 'leader-agent-tools__*' to the Leader agent's tools array.
 *
 * To test: Run the server, create a room with reviewer sub-agents configured,
 * trigger autonomous mode, and verify:
 * 1. Leader can call MCP tools (send_to_worker, complete_task, etc.)
 * 2. Leader can dispatch reviewer sub-agents via Task tool
 */
export function createLeaderAgentInit(
	config: LeaderAgentConfig,
	callbacks: LeaderToolCallbacks
): AgentSessionInit {
	const mcpServer = createLeaderMcpServer(config.groupId, callbacks);

	// Create room-agent-tools MCP server for task/goal management (if dependencies provided)
	const roomAgentTools =
		config.goalManager && config.taskManager && config.groupRepo
			? (createRoomAgentMcpServer({
					roomId: config.room.id,
					goalManager: config.goalManager,
					taskManager: config.taskManager,
					groupRepo: config.groupRepo,
					daemonHub: config.daemonHub,
					runtimeService: config.runtimeService,
				}) as unknown as McpServerConfig)
			: undefined;

	// Build reviewer agents from room config (if any)
	const roomConfig = config.room.config ?? {};
	const reviewerConfigs = getLeaderSubagents(roomConfig);
	const leaderModel = config.model ?? DEFAULT_LEADER_MODEL;
	const reviewerAgents =
		reviewerConfigs && reviewerConfigs.length > 0
			? buildReviewerAgents(reviewerConfigs, leaderModel)
			: undefined;

	// Only define the Leader agent definition and use agent/agents pattern
	// when there are reviewer sub-agents to dispatch. Otherwise, use the simple
	// preset path to avoid unnecessary complexity.
	if (reviewerAgents) {
		// Leader agent definition — orchestrates reviews via MCP tools + Task for sub-agents
		const leaderAgentDef: AgentDefinition = {
			description:
				'Coordinator that orchestrates code review. Dispatches reviewer sub-agents, collects their review links, and routes decisions using MCP tools.',
			prompt: buildLeaderSystemPrompt(config),
			tools: ['Task', 'TaskOutput', 'TaskStop', 'Read', 'Grep', 'Glob'],
			model: toAgentModel(config.model ?? DEFAULT_LEADER_MODEL),
		};

		const allAgents: Record<string, AgentDefinition> = {
			Leader: leaderAgentDef,
			...reviewerAgents,
		};

		return {
			sessionId: config.sessionId,
			workspacePath: config.workspacePath,
			systemPrompt: {
				type: 'preset',
				preset: 'claude_code',
			},
			mcpServers: {
				'leader-agent-tools': mcpServer as unknown as McpServerConfig,
				...(roomAgentTools ? { 'room-agent-tools': roomAgentTools } : {}),
			},
			features: LEADER_FEATURES,
			context: { roomId: config.room.id },
			type: 'leader' as const,
			model: config.model ?? DEFAULT_LEADER_MODEL,
			agent: 'Leader',
			agents: allAgents,
			contextAutoQueue: false,
		};
	}

	// Simple path: no reviewer sub-agents, no agent/agents needed
	return {
		sessionId: config.sessionId,
		workspacePath: config.workspacePath,
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			append: buildLeaderSystemPrompt(config),
		},
		mcpServers: {
			'leader-agent-tools': mcpServer as unknown as McpServerConfig,
			...(roomAgentTools ? { 'room-agent-tools': roomAgentTools } : {}),
		},
		features: LEADER_FEATURES,
		context: { roomId: config.room.id },
		type: 'leader',
		model: config.model ?? DEFAULT_LEADER_MODEL,
		contextAutoQueue: false,
	};
}
