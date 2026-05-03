/**
 * GatePollManager — periodic script execution and message injection for workflow gates.
 *
 * When a workflow run becomes `in_progress`, this manager scans all gates in the
 * workflow definition for those with `poll` defined and starts a timer for each.
 * On each tick, the poll script is executed in a sandboxed environment with context
 * variables. If the output changes and is non-empty, a message is injected into
 * the target node's agent session.
 *
 * Lifecycle:
 * - `startPolls()` — called when a workflow run starts
 * - `stopPolls()` — called when a workflow run reaches a terminal state
 * - All state is in-memory only; no DB persistence needed
 */

import type { GatePoll, SpaceWorkflow } from '@neokai/shared';
import { Logger } from '../../logger';
import { buildRestrictedEnv, collectWithMaxBuffer, MAX_BUFFER_BYTES } from './gate-script-executor';

const log = new Logger('gate-poll-manager');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum poll interval (10 seconds) to prevent abuse. */
export const MIN_POLL_INTERVAL_MS = 10_000;

/** Default script timeout for poll scripts (30 seconds). */
const DEFAULT_POLL_SCRIPT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

/**
 * Context provided to poll script execution.
 * These values are injected as environment variables.
 */
export interface PollScriptContext {
	/** Task UUID */
	TASK_ID: string;
	/** Task title */
	TASK_TITLE: string;
	/** Space UUID */
	SPACE_ID: string;
	/** Associated PR URL (empty string if none) */
	PR_URL: string;
	/** PR number extracted from URL (empty string if none) */
	PR_NUMBER: string;
	/** Repo owner extracted from URL (empty string if none) */
	REPO_OWNER: string;
	/** Repo name extracted from URL (empty string if none) */
	REPO_NAME: string;
	/** Workflow run UUID */
	WORKFLOW_RUN_ID: string;
}

/**
 * Extract PR metadata from a PR URL.
 * Supports GitHub PR URLs in the format: https://github.com/{owner}/{name}/pull/{number}
 */
export function extractPrContext(prUrl: string): {
	PR_NUMBER: string;
	REPO_OWNER: string;
	REPO_NAME: string;
} {
	if (!prUrl) {
		return { PR_NUMBER: '', REPO_OWNER: '', REPO_NAME: '' };
	}

	try {
		const url = new URL(prUrl);
		const parts = url.pathname.split('/').filter(Boolean);
		// Expected: [owner, repo, 'pull', number] or [owner, repo, 'pull', number, ...]
		if (parts.length >= 4 && parts[2] === 'pull') {
			return {
				REPO_OWNER: parts[0],
				REPO_NAME: parts[1],
				PR_NUMBER: parts[3],
			};
		}
	} catch {
		// Not a valid URL
	}

	return { PR_NUMBER: '', REPO_OWNER: '', REPO_NAME: '' };
}

/**
 * Resolves the target node name for a polled gate by finding the channel
 * that references this gate.
 */
export function resolveTargetNodeName(
	gateId: string,
	workflow: SpaceWorkflow,
	target: 'from' | 'to'
): string | null {
	const channels = workflow.channels ?? [];
	const channel = channels.find((ch) => ch.gateId === gateId);
	if (!channel) {
		return null;
	}

	if (target === 'from') {
		return channel.from;
	}

	// For 'to', handle both single and array targets
	const toTarget = Array.isArray(channel.to) ? channel.to[0] : channel.to;
	return toTarget ?? null;
}

/**
 * Format a message using the message template.
 * Replaces `{{output}}` placeholder with the actual output.
 */
export function formatPollMessage(output: string, template?: string): string {
	if (!template) {
		return output;
	}
	return template.replace(/\{\{output\}\}/g, output);
}

// ---------------------------------------------------------------------------
// Message injector interface
// ---------------------------------------------------------------------------

/**
 * Callback for injecting messages into agent sessions.
 * Abstracts the dependency on TaskAgentManager for testability.
 */
export interface PollMessageInjector {
	/**
	 * Inject a message into a specific agent session.
	 * @param sessionId — the agent session to inject into
	 * @param message — the message content
	 * @param isSynthetic — whether this is a synthetic/system message
	 */
	injectSubSessionMessage(sessionId: string, message: string, isSynthetic?: boolean): Promise<void>;
}

/**
 * Callback for looking up active agent sessions for a node in a workflow run.
 */
export interface PollSessionResolver {
	/**
	 * Returns the session ID of an active (non-terminal) agent execution for
	 * the given (runId, nodeId) pair. Returns null when no active session exists.
	 */
	getActiveSessionForNode(runId: string, nodeId: string): string | null;
}

