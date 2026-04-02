/**
 * Shared test helpers for Space online integration tests.
 *
 * These helpers drive the workflow gate machinery directly via RPC without
 * spinning up real LLM agent sessions. This lets gate-open/close and node-
 * activation logic be exercised deterministically and quickly with dev proxy.
 *
 * ## Key helpers
 *
 * - createTestSpace        — create a Space with CODING_WORKFLOW_V2 pre-seeded
 * - startWorkflowRun       — start a run and return its ID + initial tasks
 * - writeGateData          — write arbitrary data to a gate (simulates agent write_gate call)
 * - readGateData           — read current gate data for a (runId, gateId) pair
 * - approveGate            — human-approve a gate (writes approved:true + triggers activation)
 * - rejectGate             — human-reject a gate (writes approved:false, run → needs_attention)
 * - markRunFailed          — mark run as needs_attention with a specific failureReason
 * - waitForNodeStatus      — poll until at least one task for a node reaches a target status
 * - waitForRunStatus       — poll until the workflow run reaches a target status
 * - getGateArtifacts       — fetch gate artifacts (changed files + diff) for a run
 * - mockAgentDone          — mark a task as completed directly via spaceTask.update
 * - restartDaemon          — kill the daemon and restart it with the same workspace/database
 *
 * ## Usage
 *
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/space/...
 */

import { createDaemonServer, type DaemonServerContext } from '../../../helpers/daemon-server';
import type {
	Space,
	SpaceAgent,
	SpaceWorkflow,
	SpaceWorkflowRun,
	SpaceTask,
	WorkflowRunFailureReason,
} from '@neokai/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestSpaceFixture {
	space: Space;
	/** All agents seeded into the space */
	agents: SpaceAgent[];
	/** The CODING_WORKFLOW_V2 workflow (preferred) or the first available */
	workflow: SpaceWorkflow;
}

export interface GateDataRecord {
	runId: string;
	gateId: string;
	data: Record<string, unknown>;
	updatedAt: number;
}

export interface GateArtifacts {
	files: Array<{ path: string; additions: number; deletions: number }>;
	totalAdditions: number;
	totalDeletions: number;
	prUrl?: string;
}

// ---------------------------------------------------------------------------
// Space + workflow setup
// ---------------------------------------------------------------------------

/**
 * Create a Space whose name embeds a unique suffix so tests never collide.
 * space.create auto-seeds preset agents and built-in workflows (including V2).
 *
 * Returns the Space, all its agents, and the CODING_WORKFLOW_V2 workflow.
 * Falls back to the first workflow if V2 is not found (should not happen with
 * normal seeding, but keeps tests robust).
 */
export async function createTestSpace(daemon: DaemonServerContext): Promise<TestSpaceFixture> {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

	const space = (await daemon.messageHub.request('space.create', {
		name: `Test Space ${suffix}`,
		description: 'Integration test space — plan-to-approve flow',
		workspacePath: process.cwd(),
		autonomyLevel: 'supervised',
	})) as Space;

	const { agents } = (await daemon.messageHub.request('spaceAgent.list', {
		spaceId: space.id,
	})) as { agents: SpaceAgent[] };

	const { workflows } = (await daemon.messageHub.request('spaceWorkflow.list', {
		spaceId: space.id,
	})) as { workflows: SpaceWorkflow[] };

	// Prefer the V2 workflow (tags include 'v2')
	const workflow =
		workflows.find((w) => Array.isArray(w.tags) && w.tags.includes('v2')) ?? workflows[0];

	if (!workflow)
		throw new Error('No workflows found after space creation — seeding may have failed');

	return { space, agents, workflow };
}

// ---------------------------------------------------------------------------
// Workflow run lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a workflow run and return its ID plus the initial pending tasks.
 *
 * spaceTask.list returns an array directly (not wrapped in { tasks }).
 */
