/**
 * Space Workflow Run RPC Handlers
 *
 * RPC handlers for SpaceWorkflowRun lifecycle:
 * - spaceWorkflowRun.start          - Creates a run and triggers first step task creation
 * - spaceWorkflowRun.list           - Lists runs for a space (optional status filter)
 * - spaceWorkflowRun.get            - Gets a run by ID
 * - spaceWorkflowRun.cancel         - Cancels a run and all pending tasks
 * - spaceWorkflowRun.markFailed     - Marks a run as blocked with a specific failure reason
 * - spaceWorkflowRun.approveGate    - Approves or rejects a human approval gate
 * - spaceWorkflowRun.listGateData   - Returns all gate data records for a run
 * - spaceWorkflowRun.getGateArtifacts - Returns changed files and diff summary for a run's worktree
 * - spaceWorkflowRun.getFileDiff    - Returns unified diff for a specific file in the worktree
 * - spaceWorkflowRun.writeGateData  - Writes arbitrary gate data (E2E test infrastructure only)
 */

import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type { GateDataRepository } from '../../storage/repositories/gate-data-repository';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';
import type { WorkflowRunFailureReason, WorkflowRunStatus } from '@neokai/shared';
import { Logger } from '../logger';

const log = new Logger('space-workflow-run-handlers');

// ─── Git diff utilities ───────────────────────────────────────────────────────

interface FileDiffStat {
	path: string;
	additions: number;
	deletions: number;
}

interface DiffSummary {
	files: FileDiffStat[];
	totalAdditions: number;
	totalDeletions: number;
}

/**
 * Parse `git diff --numstat` output into structured file stats.
 * Each line is: `<additions>\t<deletions>\t<path>`
 * Binary files show `-\t-\t<path>` — those get 0/0 stats.
 */
function parseNumstat(output: string): DiffSummary {
	const files: FileDiffStat[] = [];
	let totalAdditions = 0;
	let totalDeletions = 0;

	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		const parts = line.split('\t');
		if (parts.length < 3) continue;
		const additions = parseInt(parts[0], 10) || 0;
		const deletions = parseInt(parts[1], 10) || 0;
		const path = parts.slice(2).join('\t');
		files.push({ path, additions, deletions });
		totalAdditions += additions;
		totalDeletions += deletions;
	}

	return { files, totalAdditions, totalDeletions };
}

/**
 * Async wrapper around `execFile('git', ...)`.
 * Non-blocking — does not stall the event loop during git I/O.
 */
function execGit(args: string[], cwd: string, timeout = 10000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, encoding: 'utf8', timeout }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout as string);
		});
	});
}

/**
 * Get the diff base ref for a worktree.
 * Tries `origin/dev` merge-base first; falls back to empty string (uncommitted only).
 */
async function getDiffBaseRef(worktreePath: string): Promise<string> {
	for (const candidate of ['origin/dev', 'origin/main', 'origin/master']) {
		try {
			const base = await execGit(['merge-base', 'HEAD', candidate], worktreePath, 5000);
			if (base.trim()) return base.trim();
		} catch {
			// candidate not available
		}
	}
	return '';
}

/** Factory that creates a SpaceTaskManager bound to a specific spaceId. */
export type SpaceWorkflowRunTaskManagerFactory = (spaceId: string) => SpaceTaskManager;

export function setupSpaceWorkflowRunHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	spaceWorkflowManager: SpaceWorkflowManager,
	workflowRunRepo: SpaceWorkflowRunRepository,
	gateDataRepo: GateDataRepository,
	spaceRuntimeService: SpaceRuntimeService,
	taskManagerFactory: SpaceWorkflowRunTaskManagerFactory,
	daemonHub: DaemonHub
): void {
	/**
	 * Helper: notify the channel router that gate data has changed.
	 * Triggers lazy node activation for any newly-unblocked channels.
	 * Fire-and-forget — callers do not need to await this.
	 */
	function fireGateChanged(runId: string, gateId: string): void {
		void spaceRuntimeService.notifyGateDataChanged(runId, gateId).catch((err) => {
			log.warn(`notifyGateDataChanged failed for gate "${gateId}" in run "${runId}":`, err);
		});
	}
	// ─── spaceWorkflowRun.start ──────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.start', async (data) => {
		const params = data as {
			spaceId: string;
			workflowId?: string;
			title: string;
			description?: string;
			goalId?: string;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.title || params.title.trim() === '') throw new Error('title is required');

		// Early space validation — ensures "Space not found" surfaces before workflow
		// resolution. Without this check, listWorkflows() would return [] for a
		// nonexistent spaceId, yielding a misleading "No workflows found" error.
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		// Resolve workflow: explicit workflowId or auto-select first workflow
		let workflowId = params.workflowId;
		if (!workflowId) {
			const workflows = spaceWorkflowManager.listWorkflows(params.spaceId);
			if (workflows.length === 0) {
				throw new Error(`No workflows found for space: ${params.spaceId}`);
			}
			workflowId = workflows[0].id;
		} else {
			// Validate provided workflow exists and belongs to this space
			const workflow = spaceWorkflowManager.getWorkflow(workflowId);
			if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
			if (workflow.spaceId !== params.spaceId) throw new Error(`Workflow not found: ${workflowId}`);
		}

		// Get or create the runtime for this space (validates space, starts runtime if needed)
		const runtime = await spaceRuntimeService.createOrGetRuntime(params.spaceId);

		// Create the run and initial task via the runtime
		const { run } = await runtime.startWorkflowRun(
			params.spaceId,
			workflowId,
			params.title,
			params.description,
			params.goalId
		);

		daemonHub
			.emit('space.workflowRun.created', {
				sessionId: 'global',
				spaceId: params.spaceId,
				runId: run.id,
				run,
			})
			.catch((err) => {
				log.warn('Failed to emit space.workflowRun.created:', err);
			});

		return { run };
	});

	// ─── spaceWorkflowRun.list ───────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.list', async (data) => {
		const params = data as { spaceId: string; status?: WorkflowRunStatus };

		if (!params.spaceId) throw new Error('spaceId is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		let runs = workflowRunRepo.listBySpace(params.spaceId);
		if (params.status) {
			runs = runs.filter((r) => r.status === params.status);
		}

		return { runs };
	});

	// ─── spaceWorkflowRun.get ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.get', async (data) => {
		const params = data as { id: string; spaceId?: string };

		if (!params.id) throw new Error('id is required');

		const run = workflowRunRepo.getRun(params.id);
		if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

		// Optional ownership check — if spaceId is provided, reject cross-space access
		if (params.spaceId && run.spaceId !== params.spaceId) {
			throw new Error(`WorkflowRun not found: ${params.id}`);
		}

		return { run };
	});

	// ─── spaceWorkflowRun.resume ─────────────────────────────────────────────
	//
	// Resumes a run that is in blocked state after a human has resolved the
	// blocking issue. Transitions blocked → in_progress so the tick loop
	// will resume processing on the next cycle.
	messageHub.onRequest('spaceWorkflowRun.resume', async (data) => {
		const params = data as { id: string };

		if (!params.id) throw new Error('id is required');

		const run = workflowRunRepo.getRun(params.id);
		if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

		if (run.status !== 'blocked') {
			throw new Error(
				`Cannot resume run ${params.id}: expected status 'blocked', got '${run.status}'`
			);
		}

		// blocked → in_progress (human resolved the blocking issue)
		const updated = workflowRunRepo.transitionStatus(params.id, 'in_progress');

		daemonHub
			.emit('space.workflowRun.updated', {
				sessionId: 'global',
				spaceId: run.spaceId,
				runId: run.id,
				run: updated,
			})
			.catch((err) => {
				log.warn('Failed to emit space.workflowRun.updated:', err);
			});

		return { run: updated };
	});

	// ─── spaceWorkflowRun.markFailed ─────────────────────────────────────────
	//
	// Transitions a run to blocked with a specific failureReason.
	// Production RPC called by the Space Agent when it detects an unrecoverable
	// failure in a task agent session: e.g. agentCrash (unexpected termination),
	// maxIterationsReached, or nodeTimeout. Also used in integration tests to
	// exercise the blocked path without a real LLM session.
	messageHub.onRequest('spaceWorkflowRun.markFailed', async (data) => {
		const params = data as {
			id: string;
			failureReason: WorkflowRunFailureReason;
			reason?: string;
		};

		if (!params.id) throw new Error('id is required');
		if (!params.failureReason) throw new Error('failureReason is required');

		const run = workflowRunRepo.getRun(params.id);
		if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

		if (run.status === 'done' || run.status === 'cancelled') {
			throw new Error(`Cannot mark a ${run.status} workflow run as failed`);
		}
		if (run.status === 'blocked') {
			// Already in blocked — just update failureReason
			const updated =
				workflowRunRepo.updateRun(params.id, { failureReason: params.failureReason }) ?? run;

			daemonHub
				.emit('space.workflowRun.updated', {
					sessionId: 'global',
					spaceId: run.spaceId,
					runId: run.id,
					run: updated,
				})
				.catch((err) => {
					log.warn('Failed to emit space.workflowRun.updated:', err);
				});

			return { run: updated };
		}

		// Transition to blocked then set failureReason
		workflowRunRepo.transitionStatus(params.id, 'blocked');
		const updated =
			workflowRunRepo.updateRun(params.id, { failureReason: params.failureReason }) ?? run;

		daemonHub
			.emit('space.workflowRun.updated', {
				sessionId: 'global',
				spaceId: run.spaceId,
				runId: run.id,
				run: updated,
			})
			.catch((err) => {
				log.warn('Failed to emit space.workflowRun.updated:', err);
			});

		return { run: updated };
	});

	// ─── spaceWorkflowRun.cancel ─────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.cancel', async (data) => {
		const params = data as { id: string };

		if (!params.id) throw new Error('id is required');

		const run = workflowRunRepo.getRun(params.id);
		if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

		if (run.status === 'cancelled') {
			return { success: true };
		}
		if (run.status === 'done') {
			throw new Error('Cannot cancel a done workflow run');
		}

		// Cancel all pending tasks belonging to this run
		const taskManager = taskManagerFactory(run.spaceId);
		const tasks = await taskManager.listTasksByWorkflowRun(run.id);
		for (const task of tasks) {
			if (task.status === 'open' || task.status === 'in_progress') {
				await taskManager.cancelTask(task.id).catch((err: unknown) => {
					log.warn(`Failed to cancel task ${task.id} for run ${run.id}:`, err);
				});
			}
		}

		// Cancel the run (pending/in_progress/blocked → cancelled)
		const updated = workflowRunRepo.transitionStatus(params.id, 'cancelled');

		daemonHub
			.emit('space.workflowRun.updated', {
				sessionId: 'global',
				spaceId: run.spaceId,
				runId: run.id,
				run: updated,
			})
			.catch((err) => {
				log.warn('Failed to emit space.workflowRun.updated:', err);
			});

		return { success: true };
	});

	// ─── spaceWorkflowRun.approveGate ────────────────────────────────────────
	//
	// Writes approval or rejection decision to gate data. Idempotent: calling
	// approve on an already-approved gate returns the existing data unchanged.
	// Rejection transitions the run to `blocked` with `humanRejected`
	// via the status machine. Approval after a prior rejection also transitions
	// the run back to `in_progress` so the workflow resumes.
	messageHub.onRequest('spaceWorkflowRun.approveGate', async (data) => {
		const params = data as {
			runId: string;
			gateId: string;
			approved: boolean;
			reason?: string;
		};

		if (!params.runId) throw new Error('runId is required');
		if (!params.gateId) throw new Error('gateId is required');
		if (params.approved === undefined || params.approved === null) {
			throw new Error('approved is required');
		}

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
			throw new Error(`Cannot modify gate on a ${run.status} workflow run`);
		}

		const existing = gateDataRepo.get(params.runId, params.gateId);

		if (params.approved) {
			// Idempotent: already approved — return existing state
			if (existing?.data?.approved === true) {
				return { run, gateData: existing };
			}

			const gateData = gateDataRepo.merge(params.runId, params.gateId, {
				approved: true,
				approvedAt: Date.now(),
			});

			// If the run was previously rejected (blocked + humanRejected),
			// approval overrides that — transition back to in_progress so the
			// workflow executor picks it up again on the next tick, and clear
			// the stale failureReason so the run appears clean to the UI.
			let updatedRun = run;
			if (run.status === 'blocked' && run.failureReason === 'humanRejected') {
				workflowRunRepo.transitionStatus(params.runId, 'in_progress');
				updatedRun = workflowRunRepo.updateRun(params.runId, { failureReason: null }) ?? run;
			}

			daemonHub
				.emit('space.workflowRun.updated', {
					sessionId: 'global',
					spaceId: run.spaceId,
					runId: run.id,
					run: updatedRun,
				})
				.catch((err) => {
					log.warn('Failed to emit space.workflowRun.updated:', err);
				});

			daemonHub
				.emit('space.gateData.updated', {
					sessionId: 'global',
					spaceId: run.spaceId,
					runId: params.runId,
					gateId: params.gateId,
					data: gateData.data,
				})
				.catch((err) => {
					log.warn('Failed to emit space.gateData.updated:', err);
				});

			// Trigger channel re-evaluation so downstream nodes activate if the gate is now open.
			fireGateChanged(params.runId, params.gateId);

			return { run: updatedRun, gateData };
		} else {
			// Rejection — idempotent: gate data already shows rejected
			if (existing?.data?.approved === false) {
				return { run, gateData: existing };
			}

			const gateData = gateDataRepo.merge(params.runId, params.gateId, {
				approved: false,
				rejectedAt: Date.now(),
				reason: params.reason ?? null,
			});

			// Enforce the state machine: only call transitionStatus when the run is
			// not already in blocked (e.g. blocked by a different mechanism).
			// In either case, write failureReason via a separate updateRun so it
			// is always persisted regardless of whether the status changed.
			if (run.status !== 'blocked') {
				workflowRunRepo.transitionStatus(params.runId, 'blocked');
			}
			const updated =
				workflowRunRepo.updateRun(params.runId, { failureReason: 'humanRejected' }) ?? run;

			daemonHub
				.emit('space.workflowRun.updated', {
					sessionId: 'global',
					spaceId: run.spaceId,
					runId: run.id,
					run: updated,
				})
				.catch((err) => {
					log.warn('Failed to emit space.workflowRun.updated:', err);
				});

			daemonHub
				.emit('space.gateData.updated', {
					sessionId: 'global',
					spaceId: run.spaceId,
					runId: params.runId,
					gateId: params.gateId,
					data: gateData.data,
				})
				.catch((err) => {
					log.warn('Failed to emit space.gateData.updated:', err);
				});

			return { run: updated, gateData };
		}
	});

	// ─── spaceWorkflowRun.writeGateData ──────────────────────────────────────
	//
	// Writes (merges) arbitrary data into a gate's runtime record and triggers
	// channel re-evaluation so downstream nodes activate when a gate opens.
	//
	// Used by test helpers to simulate agent behavior (e.g. planner writing
	// plan_submitted to plan-pr-gate) without spinning up a real agent session.
	// Does NOT enforce allowedWriterRoles — callers are trusted.
	//
	// Disabled in production to prevent unauthorized gate manipulation.
	if (process.env.NODE_ENV !== 'production')
		messageHub.onRequest('spaceWorkflowRun.writeGateData', async (data) => {
			const params = data as { runId: string; gateId: string; data: Record<string, unknown> };

			if (!params.runId) throw new Error('runId is required');
			if (!params.gateId) throw new Error('gateId is required');
			if (!params.data || typeof params.data !== 'object' || Array.isArray(params.data)) {
				throw new Error('data must be an object');
			}

			const run = workflowRunRepo.getRun(params.runId);
			if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

			if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
				throw new Error(`Cannot write gate data on a ${run.status} workflow run`);
			}

			const gateData = gateDataRepo.merge(params.runId, params.gateId, params.data);

			daemonHub
				.emit('space.gateData.updated', {
					sessionId: 'global',
					spaceId: run.spaceId,
					runId: params.runId,
					gateId: params.gateId,
					data: gateData.data,
				})
				.catch((err) => {
					log.warn('Failed to emit space.gateData.updated:', err);
				});

			// Trigger channel re-evaluation so downstream nodes activate if the gate is now open.
			fireGateChanged(params.runId, params.gateId);

			return { gateData };
		});

	// ─── spaceWorkflowRun.listGateData ───────────────────────────────────────
	//
	// Returns all gate data records for a workflow run.
	// Used by the WorkflowCanvas component to show gate status on channel lines.
	messageHub.onRequest('spaceWorkflowRun.listGateData', async (data) => {
		const params = data as { runId: string };

		if (!params.runId) throw new Error('runId is required');

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		const gateDataRecords = gateDataRepo.listByRun(params.runId);

		return { gateData: gateDataRecords };
	});

	// ─── spaceWorkflowRun.getGateArtifacts ───────────────────────────────────
	//
	// Returns the list of changed files and diff summary (additions, deletions)
	// for the workspace associated with a workflow run.
	messageHub.onRequest('spaceWorkflowRun.getGateArtifacts', async (data) => {
		const params = data as { runId: string };

		if (!params.runId) throw new Error('runId is required');

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		const space = await spaceManager.getSpace(run.spaceId);
		const worktreePath = space?.workspacePath;
		if (!worktreePath) {
			throw new Error(`No workspace path found for run: ${params.runId}`);
		}

		const baseRef = await getDiffBaseRef(worktreePath);
		const diffArgs = baseRef
			? ['diff', '--numstat', `${baseRef}..HEAD`]
			: ['diff', '--numstat', 'HEAD'];

		let numstatOutput = '';
		try {
			numstatOutput = await execGit(diffArgs, worktreePath);
		} catch (err) {
			log.warn('git diff --numstat failed:', err);
		}

		const summary = parseNumstat(numstatOutput);
		return { ...summary, worktreePath, baseRef: baseRef || null };
	});

	// ─── spaceWorkflowRun.getFileDiff ────────────────────────────────────────
	//
	// Returns the unified diff for a specific file in the run's worktree.
	// Uses the same base ref logic as getGateArtifacts.
	messageHub.onRequest('spaceWorkflowRun.getFileDiff', async (data) => {
		const params = data as { runId: string; filePath: string };

		if (!params.runId) throw new Error('runId is required');
		if (!params.filePath || params.filePath.trim() === '') {
			throw new Error('filePath is required');
		}
		if (params.filePath.includes('..') || isAbsolute(params.filePath)) {
			throw new Error('filePath must be a relative path within the worktree');
		}

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		const space = await spaceManager.getSpace(run.spaceId);
		const worktreePath = space?.workspacePath;
		if (!worktreePath) {
			throw new Error(`No workspace path found for run: ${params.runId}`);
		}

		const baseRef = await getDiffBaseRef(worktreePath);
		const diffRangeArgs = baseRef ? [`${baseRef}..HEAD`] : ['HEAD'];

		let diff = '';
		try {
			diff = await execGit(['diff', ...diffRangeArgs, '--', params.filePath], worktreePath);
		} catch (err) {
			log.warn('git diff for file failed:', err);
		}

		// Parse per-file stats from the diff itself
		let additions = 0;
		let deletions = 0;
		for (const line of diff.split('\n')) {
			if (line.startsWith('+') && !line.startsWith('+++')) additions++;
			else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
		}

		return { diff, additions, deletions, filePath: params.filePath };
	});
}
