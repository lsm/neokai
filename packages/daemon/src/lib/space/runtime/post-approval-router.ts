/**
 * PostApprovalRouter — deterministic dispatch for workflow post-approval routes.
 *
 * PR 2/5 of the task-agent-as-post-approval-executor refactor. See
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §1.4 for the runtime-driven routing mechanics and §2.3 for the event shapes.
 *
 * ## What it does
 *
 * When a task transitions into `approved` (from the end-node `approve_task`
 * path in `space-runtime.ts`, or from the human `approvePendingCompletion`
 * RPC handler in `space-task-handlers.ts`), this router consults
 * `workflow.postApproval` and performs one of three deterministic actions:
 *
 *   1. **No route declared** → runtime transitions `approved → done` directly
 *      and emits `task.status-transition: approved → done source=no-post-approval`.
 *   2. **`targetAgent === 'task-agent'`** → explicit escalation route: inject a
 *      `[POST_APPROVAL_INSTRUCTIONS]` user turn into the existing Task Agent
 *      session. No new session spawn, no `post_approval_session_id` stamped.
 *   3. **Any other `targetAgent`** (a *space task node agent* — see terminology
 *      below) → spawn a fresh sub-session for that agent with the interpolated
 *      kickoff message, and stamp `post_approval_session_id` +
 *      `post_approval_started_at` on the task.
 *
 * ## Terminology — "space task node agent"
 *
 * Throughout this plan, "space task node agent" refers to an agent session
 * spawned for a node in a space workflow run — distinct from the Task Agent
 * (the orchestrator) and from ad-hoc chat sessions. In the current codebase
 * this is the `'node_agent'` kind in
 * `packages/shared/src/types/space.ts` (`SpaceMemberSession.kind`). See
 * `PostApprovalRoute.targetAgent` in the same file: the validator in
 * `post-approval-validator.ts` restricts valid targets to either the literal
 * `'task-agent'` or the `name` of a declared `WorkflowNodeAgent`.
 *
 * ## Double-fire guard (§3.4)
 *
 * The router is idempotent against double-invocation for the node-agent-spawn
 * case: if a task already has `postApprovalSessionId` set AND the referenced
 * session is alive (not terminal), the router returns a no-op result with
 * `mode: 'already-routed'`. For the inline `'task-agent'` and no-route cases
 * the dispatch is cheap (message inject / status update) so we re-run without
 * guarding; double-delivery of `[POST_APPROVAL_INSTRUCTIONS]` would be visible
 * to the operator as conversation noise, not a failure.
 *
 *  * ## Feature flag (kill switch only)
 *
 * As of PR 4/5 the completion-action pipeline has been deleted — the
 * PostApprovalRouter is the only approval path. The
 * `NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING` env var and
 * `isPostApprovalRoutingEnabled()` helper are retained as an emergency kill
 * switch: production call sites no longer consult it (PR 4/5 removed the
 * branch), but operators can still inspect the flag state in diagnostics.
 * There is no longer a fallback path to switch to.
 */

import type {
	SpaceTask,
	SpaceWorkflow,
	SpaceApprovalSource,
	UpdateSpaceTaskParams,
} from '@neokai/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import {
	interpolatePostApprovalTemplate,
	type PostApprovalTemplateContext,
} from '../workflows/post-approval-template';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator';
import { Logger } from '../../logger';
import { RUNTIME_ESCALATION_REASONS, type RuntimeEscalationReason } from './escalation-reasons';

const log = new Logger('post-approval-router');

/**
 * Feature-flag env var. Call-sites read this and only invoke the router when
 * it is truthy (`'1'` or `'true'`). Exported so tests can assert on it and
 * so the RPC handler + space-runtime share a single key.
 */
export const POST_APPROVAL_ROUTING_FLAG_ENV = 'NEOKAI_TASK_AGENT_POST_APPROVAL_ROUTING';

/**
 * Returns true when the feature flag indicates post-approval routing should
 * remain enabled. Retained as an emergency kill switch only — as of PR 4/5
 * the production call sites have been collapsed (no legacy path to fall back
 * to), so the helper is consulted only in diagnostics and tests.
 *
 * Default-ON as of PR 3/5. Set the env var to any of `0` / `false` / `no` /
 * `off` to read as disabled. An absent value (`undefined`) or any unrecognised
 * string keeps routing enabled.
 */