export async function startWorkflowRun(
	daemon: DaemonServerContext,
	spaceId: string,
	workflowId: string,
	title: string
): Promise<{ runId: string; tasks: SpaceTask[] }> {
	const { run } = (await daemon.messageHub.request('spaceWorkflowRun.start', {
		spaceId,
		workflowId,
		title,
	})) as { run: SpaceWorkflowRun };

	const tasks = (await daemon.messageHub.request('spaceTask.list', {
		spaceId,
	})) as SpaceTask[];

	const runTasks = tasks.filter((t) => t.workflowRunId === run.id);
	return { runId: run.id, tasks: runTasks };
}

// ---------------------------------------------------------------------------
// Gate data helpers
// ---------------------------------------------------------------------------

/**
 * Write (merge) data into a gate's runtime record and trigger channel
 * re-evaluation via spaceWorkflowRun.writeGateData RPC.
 *
 * Simulates what an agent does when it calls the write_gate MCP tool —
 * without requiring a real LLM session.
 */
export async function writeGateData(
	daemon: DaemonServerContext,
	runId: string,
	gateId: string,
	data: Record<string, unknown>
): Promise<GateDataRecord> {
	const result = (await daemon.messageHub.request('spaceWorkflowRun.writeGateData', {
		runId,
		gateId,
		data,
	})) as { gateData: GateDataRecord };
	return result.gateData;
}

/**
 * Read current gate data for a (runId, gateId) pair.
 * Returns null when no data has been written to the gate yet.
 */
export async function readGateData(
	daemon: DaemonServerContext,
	runId: string,
	gateId: string
): Promise<GateDataRecord | null> {
	const { gateData } = (await daemon.messageHub.request('spaceWorkflowRun.listGateData', {
		runId,
	})) as { gateData: GateDataRecord[] };
	return gateData.find((g) => g.gateId === gateId) ?? null;
}

/**
 * Human-approve a gate: writes approved:true and triggers downstream node activation.
 * If the run was previously in needs_attention+humanRejected, it resumes to in_progress.
 */
export async function approveGate(
	daemon: DaemonServerContext,
	runId: string,
	gateId: string,
	reason?: string
): Promise<{ run: SpaceWorkflowRun; gateData: GateDataRecord }> {
	return (await daemon.messageHub.request('spaceWorkflowRun.approveGate', {
		runId,
		gateId,
		approved: true,
		reason,
	})) as { run: SpaceWorkflowRun; gateData: GateDataRecord };
}

/**
 * Human-reject a gate: writes approved:false and transitions run to needs_attention
 * with failureReason: 'humanRejected'.
 */
export async function rejectGate(
	daemon: DaemonServerContext,
	runId: string,
	gateId: string,
	reason?: string
): Promise<{ run: SpaceWorkflowRun; gateData: GateDataRecord }> {
	return (await daemon.messageHub.request('spaceWorkflowRun.approveGate', {
		runId,
		gateId,
		approved: false,
		reason,
	})) as { run: SpaceWorkflowRun; gateData: GateDataRecord };
}

// ---------------------------------------------------------------------------
// Status polling helpers
// ---------------------------------------------------------------------------

/**
 * Poll spaceTask.list until at least one task for the given node name has
 * one of the expected statuses. Returns the first matching task.
 *
 * Matches tasks by task.title, which equals the agent slot name set in
 * activateNode() (e.g. 'Planning', 'Plan Review', 'Coding', 'Reviewer 1').
 * For single-agent nodes the slot name equals the node name; for multi-agent
 * nodes each task has the individual slot name.
 */
export async function waitForNodeStatus(
	daemon: DaemonServerContext,
	spaceId: string,
	runId: string,
	/** Node name (e.g. 'Planning', 'Plan Review', 'Coding') or node UUID */
	nodeNameOrId: string,
	expectedStatuses: string[],
	timeout: number
): Promise<SpaceTask> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const tasks = (await daemon.messageHub.request('spaceTask.list', {
			spaceId,
		})) as SpaceTask[];

		const runTasks = tasks.filter((t) => t.workflowRunId === runId);
		const match = runTasks.find(
			(t) => t.title === nodeNameOrId && expectedStatuses.includes(t.status)
		);
		if (match) return match;

		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(
		`Node "${nodeNameOrId}" did not reach status [${expectedStatuses.join(', ')}] within ${timeout}ms`
	);
}

