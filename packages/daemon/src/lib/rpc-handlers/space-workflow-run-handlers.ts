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
 * - spaceWorkflowRun.getGateArtifacts   - Returns uncommitted files and diff summary for a run's worktree
 * - spaceWorkflowRun.getFileDiff        - Returns unified diff for a specific uncommitted file
 * - spaceWorkflowRun.getCommits         - Returns git commits between branch point and HEAD with per-commit stats
 * - spaceWorkflowRun.getCommitFileDiff  - Returns unified diff for a specific file in a specific commit
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
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorktreeManager } from '../space/managers/space-worktree-manager';
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
 * Resolve the git worktree path for a workflow run.
 *
 * Resolution order:
 * 1. If `taskId` is provided, use that task's worktree directly.
 * 2. Otherwise, look up all tasks for the run and use the first one's worktree.
 *    (Logs a warning when a run has multiple tasks — only first task is shown.)
 * 3. Falls back to the space's root `workspacePath` when no task worktree exists.
 *
 * @returns The resolved path, or null if no path can be determined.
 */
async function resolveWorktreePath(
	runId: string,
	spaceId: string,
	spaceManager: SpaceManager,
	spaceTaskRepo: SpaceTaskRepository,
	spaceWorktreeManager: SpaceWorktreeManager,
	taskId?: string
): Promise<string | null> {
	// If the caller provided a specific taskId, use that task's worktree directly.
	if (taskId) {
		const taskWorktreePath = await spaceWorktreeManager.getTaskWorktreePath(spaceId, taskId);
		if (taskWorktreePath) {
			return taskWorktreePath;
		}
		log.warn(
			`resolveWorktreePath: no worktree found for taskId=${taskId}, falling back to root workspace`
		);
	} else {
		// No taskId provided: look up tasks for the run and use the first one's worktree.
		const tasks = spaceTaskRepo.listByWorkflowRun(runId);
		if (tasks.length > 0) {
			if (tasks.length > 1) {
				log.warn(
					`resolveWorktreePath: run ${runId} has ${tasks.length} tasks — showing artifacts for task ${tasks[0].id} only. Pass taskId to target a specific task.`
				);
			}
			const firstTaskWorktreePath = await spaceWorktreeManager.getTaskWorktreePath(
				spaceId,
				tasks[0].id
			);
			if (firstTaskWorktreePath) {
				return firstTaskWorktreePath;
			}
			log.warn(
				`resolveWorktreePath: no worktree found for task ${tasks[0].id} in run ${runId}, falling back to root workspace`
			);
		} else {
			log.warn(
				`resolveWorktreePath: no tasks found for run ${runId}, falling back to root workspace`
			);
		}
	}

	// Fallback: use the root workspace path from the space.
	const space = await spaceManager.getSpace(spaceId);
	return space?.workspacePath ?? null;
}

/**
 * Returns true when `worktreePath` is inside a git repository.
 * Uses `git rev-parse --git-dir` which exits non-zero outside a repo.
 */