export function isPostApprovalRoutingEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
	const raw = env[POST_APPROVAL_ROUTING_FLAG_ENV];
	if (raw === undefined) return true;
	const v = raw.trim().toLowerCase();
	if (v === '') return true;
	if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
	return true;
}

// ---------------------------------------------------------------------------
// Dispatch delegates
// ---------------------------------------------------------------------------

/**
 * Abstracts the Task Agent session as far as the router is concerned. The
 * router only needs to inject two kinds of messages (awareness + post-approval
 * instructions) — no other Task Agent surface is touched.
 */
export interface TaskAgentInjector {
	/**
	 * Inject a user-turn message into the Task Agent session for this task.
	 *
	 *   - Returns `{ injected: true, sessionId }` when the Task Agent was live
	 *     and the message was enqueued.
	 *   - Returns `{ injected: false }` when no Task Agent session exists for
	 *     the task (e.g. the task was approved before any workflow ran).
	 *     Callers log a warning but continue — awareness events are best-effort.
	 */
	injectIntoTaskAgent(
		taskId: string,
		message: string
	): Promise<{ injected: boolean; sessionId?: string }>;
}

/**
 * Delegate for spawning the post-approval sub-session on the
 * space-task-node-agent path. Production wires this to
 * `TaskAgentManager.spawnPostApprovalSubSession`; tests pass a stub.
 *
 * The delegate is responsible for everything that differs between a regular
 * node activation and a post-approval activation:
 *   - Creating a `NodeExecution` row (or reusing the agent's existing session).
 *   - Attaching the same MCP server set that the target node would have.
 *   - Injecting the `kickoffMessage` as the first user turn.
 *   - Returning the spawned session ID so the router can stamp it on the task.
 */
export interface PostApprovalSubSessionSpawner {
	spawnPostApprovalSubSession(args: {
		task: SpaceTask;
		workflow: SpaceWorkflow;
		targetAgent: string;
		kickoffMessage: string;
	}): Promise<{ sessionId: string }>;
}

/**
 * Optional delegate used to confirm that a previously-recorded
 * `postApprovalSessionId` still points at a live session. When omitted the
 * router treats any non-null `postApprovalSessionId` as live (conservative:
 * it skips the second spawn). Production wires this to
 * `TaskAgentManager.isSessionAlive`.
 */
export interface SessionLivenessProbe {
	isSessionAlive(sessionId: string): boolean;
}

export interface PostApprovalRouterDeps {
	taskRepo: Pick<SpaceTaskRepository, 'updateTask' | 'getTask'>;
	taskAgent: TaskAgentInjector;
	spawner: PostApprovalSubSessionSpawner;
	livenessProbe?: SessionLivenessProbe;
}

// ---------------------------------------------------------------------------
// Route inputs + outputs
// ---------------------------------------------------------------------------

/**
 * Runtime context assembled by the caller. Includes every key that the
 * template interpolator recognises (see
 * `post-approval-template.ts:POST_APPROVAL_TEMPLATE_KEYS`) plus arbitrary
 * extra keys signalled by the end-node agent (e.g. `pr_url`).
 */
export interface PostApprovalRouteContext extends PostApprovalTemplateContext {
	/** How the task reached `approved`. Included in post-approval routing context. */
	approvalSource: SpaceApprovalSource;
	/** Slot/name of the agent that approved the task. */
	reviewerName?: string;
	/** Owning space ID. */
	spaceId?: string;
	/** Workspace path for the space's worktree. */
	workspacePath?: string;
	/** Space's autonomy level at routing time. */
	autonomyLevel?: number;
}

/**
 * Discriminated union describing which branch the router took.
 *
 *   - `mode: 'no-route'`        — no `postApproval` declared; task transitioned
 *                                 directly `approved → done`.
 *   - `mode: 'inline'`          — `targetAgent === 'task-agent'`; instructions
 *                                 were injected into the Task Agent session.
 *   - `mode: 'spawn'`           — a node-agent sub-session was spawned; its
 *                                 ID was stamped on the task.
 *   - `mode: 'already-routed'`  — idempotency guard: a prior spawn's session
 *                                 is still alive, so this call is a no-op.
 *   - `mode: 'skipped'`         — router precondition failed (e.g. missing
 *                                 workflow, empty instructions for inline path).
 *                                 Not a failure — caller may choose to surface.
 */