/**
 * Poll spaceTask.list until any task for the given node name exists in the run
 * (i.e. the node has been activated). Useful before calling waitForNodeStatus
 * when you just want to confirm activation happened.
 */
export async function waitForNodeActivated(
	daemon: DaemonServerContext,
	spaceId: string,
	runId: string,
	nodeNameOrId: string,
	timeout: number
): Promise<SpaceTask> {
	return waitForNodeStatus(
		daemon,
		spaceId,
		runId,
		nodeNameOrId,
		['open', 'in_progress', 'done', 'blocked', 'cancelled', 'archived'],
		timeout
	);
}

/**
 * Poll spaceWorkflowRun.get until the run reaches one of the expected statuses.
 * Returns the final run object.
 */
export async function waitForRunStatus(
	daemon: DaemonServerContext,
	runId: string,
	expectedStatuses: string[],
	timeout: number
): Promise<SpaceWorkflowRun> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		// spaceWorkflowRun.get uses 'id' not 'runId'
		const { run } = (await daemon.messageHub.request('spaceWorkflowRun.get', {
			id: runId,
		})) as { run: SpaceWorkflowRun };

		if (expectedStatuses.includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(
		`Run "${runId}" did not reach status [${expectedStatuses.join(', ')}] within ${timeout}ms`
	);
}

// ---------------------------------------------------------------------------
// Artifact helpers
// ---------------------------------------------------------------------------

/**
 * Fetch gate artifacts (changed files and diff summary) for a workflow run.
 */
export async function getGateArtifacts(
	daemon: DaemonServerContext,
	runId: string
): Promise<GateArtifacts> {
	return (await daemon.messageHub.request('spaceWorkflowRun.getGateArtifacts', {
		runId,
	})) as GateArtifacts;
}

// ---------------------------------------------------------------------------
// Task simulation helpers
// ---------------------------------------------------------------------------

/**
 * Mark a task as 'completed' directly via spaceTask.update.
 *
 * Simulates an agent calling report_result without actually running a session.
 * Handles intermediate transitions: if the task is still 'pending', it is first
 * moved to 'in_progress' before completing.
 */
export async function mockAgentDone(
	daemon: DaemonServerContext,
	spaceId: string,
	taskId: string,
	result?: string
): Promise<SpaceTask> {
	// Fetch current status to determine whether we need an intermediate transition
	const current = (await daemon.messageHub.request('spaceTask.get', {
		spaceId,
		taskId,
	})) as SpaceTask;

	// open → in_progress → done; in_progress → done
	if (current.status === 'open') {
		await daemon.messageHub.request('spaceTask.update', {
			spaceId,
			taskId,
			status: 'in_progress',
		});
	}

	return (await daemon.messageHub.request('spaceTask.update', {
		spaceId,
		taskId,
		status: 'done',
		result: result ?? 'Mock agent done',
	})) as SpaceTask;
}

/**
 * Find tasks for a given node/slot name in a run.
 * Matches by task.title, which equals the agent slot name set in activateNode().
 * Returns empty array when the node has not been activated yet.
 */
export async function getTasksForNode(
	daemon: DaemonServerContext,
	spaceId: string,
	runId: string,
	nodeNameOrId: string
): Promise<SpaceTask[]> {
	const tasks = (await daemon.messageHub.request('spaceTask.list', {
		spaceId,
	})) as SpaceTask[];

	return tasks.filter((t) => t.workflowRunId === runId && t.title === nodeNameOrId);
}