async function isGitRepo(worktreePath: string): Promise<boolean> {
	try {
		await execGit(['rev-parse', '--git-dir'], worktreePath, 5000);
		return true;
	} catch {
		return false;
	}
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

interface CommitInfo {
	sha: string;
	message: string;
	author: string;
	timestamp: number;
	additions: number;
	deletions: number;
	fileCount: number;
}

/**
 * Parse `git log --format=COMMIT:%H|%s|%aN|%at --numstat` output.
 * Each commit block starts with a "COMMIT:" line followed by numstat lines.
 */
function parseCommitLog(output: string): CommitInfo[] {
	const commits: CommitInfo[] = [];
	let current: CommitInfo | null = null;

	for (const line of output.split('\n')) {
		if (line.startsWith('COMMIT:')) {
			if (current) commits.push(current);
			const parts = line.slice('COMMIT:'.length).split('|');
			current = {
				sha: parts[0]?.trim() ?? '',
				message: parts[1]?.trim() ?? '',
				author: parts[2]?.trim() ?? '',
				timestamp: parseInt(parts[3]?.trim() ?? '0', 10) * 1000,
				additions: 0,
				deletions: 0,
				fileCount: 0,
			};
		} else if (current && line.trim()) {
			// numstat line: <additions>\t<deletions>\t<path>
			const parts = line.split('\t');
			if (parts.length >= 3) {
				current.additions += parseInt(parts[0], 10) || 0;
				current.deletions += parseInt(parts[1], 10) || 0;
				current.fileCount += 1;
			}
		}
	}
	if (current) commits.push(current);
	return commits;
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
	daemonHub: DaemonHub,
	spaceTaskRepo: SpaceTaskRepository,
	spaceWorktreeManager: SpaceWorktreeManager,
	artifactRepo: WorkflowRunArtifactRepository
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
			params.description
		);

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
				approvalSource: 'human',
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
				approvalSource: 'human',
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

			// Block the canonical task with gate_rejected reason
			// Skip terminal tasks (done, cancelled, archived) — their status
			// cannot transition back to blocked.
			const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled', 'archived']);
			const runTasks = spaceTaskRepo.listByWorkflowRun(params.runId);
			const canonicalTask = runTasks[0];
			if (canonicalTask && !TERMINAL_TASK_STATUSES.has(canonicalTask.status)) {
				const taskMgr = taskManagerFactory(run.spaceId);
				await taskMgr.setTaskStatus(canonicalTask.id, 'blocked', {
					result: params.reason ?? 'Gate rejected',
					blockReason: 'gate_rejected',
				});
			}

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
	// Used by test helpers to simulate agent behavior (e.g. writing approval/vote
	// gate payloads) without spinning up a real agent session.
	// Does NOT enforce allowedWriterRoles — callers are trusted.
	//
	// Disabled in production to prevent unauthorized gate manipulation.
	if (process.env.NODE_ENV !== 'production')
		messageHub.onRequest('spaceWorkflowRun.writeGateData', async (data) => {
			const params = data as {
				runId: string;
				gateId: string;
				data: Record<string, unknown>;
				/**
				 * When true, skip channel routing after writing gate data.
				 * Used by E2E browser tests that seed gate data for visual assertions
				 * without wanting to activate downstream nodes. The channel router can
				 * reset cyclic gates (resetOnCycle: true) as a side-effect of opening
				 * them, which would immediately wipe the data the test just wrote and
				 * cause the canvas to show a stale "blocked" state.
				 * Defaults to false (i.e., fireGateChanged is called as usual) so that
				 * daemon-level integration tests still get the downstream node activation
				 * they depend on.
				 */
				skipChannelRouting?: boolean;
			};

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

			// Only trigger channel routing if skipChannelRouting is not set.
			// E2E tests pass skipChannelRouting: true to seed gate data for visual
			// assertions without activating downstream nodes or triggering cyclic gate
			// resets (resetOnCycle: true gates get wiped when the cyclic channel fires,
			// causing the canvas to show stale "blocked" state instead of the written data).
			if (!params.skipChannelRouting) {
				fireGateChanged(params.runId, params.gateId);
			}

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
		const params = data as { runId: string; taskId?: string };

		if (!params.runId) throw new Error('runId is required');

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		// Resolve the worktree path: prefer the task-specific git worktree (where
		// the agent commits its work) over the root workspace path.
		const worktreePath = await resolveWorktreePath(
			run.id,
			run.spaceId,
			spaceManager,
			spaceTaskRepo,
			spaceWorktreeManager,
			params.taskId
		);
		if (!worktreePath) {
			throw new Error(`No workspace path found for run: ${params.runId}`);
		}

		if (!(await isGitRepo(worktreePath))) {
			return { files: [], totalAdditions: 0, totalDeletions: 0, worktreePath, isGitRepo: false };
		}

		// Uncommitted changes only: working tree vs HEAD
		let numstatOutput = '';
		try {
			numstatOutput = await execGit(['diff', 'HEAD', '--numstat'], worktreePath);
		} catch (err) {
			log.warn('git diff HEAD --numstat failed:', err);
		}

		const summary = parseNumstat(numstatOutput);
		return { ...summary, worktreePath, isGitRepo: true };
	});

	// ─── spaceWorkflowRun.getFileDiff ────────────────────────────────────────
	//
	// Returns the unified diff for a specific file in the run's worktree.
	// Uses the same base ref logic as getGateArtifacts.
	messageHub.onRequest('spaceWorkflowRun.getFileDiff', async (data) => {
		const params = data as { runId: string; filePath: string; taskId?: string };

		if (!params.runId) throw new Error('runId is required');
		if (!params.filePath || params.filePath.trim() === '') {
			throw new Error('filePath is required');
		}
		if (params.filePath.includes('..') || isAbsolute(params.filePath)) {
			throw new Error('filePath must be a relative path within the worktree');
		}

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		// Resolve the worktree path: prefer the task-specific git worktree (where
		// the agent commits its work) over the root workspace path.
		const worktreePath = await resolveWorktreePath(
			run.id,
			run.spaceId,
			spaceManager,
			spaceTaskRepo,
			spaceWorktreeManager,
			params.taskId
		);
		if (!worktreePath) {
			throw new Error(`No workspace path found for run: ${params.runId}`);
		}

		if (!(await isGitRepo(worktreePath))) {
			return { diff: '', additions: 0, deletions: 0, filePath: params.filePath };
		}

		// Uncommitted diff: working tree vs HEAD
		let diff = '';
		try {
			diff = await execGit(['diff', 'HEAD', '--', params.filePath], worktreePath);
		} catch (err) {
			log.warn('git diff HEAD for file failed:', err);
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

	// ─── spaceWorkflowRun.getCommits ─────────────────────────────────────────
	//
	// Returns the list of commits between the branch point (baseRef) and HEAD,
	// with per-commit addition/deletion/file-count stats.
	messageHub.onRequest('spaceWorkflowRun.getCommits', async (data) => {
		const params = data as { runId: string; taskId?: string };
		if (!params.runId) throw new Error('runId is required');

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		const worktreePath = await resolveWorktreePath(
			run.id,
			run.spaceId,
			spaceManager,
			spaceTaskRepo,
			spaceWorktreeManager,
			params.taskId
		);
		if (!worktreePath) throw new Error(`No workspace path found for run: ${params.runId}`);

		if (!(await isGitRepo(worktreePath))) {
			return { commits: [], baseRef: null, isGitRepo: false };
		}

		const baseRef = await getDiffBaseRef(worktreePath);
		const range = baseRef ? `${baseRef}..HEAD` : '';

		let logOutput = '';
		try {
			const args = ['log', '--format=COMMIT:%H|%s|%aN|%at', '--numstat'];
			if (range) args.push(range);
			logOutput = await execGit(args, worktreePath);
		} catch (err) {
			log.warn('git log --numstat failed:', err);
		}

		const commits = parseCommitLog(logOutput);
		return { commits, baseRef: baseRef || null, isGitRepo: true };
	});

	// ─── spaceWorkflowRun.getCommitFiles ─────────────────────────────────────
	//
	// Returns the list of files changed in a specific commit with per-file stats.
	// Uses `git diff-tree --numstat -r <sha>`.
	messageHub.onRequest('spaceWorkflowRun.getCommitFiles', async (data) => {
		const params = data as { runId: string; taskId?: string; commitSha: string };
		if (!params.runId) throw new Error('runId is required');
		if (!params.commitSha || !/^[0-9a-f]{4,64}$/i.test(params.commitSha)) {
			throw new Error('commitSha must be a valid git sha');
		}

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		const worktreePath = await resolveWorktreePath(
			run.id,
			run.spaceId,
			spaceManager,
			spaceTaskRepo,
			spaceWorktreeManager,
			params.taskId
		);
		if (!worktreePath) throw new Error(`No workspace path found for run: ${params.runId}`);

		if (!(await isGitRepo(worktreePath))) {
			return { files: [] };
		}

		let numstatOutput = '';
		try {
			numstatOutput = await execGit(
				['diff-tree', '--numstat', '-r', params.commitSha],
				worktreePath
			);
		} catch (err) {
			log.warn('git diff-tree --numstat failed:', err);
		}

		const summary = parseNumstat(numstatOutput);
		return { files: summary.files };
	});

	// ─── spaceWorkflowRun.getCommitFileDiff ──────────────────────────────────
	//
	// Returns the unified diff for a specific file within a specific commit
	// using `git show <sha> -- <filePath>`.
	messageHub.onRequest('spaceWorkflowRun.getCommitFileDiff', async (data) => {
		const params = data as {
			runId: string;
			taskId?: string;
			commitSha: string;
			filePath: string;
		};
		if (!params.runId) throw new Error('runId is required');
		if (!params.commitSha || !/^[0-9a-f]{4,64}$/i.test(params.commitSha)) {
			throw new Error('commitSha must be a valid git sha');
		}
		if (!params.filePath || params.filePath.trim() === '') {
			throw new Error('filePath is required');
		}
		if (params.filePath.includes('..') || isAbsolute(params.filePath)) {
			throw new Error('filePath must be a relative path within the worktree');
		}

		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

		const worktreePath = await resolveWorktreePath(
			run.id,
			run.spaceId,
			spaceManager,
			spaceTaskRepo,
			spaceWorktreeManager,
			params.taskId
		);
		if (!worktreePath) throw new Error(`No workspace path found for run: ${params.runId}`);

		if (!(await isGitRepo(worktreePath))) {
			return { diff: '', additions: 0, deletions: 0, filePath: params.filePath };
		}

		let diff = '';
		try {
			diff = await execGit(['show', params.commitSha, '--', params.filePath], worktreePath);
		} catch (err) {
			log.warn('git show for commit file failed:', err);
		}

		let additions = 0;
		let deletions = 0;
		for (const line of diff.split('\n')) {
			if (line.startsWith('+') && !line.startsWith('+++')) additions++;
			else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
		}

		return { diff, additions, deletions, filePath: params.filePath };
	});

	// ─── spaceWorkflowRun.listArtifacts ─────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.listArtifacts', async (data) => {
		const params = data as {
			runId: string;
			nodeId?: string;
			artifactType?: string;
		};
		if (!params.runId) throw new Error('runId is required');
		const run = workflowRunRepo.getRun(params.runId);
		if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);
		const artifacts = artifactRepo.listByRun(params.runId, {
			nodeId: params.nodeId,
			artifactType: params.artifactType,
		});
		return { artifacts };
	});
}