export type PostApprovalRouteResult =
	| { mode: 'no-route'; taskStatus: 'done' }
	| {
			mode: 'inline';
			taskAgentSessionId?: string;
			missingKeys: string[];
			escalationReason: RuntimeEscalationReason;
	  }
	| {
			mode: 'spawn';
			postApprovalSessionId: string;
			postApprovalStartedAt: number;
			missingKeys: string[];
	  }
	| { mode: 'already-routed'; postApprovalSessionId: string }
	| { mode: 'skipped'; reason: string };

// ---------------------------------------------------------------------------
// Event shapes (§2.3)
// ---------------------------------------------------------------------------

const POST_APPROVAL_COMPLETION_INSTRUCTIONS =
	`When the post-approval work is finished, call mark_complete to transition the\n` +
	`task from \`approved\` to \`done\`. If you need human input mid-work, call\n` +
	`request_human_input as usual.\n\n` +
	`Do NOT call approve_task; the task has already been approved upstream.`;

export function appendPostApprovalCompletionInstructions(interpolatedInstructions: string): string {
	const trimmed = interpolatedInstructions.trim();
	return `${trimmed}\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`;
}

/**
 * Build the `[POST_APPROVAL_INSTRUCTIONS]` follow-up event. Only sent when
 * `targetAgent === 'task-agent'`. See §2.3.
 */
export function buildPostApprovalInstructionsEvent(args: {
	task: SpaceTask;
	interpolatedInstructions: string;
}): string {
	return (
		`[POST_APPROVAL_INSTRUCTIONS] Task ${args.task.id} post-approval work begins now.\n\n` +
		appendPostApprovalCompletionInstructions(args.interpolatedInstructions)
	);
}

// ---------------------------------------------------------------------------
// PostApprovalRouter
// ---------------------------------------------------------------------------

/**
 * Deterministic dispatcher for the post-approval step. Instantiated once by
 * the runtime layer (see `space-runtime.ts`), reused for every approval.
 */
export class PostApprovalRouter {
	constructor(private readonly deps: PostApprovalRouterDeps) {}