// ---------------------------------------------------------------------------
// GatePollManager
// ---------------------------------------------------------------------------

/**
 * In-memory state for a single active poll timer.
 */
interface ActivePoll {
	/** The timer handle */
	timer: ReturnType<typeof setInterval>;
	/** The last known output (for change detection) */
	lastOutput: string;
}

export class GatePollManager {
	/**
	 * Active polls keyed by `${runId}:${gateId}`.
	 * In-memory only — starts empty on every daemon restart.
	 */
	private activePolls = new Map<string, ActivePoll>();

	/**
	 * Resolved gate channels cached per run for target resolution.
	 * Keyed by runId.
	 */
	private runContexts = new Map<
		string,
		{
			workflow: SpaceWorkflow;
			workspacePath: string;
			spaceId: string;
		}
	>();

	constructor(
		private readonly messageInjector: PollMessageInjector,
		private readonly sessionResolver: PollSessionResolver
	) {}

	/**
	 * Start all polls for a workflow run.
	 * Scans the workflow definition for gates with `poll` and starts a timer for each.
	 *
	 * @param runId — the workflow run ID
	 * @param workflow — the workflow definition
	 * @param workspacePath — absolute workspace path (cwd for scripts)
	 * @param spaceId — the space ID (for context)
	 * @param scriptContext — resolved context variables for scripts
	 */
	startPolls(
		runId: string,
		workflow: SpaceWorkflow,
		workspacePath: string,
		spaceId: string,
		scriptContext: PollScriptContext
	): void {
		const gates = workflow.gates ?? [];
		const polledGates = gates.filter((g) => g.poll);

		if (polledGates.length === 0) {
			return;
		}

		// Store run context for later use in tick handlers
		this.runContexts.set(runId, { workflow, workspacePath, spaceId });

		for (const gate of polledGates) {
			const poll = gate.poll!;
			const key = `${runId}:${gate.id}`;

			// Enforce minimum interval
			const intervalMs = Math.max(poll.intervalMs, MIN_POLL_INTERVAL_MS);

			// Resolve target node
			const targetNodeName = resolveTargetNodeName(gate.id, workflow, poll.target);
			if (!targetNodeName) {
				log.warn(
					`GatePollManager: skipping poll for gate "${gate.id}" — no channel references this gate`
				);
				continue;
			}

			// Resolve target node ID from node name
			const targetNode = workflow.nodes.find((n) => n.name === targetNodeName);
			if (!targetNode) {
				log.warn(
					`GatePollManager: skipping poll for gate "${gate.id}" — target node "${targetNodeName}" not found`
				);
				continue;
			}

			log.info(
				`GatePollManager: starting poll for gate "${gate.id}" on run "${runId}" ` +
					`(interval=${intervalMs}ms, target=${poll.target}:${targetNodeName})`
			);

			// Capture context for the closure
			const capturedContext = { ...scriptContext };
			const capturedRunId = runId;
			const capturedGateId = gate.id;
			const capturedWorkspacePath = workspacePath;
			const capturedPoll = { ...poll };
			const capturedTargetNodeId = targetNode.id;

			const timer = setInterval(async () => {
				await this.executePollTick(
					capturedRunId,
					capturedGateId,
					capturedPoll,
					capturedWorkspacePath,
					capturedContext,
					capturedTargetNodeId
				);
			}, intervalMs);

			// Prevent the timer from keeping the process alive
			if (timer.unref) {
				timer.unref();
			}

			this.activePolls.set(key, { timer, lastOutput: '' });
		}
	}

	/**
	 * Stop all polls for a workflow run.
	 * Called when the run reaches a terminal state.
	 */
	stopPolls(runId: string): void {
		const prefix = `${runId}:`;
		for (const [key, poll] of this.activePolls) {
			if (key.startsWith(prefix)) {
				clearInterval(poll.timer);
				this.activePolls.delete(key);
				log.info(`GatePollManager: stopped poll "${key}" for terminal run "${runId}"`);
			}
		}
		this.runContexts.delete(runId);
	}

	/**
	 * Stop all polls across all runs. Called during shutdown.
	 */
	stopAll(): void {
		for (const [key, poll] of this.activePolls) {
			clearInterval(poll.timer);
			log.info(`GatePollManager: stopped poll "${key}" during shutdown`);
		}
		this.activePolls.clear();
		this.runContexts.clear();
	}

	/**
	 * Returns the number of active polls (for testing/diagnostics).
	 */
	get activePollCount(): number {
		return this.activePolls.size;
	}