/**
 * Poll spaceTask.list until a NEW task appears for the given node name.
 * A "new" task is one whose ID is NOT in `excludeTaskIds` AND has an active
 * (non-terminal) status: pending or in_progress.
 *
 * Use this instead of `waitForNodeActivated` when the node was previously
 * activated (and those tasks are now completed). `waitForNodeActivated` accepts
 * terminal statuses as a match, so it can return the old completed task instead
 * of the freshly created one. This helper avoids that by explicitly excluding
 * known task IDs.
 */
export async function waitForNewNodeTask(
	daemon: DaemonServerContext,
	spaceId: string,
	runId: string,
	nodeNameOrId: string,
	excludeTaskIds: Set<string>,
	timeout: number
): Promise<SpaceTask> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const tasks = (await daemon.messageHub.request('spaceTask.list', {
			spaceId,
		})) as SpaceTask[];

		const match = tasks.find(
			(t) =>
				t.workflowRunId === runId &&
				t.title === nodeNameOrId &&
				!excludeTaskIds.has(t.id) &&
				(t.status === 'open' || t.status === 'in_progress')
		);
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(
		`No new active task for node "${nodeNameOrId}" appeared within ${timeout}ms ` +
			`(excluding ${excludeTaskIds.size} known task IDs)`
	);
}

/**
 * Find tasks for a given workflow node UUID in a run.
 * Unlike getTasksForNode, this does an exact UUID match on workflowNodeId.
 */
export async function getTasksForNodeId(
	daemon: DaemonServerContext,
	spaceId: string,
	runId: string,
	nodeId: string
): Promise<SpaceTask[]> {
	const tasks = (await daemon.messageHub.request('spaceTask.list', {
		spaceId,
	})) as SpaceTask[];

	return tasks.filter((t) => t.workflowRunId === runId && t.workflowNodeId === nodeId);
}

// ---------------------------------------------------------------------------
// Failure simulation helpers
// ---------------------------------------------------------------------------

/**
 * Mark a workflow run as needs_attention with a specific failure reason.
 * Simulates what the Space Agent does when it detects an unrecoverable failure
 * (e.g. agentCrash, maxIterationsReached).
 *
 * Uses the spaceWorkflowRun.markFailed RPC which transitions the run to
 * needs_attention and sets the failureReason field atomically.
 */
export async function markRunFailed(
	daemon: DaemonServerContext,
	runId: string,
	failureReason: WorkflowRunFailureReason,
	reason?: string
): Promise<{ run: SpaceWorkflowRun }> {
	return (await daemon.messageHub.request('spaceWorkflowRun.markFailed', {
		id: runId,
		failureReason,
		reason,
	})) as { run: SpaceWorkflowRun };
}

// ---------------------------------------------------------------------------
// Daemon restart helper
// ---------------------------------------------------------------------------

/**
 * Restart the daemon with the same workspace directory (and therefore the
 * same SQLite database).  Used by restart-persistence tests to verify that
 * gate data, run state, and task state survive a full daemon restart.
 *
 * **In-process mode only** (default): reads the dbPath from the hidden
 * `daemonContext` property that createInProcessDaemonServer attaches to the
 * returned context.  Does NOT work when DAEMON_TEST_SPAWN=true is set.
 *
 * Steps:
 *  1. Extract the workspace path from the running daemon context.
 *  2. Kill the daemon and wait for clean shutdown.
 *  3. Spin up a new daemon targeting the same workspace / DB file.
 *
 * The caller is responsible for updating any variable holding the old
 * DaemonServerContext reference (e.g. `daemon = await restartDaemon(daemon)`).
 */
export async function restartDaemon(daemon: DaemonServerContext): Promise<DaemonServerContext> {
	const { workspacePath } = daemon;

	if (!workspacePath) {
		throw new Error(
			'restartDaemon: workspacePath not found on daemon context — only works with ' +
				'in-process mode (do not set DAEMON_TEST_SPAWN=true for restart tests)'
		);
	}

	// Gracefully shut down the current daemon
	daemon.kill('SIGTERM');
	await daemon.waitForExit();

	// Start a new daemon with the same workspace so it picks up the existing DB
	return createDaemonServer({ workspacePath });
}