	/**
	 * Route a just-`approved` task. Must be called AFTER the caller has
	 * transitioned the task into `approved` — the router inspects the
	 * current task state but never performs the `in_progress → approved`
	 * or `review → approved` hop itself (those live at the call sites so
	 * their emit + liveness semantics stay local).
	 */
	async route(
		task: SpaceTask,
		workflow: SpaceWorkflow | null,
		context: PostApprovalRouteContext
	): Promise<PostApprovalRouteResult> {
		// -------------------------------------------------------------------
		// 0. Sanity: task MUST currently be in `approved`. If it isn't, the
		//    caller misordered things — log loudly and skip.
		// -------------------------------------------------------------------
		if (task.status !== 'approved') {
			const reason = `task ${task.id} is not in 'approved' (status=${task.status}); router will not dispatch`;
			log.warn(`PostApprovalRouter.route: ${reason}`);
			return { mode: 'skipped', reason };
		}

		const route = workflow?.postApproval;

		// -------------------------------------------------------------------
		// 1. No postApproval declared → close the task directly.
		// -------------------------------------------------------------------
		if (!route || !route.targetAgent) {
			const updates: UpdateSpaceTaskParams = {
				status: 'done',
				completedAt: Date.now(),
				postApprovalSessionId: null,
				postApprovalStartedAt: null,
				postApprovalBlockedReason: null,
			};
			this.deps.taskRepo.updateTask(task.id, updates);
			log.info(
				`post-approval.route: spaceId=${task.spaceId} taskId=${task.id} targetAgent=none mode=none autonomyLevel=${context.autonomyLevel ?? 'unknown'}`
			);
			log.info(
				`task.status-transition: taskId=${task.id} from=approved to=done source=no-post-approval`
			);
			return { mode: 'no-route', taskStatus: 'done' };
		}

		const { targetAgent, instructions } = route;

		// -------------------------------------------------------------------
		// 2. Inline route — deliver instructions to the Task Agent.
		// -------------------------------------------------------------------
		if (targetAgent === POST_APPROVAL_TASK_AGENT_TARGET) {
			const { text, missingKeys } = interpolatePostApprovalTemplate(instructions ?? '', context);
			if (!text.trim()) {
				const reason = `task ${task.id}: inline post-approval has empty instructions template`;
				log.warn(`PostApprovalRouter.route: ${reason}`);
				return { mode: 'skipped', reason };
			}
			const body = buildPostApprovalInstructionsEvent({
				task,
				interpolatedInstructions: text,
			});
			const { injected, sessionId } = await this.deps.taskAgent.injectIntoTaskAgent(task.id, body);
			if (!injected) {
				log.warn(
					`PostApprovalRouter.route: no Task Agent session for task ${task.id} — [POST_APPROVAL_INSTRUCTIONS] not delivered`
				);
			}
			if (missingKeys.length > 0) {
				log.warn(
					`PostApprovalRouter.route: task ${task.id} instructions referenced unknown keys: ${missingKeys.join(', ')}`
				);
			}
			log.info(
				`post-approval.route: spaceId=${task.spaceId} taskId=${task.id} targetAgent=${targetAgent} mode=inline escalationReason=${RUNTIME_ESCALATION_REASONS.HUMAN_APPROVAL} autonomyLevel=${context.autonomyLevel ?? 'unknown'}`
			);
			return {
				mode: 'inline',
				taskAgentSessionId: sessionId,
				missingKeys,
				escalationReason: RUNTIME_ESCALATION_REASONS.HUMAN_APPROVAL,
			};
		}

		// -------------------------------------------------------------------
		// 3. Node-agent spawn route.
		// -------------------------------------------------------------------

		// Double-fire guard (§3.4): skip when an existing session is alive.
		if (task.postApprovalSessionId) {
			const alive = this.deps.livenessProbe
				? this.deps.livenessProbe.isSessionAlive(task.postApprovalSessionId)
				: true;
			if (alive) {
				log.info(
					`PostApprovalRouter.route: task ${task.id} already has live post-approval session ${task.postApprovalSessionId}; skipping re-spawn`
				);
				return {
					mode: 'already-routed',
					postApprovalSessionId: task.postApprovalSessionId,
				};
			}
		}

		// Interpolate the workflow-specific kickoff, then append the runtime-owned
		// completion instruction shared by every post-approval route.
		const { text: interpolatedInstructions, missingKeys } = interpolatePostApprovalTemplate(
			instructions ?? '',
			context
		);
		if (!interpolatedInstructions.trim()) {
			const reason = `task ${task.id}: node-agent post-approval has empty instructions template`;
			log.warn(`PostApprovalRouter.route: ${reason}`);
			return { mode: 'skipped', reason };
		}
		if (missingKeys.length > 0) {
			log.warn(
				`PostApprovalRouter.route: task ${task.id} kickoff referenced unknown keys: ${missingKeys.join(', ')}`
			);
		}
		if (!workflow) {
			const reason = `task ${task.id}: cannot spawn post-approval sub-session without workflow`;
			log.warn(`PostApprovalRouter.route: ${reason}`);
			return { mode: 'skipped', reason };
		}
		const kickoffMessage = appendPostApprovalCompletionInstructions(interpolatedInstructions);

		const startedAt = Date.now();
		const { sessionId } = await this.deps.spawner.spawnPostApprovalSubSession({
			task,
			workflow,
			targetAgent,
			kickoffMessage,
		});

		this.deps.taskRepo.updateTask(task.id, {
			postApprovalSessionId: sessionId,
			postApprovalStartedAt: startedAt,
			postApprovalBlockedReason: null,
		});

		log.info(
			`post-approval.route: spaceId=${task.spaceId} taskId=${task.id} targetAgent=${targetAgent} mode=spawn autonomyLevel=${context.autonomyLevel ?? 'unknown'} sessionId=${sessionId}`
		);
		return {
			mode: 'spawn',
			postApprovalSessionId: sessionId,
			postApprovalStartedAt: startedAt,
			missingKeys,
		};
	}
}