	/**
	 * Returns whether a specific gate poll is active (for testing).
	 */
	isPollActive(runId: string, gateId: string): boolean {
		return this.activePolls.has(`${runId}:${gateId}`);
	}

	// ---------------------------------------------------------------------------
	// Private: poll tick execution
	// ---------------------------------------------------------------------------

	/**
	 * Execute a single poll tick: run the script, compare output, inject message.
	 */
	private async executePollTick(
		runId: string,
		gateId: string,
		poll: GatePoll,
		workspacePath: string,
		context: PollScriptContext,
		targetNodeId: string
	): Promise<void> {
		const key = `${runId}:${gateId}`;
		const activePoll = this.activePolls.get(key);
		if (!activePoll) {
			// Poll was stopped between timer fire and execution
			return;
		}

		try {
			const output = await this.executePollScript(poll.script, workspacePath, context);

			if (output === null) {
				// Script error or empty output — do nothing
				return;
			}

			// Compare to last known output
			if (output === activePoll.lastOutput) {
				// No change — do nothing
				return;
			}

			// Output changed and is non-empty — inject message
			activePoll.lastOutput = output;

			const message = formatPollMessage(output, poll.messageTemplate);
			const sessionId = this.sessionResolver.getActiveSessionForNode(runId, targetNodeId);

			if (!sessionId) {
				log.debug(
					`GatePollManager: no active session for node "${targetNodeId}" in run "${runId}" — ` +
						`skipping message injection for poll "${gateId}"`
				);
				return;
			}

			await this.messageInjector.injectSubSessionMessage(sessionId, message, true);

			log.info(
				`GatePollManager: injected poll message for gate "${gateId}" on run "${runId}" ` +
					`into session "${sessionId}" (${output.length} chars)`
			);
		} catch (err) {
			// Log error but continue polling — don't crash the poll loop
			log.warn(
				`GatePollManager: poll tick error for gate "${gateId}" on run "${runId}": ` +
					`${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * Execute a poll script and capture stdout.
	 *
	 * Uses the same sandboxed environment as gate scripts (credential stripping,
	 * restricted env), with additional context variables for the poll.
	 *
	 * @returns stdout string on success, or null on error / empty output
	 */
	private async executePollScript(
		script: string,
		workspacePath: string,
		context: PollScriptContext
	): Promise<string | null> {
		// Build a gate-script-like context for the restricted env builder
		const gateContext = {
			workspacePath,
			gateId: '__poll__',
			runId: context.WORKFLOW_RUN_ID,
		};

		// Build restricted env from process environment (strips credentials)
		const env = buildRestrictedEnv(gateContext);

		// Inject poll-specific context variables
		env['TASK_ID'] = context.TASK_ID;
		env['TASK_TITLE'] = context.TASK_TITLE;
		env['SPACE_ID'] = context.SPACE_ID;
		env['PR_URL'] = context.PR_URL;
		env['PR_NUMBER'] = context.PR_NUMBER;
		env['REPO_OWNER'] = context.REPO_OWNER;
		env['REPO_NAME'] = context.REPO_NAME;
		env['WORKFLOW_RUN_ID'] = context.WORKFLOW_RUN_ID;

		let proc;
		try {
			proc = Bun.spawn(['bash', '-c', script], {
				cwd: workspacePath,
				env,
				stdout: 'pipe',
				stderr: 'pipe',
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`GatePollManager: failed to spawn poll script: ${message}`);
			return null;
		}

		// Drain stdout/stderr concurrently with timeout
		const [stdoutResult, stderrResult, exitCode] = await Promise.all([
			collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
			collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
			(async () => {
				let killed = false;
				const killTimer = setTimeout(() => {
					killed = true;
					proc.kill('SIGKILL');
				}, DEFAULT_POLL_SCRIPT_TIMEOUT_MS);

				const code = await proc.exited;
				clearTimeout(killTimer);
				return { code, timedOut: killed };
			})(),
		]);

		if (exitCode.timedOut) {
			log.warn(`GatePollManager: poll script timed out after ${DEFAULT_POLL_SCRIPT_TIMEOUT_MS}ms`);
			return null;
		}

		if (exitCode.code !== 0) {
			const stderr = stderrResult.text.trim();
			log.warn(
				`GatePollManager: poll script exited with code ${exitCode.code}` +
					(stderr ? `: ${stderr.slice(0, 500)}` : '')
			);
			return null;
		}

		const output = stdoutResult.text.trim();
		if (output.length === 0) {
			return null;
		}

		return output;
	}
}
