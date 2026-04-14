/**
 * Unit tests for SpaceStore
 *
 * Covers:
 * - Space selection and clearSpace
 * - Promise-chain lock (race condition prevention)
 * - State clearing on space switch
 * - Event subscriptions: space.updated/archived/deleted, tasks, workflowRuns, agents, workflows
 * - Auto-cleanup on space switch
 * - Computed signals: activeTasks, activeRuns, tasksByRun, standaloneTasks
 * - CRUD methods call correct RPC endpoints
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
	NodeExecution,
	Space,
	SpaceTask,
	SpaceWorkflowRun,
	SpaceAgent,
	SpaceWorkflow,
	SpaceTaskActivityMember,
} from '@neokai/shared';

// -------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works
// -------------------------------------------------------

let mockEventHandlers: Map<string, (event: unknown) => void>;
/** Multi-handler map: supports multiple subscribers per event (used in P0 duplicate-subscription tests) */
let mockEventHandlerSets: Map<string, Set<(event: unknown) => void>>;
let mockHub: ReturnType<typeof makeMockHub>;

/** Fire all registered handlers for an event (both single and multi-handler maps) */
function fireMockEvent(eventName: string, data: unknown): void {
	mockEventHandlerSets.get(eventName)?.forEach((h) => h(data));
}

function makeSpace(id = 'space-1'): Space {
	return {
		id,
		slug: 'test-space',
		name: 'Test Space',
		workspacePath: '/workspace',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		paused: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

let _taskCounter = 0;
function makeTask(id: string, status = 'open', workflowRunId?: string): SpaceTask {
	return {
		id,
		spaceId: 'space-1',
		taskNumber: ++_taskCounter,
		title: `Task ${id}`,
		description: '',
		status: status as SpaceTask['status'],
		priority: 'normal',
		labels: [],
		dependsOn: [],
		result: null,
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		blockReason: null,
		approvalSource: null,
		approvalReason: null,
		approvedAt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...(workflowRunId ? { workflowRunId } : {}),
	};
}

function makeRun(id: string, status = 'pending'): SpaceWorkflowRun {
	return {
		id,
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: `Run ${id}`,
		status: status as SpaceWorkflowRun['status'],
		startedAt: null,
		completedAt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeAgent(id: string): SpaceAgent {
	return {
		id,
		spaceId: 'space-1',
		name: `Agent ${id}`,
		customPrompt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeWorkflow(id: string): SpaceWorkflow {
	return {
		id,
		spaceId: 'space-1',
		name: `Workflow ${id}`,
		nodes: [],
		startNodeId: '',
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeTaskActivityRows(taskId = 't1'): SpaceTaskActivityMember[] {
	return [
		{
			id: `session-${taskId}`,
			sessionId: `session-${taskId}`,
			kind: 'task_agent',
			label: 'Task Agent',
			role: 'task-agent',
			state: 'active',
			processingStatus: 'processing',
			processingPhase: 'thinking',
			messageCount: 2,
			taskId,
			taskTitle: `Task ${taskId}`,
			taskStatus: 'in_progress',
			updatedAt: Date.now(),
			lastMessageAt: Date.now(),
		},
	];
}

function makeMockHub() {
	return {
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		onConnection: vi.fn(() => () => {}),
		onEvent: vi.fn((eventName: string, handler: (e: unknown) => void) => {
			// Single-handler map — last registration wins (used by most existing tests)
			mockEventHandlers.set(eventName, handler);
			// Multi-handler set — tracks all active handlers for P0 duplicate-subscription tests
			if (!mockEventHandlerSets.has(eventName)) {
				mockEventHandlerSets.set(eventName, new Set());
			}
			mockEventHandlerSets.get(eventName)!.add(handler);
			return () => {
				mockEventHandlers.delete(eventName);
				mockEventHandlerSets.get(eventName)?.delete(handler);
			};
		}),
		request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
			if (method === 'space.overview') {
				const spaceId = (params?.id ?? params?.slug ?? 'space-1') as string;
				return {
					space: makeSpace(spaceId),
					tasks: [],
					workflowRuns: [],
					sessions: [],
				};
			}
			if (method === 'spaceAgent.list') return { agents: [] };
			if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
			if (method === 'spaceWorkflow.list') return { workflows: [] };
			// Daemon returns Space directly (not wrapped)
			if (method === 'space.pause') return { ...makeSpace(), paused: true };
			if (method === 'space.resume') return { ...makeSpace(), paused: false };
			if (method === 'space.update') return makeSpace();
			// Daemon returns SpaceTask directly (not wrapped)
			if (method === 'spaceTask.create') return makeTask('new-task');
			if (method === 'spaceTask.update') return makeTask('t1', 'in_progress');
			// spaceAgent handlers return wrapped { agent }
			if (method === 'spaceAgent.create') return { agent: makeAgent('new-agent') };
			if (method === 'spaceAgent.update') return { agent: makeAgent('a1') };
			// spaceWorkflow handlers return wrapped { workflow }
			if (method === 'spaceWorkflow.create') return { workflow: makeWorkflow('new-wf') };
			if (method === 'spaceWorkflow.update') return { workflow: makeWorkflow('wf1') };
			if (method === 'nodeExecution.list') return { executions: [] };
			// space.listWithTasks returns array of spaces enriched with tasks
			if (method === 'space.listWithTasks')
				return [
					{ ...makeSpace('s1'), tasks: [] },
					{ ...makeSpace('s2'), tasks: [] },
				];
			return {};
		}),
	};
}

vi.mock('../connection-manager.ts', () => ({
	connectionManager: {
		getHub: vi.fn(async () => mockHub),
		getHubIfConnected: vi.fn(() => mockHub),
	},
}));

// -------------------------------------------------------
// Import under test
// -------------------------------------------------------

let spaceStore: typeof import('../space-store').spaceStore;

async function getStore() {
	const mod = await import('../space-store.ts');
	return mod.spaceStore;
}

async function resetStore() {
	mockEventHandlers = new Map();
	mockEventHandlerSets = new Map();
	mockHub = makeMockHub();
	spaceStore = await getStore();
	// Deselect if a space is selected
	if (spaceStore.spaceId.value !== null) {
		await spaceStore.clearSpace();
	}
	mockEventHandlers.clear();
}

// -------------------------------------------------------
// Test suites
// -------------------------------------------------------

describe('SpaceStore — space selection', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('starts with no space selected', () => {
		expect(spaceStore.spaceId.value).toBeNull();
		expect(spaceStore.space.value).toBeNull();
		expect(spaceStore.loading.value).toBe(false);
	});

	it('sets spaceId after selectSpace()', async () => {
		await spaceStore.selectSpace('space-1');
		expect(spaceStore.spaceId.value).toBe('space-1');
	});

	it('fetches initial state on selectSpace()', async () => {
		await spaceStore.selectSpace('space-1');
		// 'space-1' is not a UUID, so the store sends it as a slug
		expect(mockHub.request).toHaveBeenCalledWith('space.overview', { slug: 'space-1' });
		expect(spaceStore.space.value?.id).toBe('space-1');
	});

	it('does not eagerly fetch agents/workflows on selectSpace() — they are lazy-loaded', async () => {
		await spaceStore.selectSpace('space-1');
		const calledMethods = mockHub.request.mock.calls.map((c: unknown[]) => c[0]);
		expect(calledMethods).not.toContain('spaceAgent.list');
		expect(calledMethods).not.toContain('spaceAgent.listBuiltInTemplates');
		expect(calledMethods).not.toContain('spaceWorkflow.list');
		expect(calledMethods).not.toContain('spaceWorkflow.listBuiltInTemplates');
		expect(calledMethods).not.toContain('nodeExecution.list');
	});

	it('fetches agents and workflows via ensureConfigData()', async () => {
		await spaceStore.selectSpace('space-1');
		mockHub.request.mockClear();

		await spaceStore.ensureConfigData();
		expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.list', { spaceId: 'space-1' });
		expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.listBuiltInTemplates', {
			spaceId: 'space-1',
		});
		expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.list', { spaceId: 'space-1' });
		expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.listBuiltInTemplates', {
			spaceId: 'space-1',
		});
		expect(spaceStore.configDataLoaded.value).toBe(true);
	});

	it('ensureConfigData() is idempotent — second call is a no-op', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.ensureConfigData();
		mockHub.request.mockClear();

		await spaceStore.ensureConfigData();
		expect(mockHub.request).not.toHaveBeenCalled();
	});

	it('clears state on clearSpace()', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1')];

		await spaceStore.clearSpace();

		expect(spaceStore.spaceId.value).toBeNull();
		expect(spaceStore.space.value).toBeNull();
		expect(spaceStore.tasks.value).toEqual([]);
		expect(spaceStore.workflowRuns.value).toEqual([]);
		expect(spaceStore.agents.value).toEqual([]);
		expect(spaceStore.workflows.value).toEqual([]);
	});

	it('is a no-op when selecting the same space', async () => {
		await spaceStore.selectSpace('space-1');
		const callCount = mockHub.request.mock.calls.length;

		await spaceStore.selectSpace('space-1');

		expect(mockHub.request.mock.calls.length).toBe(callCount);
	});
});

describe('SpaceStore — promise-chain lock', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('handles rapid space switches atomically', async () => {
		const p1 = spaceStore.selectSpace('space-1');
		const p2 = spaceStore.selectSpace('space-2');

		await Promise.all([p1, p2]);

		// Final state should be space-2 (last one wins)
		expect(spaceStore.spaceId.value).toBe('space-2');
	});

	it('clears old space state when switching', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1')];

		await spaceStore.selectSpace('space-2');

		// state was cleared when switching
		expect(spaceStore.tasks.value).toEqual([]);
		expect(spaceStore.spaceId.value).toBe('space-2');
	});

	it('future selectSpace calls still work after a doSelect error', async () => {
		// Simulate a failure in fetchInitialState for the first call
		mockHub.request.mockRejectedValueOnce(new Error('network error'));

		await spaceStore.selectSpace('space-1');
		// First call failed — error should be set but chain not broken
		expect(spaceStore.error.value).toBeTruthy();

		// Reset mock to succeed
		mockHub.request.mockImplementation(async (method: string) => {
			if (method === 'space.overview')
				return { space: makeSpace('space-2'), tasks: [], workflowRuns: [], sessions: [] };
			if (method === 'spaceAgent.list') return { agents: [] };
			if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
			if (method === 'spaceWorkflow.list') return { workflows: [] };
			return {};
		});

		// Second call should still work
		await spaceStore.selectSpace('space-2');
		expect(spaceStore.spaceId.value).toBe('space-2');
	});
});

describe('SpaceStore — channel join/leave', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('joins space:${spaceId} channel on selectSpace()', async () => {
		await spaceStore.selectSpace('space-1');
		expect(mockHub.joinChannel).toHaveBeenCalledWith('space:space-1');
	});

	it('leaves space:${spaceId} channel on clearSpace()', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.clearSpace();
		expect(mockHub.leaveChannel).toHaveBeenCalledWith('space:space-1');
	});

	it('leaves old channel and joins new channel on space switch', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.selectSpace('space-2');

		expect(mockHub.leaveChannel).toHaveBeenCalledWith('space:space-1');
		expect(mockHub.joinChannel).toHaveBeenCalledWith('space:space-2');
	});
});

describe('SpaceStore — event subscriptions auto-cleanup', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('registers event handlers on selectSpace()', async () => {
		await spaceStore.selectSpace('space-1');

		expect(mockEventHandlers.has('space.updated')).toBe(true);
		expect(mockEventHandlers.has('space.archived')).toBe(true);
		expect(mockEventHandlers.has('space.deleted')).toBe(true);
		expect(mockEventHandlers.has('space.task.created')).toBe(true);
		expect(mockEventHandlers.has('space.task.updated')).toBe(true);
		expect(mockEventHandlers.has('space.workflowRun.created')).toBe(true);
		expect(mockEventHandlers.has('space.workflowRun.updated')).toBe(true);
		expect(mockEventHandlers.has('spaceAgent.created')).toBe(true);
		expect(mockEventHandlers.has('spaceAgent.updated')).toBe(true);
		expect(mockEventHandlers.has('spaceAgent.deleted')).toBe(true);
		expect(mockEventHandlers.has('spaceWorkflow.created')).toBe(true);
		expect(mockEventHandlers.has('spaceWorkflow.updated')).toBe(true);
		expect(mockEventHandlers.has('spaceWorkflow.deleted')).toBe(true);
		// spaceSessionGroup.* events were removed in Task 8.2 (session group tables dropped)
	});

	it('removes event handlers on clearSpace()', async () => {
		await spaceStore.selectSpace('space-1');
		expect(mockEventHandlers.size).toBeGreaterThan(0);

		await spaceStore.clearSpace();
		expect(mockEventHandlers.size).toBe(0);
	});

	it('removes old handlers when switching spaces', async () => {
		await spaceStore.selectSpace('space-1');
		const firstSpaceHandlerCount = mockEventHandlers.size;
		expect(firstSpaceHandlerCount).toBeGreaterThan(0);

		await spaceStore.selectSpace('space-2');
		// Handlers should still exist but now filter for space-2
		expect(mockEventHandlers.size).toBeGreaterThan(0);
	});
});

describe('SpaceStore — space.updated event', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('merges partial space update into space signal', async () => {
		await spaceStore.selectSpace('space-1');
		expect(spaceStore.space.value?.name).toBe('Test Space');

		const handler = mockEventHandlers.get('space.updated');
		expect(handler).toBeDefined();

		handler!({ sessionId: 'global', spaceId: 'space-1', space: { name: 'Renamed Space' } });

		expect(spaceStore.space.value?.name).toBe('Renamed Space');
		// Other fields preserved
		expect(spaceStore.space.value?.workspacePath).toBe('/workspace');
	});

	it('ignores space.updated event with no space payload', async () => {
		await spaceStore.selectSpace('space-1');
		const originalName = spaceStore.space.value?.name;

		const handler = mockEventHandlers.get('space.updated');
		handler!({ sessionId: 'global', spaceId: 'space-1' });

		expect(spaceStore.space.value?.name).toBe(originalName);
	});

	it('ignores space.updated event for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const originalName = spaceStore.space.value?.name;

		const handler = mockEventHandlers.get('space.updated');
		handler!({ sessionId: 'global', spaceId: 'space-99', space: { name: 'Other' } });

		expect(spaceStore.space.value?.name).toBe(originalName);
	});
});

describe('SpaceStore — space.archived event', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('clears selection when space is archived externally', async () => {
		await spaceStore.selectSpace('space-1');
		expect(spaceStore.spaceId.value).toBe('space-1');

		const handler = mockEventHandlers.get('space.archived');
		handler!({ sessionId: 'global', spaceId: 'space-1', space: makeSpace() });

		// Allow the async clearSpace to run
		await new Promise((r) => setTimeout(r, 0));

		expect(spaceStore.spaceId.value).toBeNull();
	});

	it('ignores space.archived event for a different space', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.archived');
		handler!({ sessionId: 'global', spaceId: 'space-99', space: makeSpace('space-99') });

		await new Promise((r) => setTimeout(r, 0));

		expect(spaceStore.spaceId.value).toBe('space-1');
	});
});

describe('SpaceStore — space.deleted event', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('clears selection when space is deleted externally', async () => {
		await spaceStore.selectSpace('space-1');
		expect(spaceStore.spaceId.value).toBe('space-1');

		const handler = mockEventHandlers.get('space.deleted');
		handler!({ sessionId: 'global', spaceId: 'space-1' });

		await new Promise((r) => setTimeout(r, 0));

		expect(spaceStore.spaceId.value).toBeNull();
	});

	it('ignores space.deleted event for a different space', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.deleted');
		handler!({ sessionId: 'global', spaceId: 'space-99' });

		await new Promise((r) => setTimeout(r, 0));

		expect(spaceStore.spaceId.value).toBe('space-1');
	});
});

describe('SpaceStore — space.task.created event', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('appends a new task', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.task.created');
		expect(handler).toBeDefined();

		const task = makeTask('new-t');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 'new-t', task });

		expect(spaceStore.tasks.value).toContainEqual(task);
	});

	it('does not append duplicate tasks', async () => {
		await spaceStore.selectSpace('space-1');
		const task = makeTask('dup');
		spaceStore.tasks.value = [task];

		const handler = mockEventHandlers.get('space.task.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 'dup', task });

		expect(spaceStore.tasks.value.length).toBe(1);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const task = makeTask('other');

		const handler = mockEventHandlers.get('space.task.created');
		handler!({ sessionId: 'global', spaceId: 'space-99', taskId: 'other', task });

		expect(spaceStore.tasks.value).not.toContainEqual(task);
	});
});

describe('SpaceStore — space.task.updated event', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('replaces an existing task', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1', 'pending')];

		const updated = makeTask('t1', 'in_progress');
		const handler = mockEventHandlers.get('space.task.updated');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 't1', task: updated });

		expect(spaceStore.tasks.value[0].status).toBe('in_progress');
	});

	it('appends task if not yet in list', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [];

		const task = makeTask('t2', 'in_progress');
		const handler = mockEventHandlers.get('space.task.updated');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 't2', task });

		expect(spaceStore.tasks.value).toContainEqual(task);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1', 'pending')];

		const updated = makeTask('t1', 'in_progress');
		const handler = mockEventHandlers.get('space.task.updated');
		handler!({ sessionId: 'global', spaceId: 'space-99', taskId: 't1', task: updated });

		expect(spaceStore.tasks.value[0].status).toBe('pending');
	});
});

describe('SpaceStore — space.workflowRun.created event', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('appends a new workflow run', async () => {
		await spaceStore.selectSpace('space-1');

		const run = makeRun('run-1');
		const handler = mockEventHandlers.get('space.workflowRun.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', runId: 'run-1', run });

		expect(spaceStore.workflowRuns.value).toContainEqual(run);
	});

	it('does not append duplicate runs', async () => {
		await spaceStore.selectSpace('space-1');
		const run = makeRun('run-dup');
		spaceStore.workflowRuns.value = [run];

		const handler = mockEventHandlers.get('space.workflowRun.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', runId: 'run-dup', run });

		expect(spaceStore.workflowRuns.value.length).toBe(1);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const run = makeRun('run-other');

		const handler = mockEventHandlers.get('space.workflowRun.created');
		handler!({ sessionId: 'global', spaceId: 'space-99', runId: 'run-other', run });

		expect(spaceStore.workflowRuns.value.length).toBe(0);
	});
});

describe('SpaceStore — space.workflowRun.updated event', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('merges partial update into existing run', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.workflowRuns.value = [makeRun('run-1', 'pending')];

		const handler = mockEventHandlers.get('space.workflowRun.updated');
		handler!({
			sessionId: 'global',
			spaceId: 'space-1',
			runId: 'run-1',
			run: { status: 'in_progress' },
		});

		expect(spaceStore.workflowRuns.value[0].status).toBe('in_progress');
	});

	it('ignores update with no run payload', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.workflowRuns.value = [makeRun('run-1', 'pending')];

		const handler = mockEventHandlers.get('space.workflowRun.updated');
		handler!({ sessionId: 'global', spaceId: 'space-1', runId: 'run-1' });

		expect(spaceStore.workflowRuns.value[0].status).toBe('pending');
	});
});

describe('SpaceStore — spaceAgent events', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('appends new agent on created event', async () => {
		await spaceStore.selectSpace('space-1');
		const agent = makeAgent('a1');

		const handler = mockEventHandlers.get('spaceAgent.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', agent });

		expect(spaceStore.agents.value).toContainEqual(agent);
	});

	it('replaces agent on updated event', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.agents.value = [{ ...makeAgent('a1'), name: 'Old Name' }];

		const updated = { ...makeAgent('a1'), name: 'New Name' };
		const handler = mockEventHandlers.get('spaceAgent.updated');
		handler!({ sessionId: 'global', spaceId: 'space-1', agent: updated });

		expect(spaceStore.agents.value[0].name).toBe('New Name');
	});

	it('removes agent on deleted event', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.agents.value = [makeAgent('a1'), makeAgent('a2')];

		const handler = mockEventHandlers.get('spaceAgent.deleted');
		handler!({ sessionId: 'global', spaceId: 'space-1', agentId: 'a1' });

		expect(spaceStore.agents.value.map((a) => a.id)).toEqual(['a2']);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const handler = mockEventHandlers.get('spaceAgent.created');
		handler!({ sessionId: 'global', spaceId: 'space-99', agent: makeAgent('a1') });

		expect(spaceStore.agents.value.length).toBe(0);
	});
});

describe('SpaceStore — spaceWorkflow events', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('appends new workflow on created event', async () => {
		await spaceStore.selectSpace('space-1');
		const wf = makeWorkflow('wf1');

		const handler = mockEventHandlers.get('spaceWorkflow.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', workflow: wf });

		expect(spaceStore.workflows.value).toContainEqual(wf);
	});

	it('replaces workflow on updated event', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.workflows.value = [{ ...makeWorkflow('wf1'), name: 'Old' }];

		const updated = { ...makeWorkflow('wf1'), name: 'New' };
		const handler = mockEventHandlers.get('spaceWorkflow.updated');
		handler!({ sessionId: 'global', spaceId: 'space-1', workflow: updated });

		expect(spaceStore.workflows.value[0].name).toBe('New');
	});

	it('removes workflow on deleted event', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.workflows.value = [makeWorkflow('wf1'), makeWorkflow('wf2')];

		const handler = mockEventHandlers.get('spaceWorkflow.deleted');
		handler!({ sessionId: 'global', spaceId: 'space-1', workflowId: 'wf1' });

		expect(spaceStore.workflows.value.map((w) => w.id)).toEqual(['wf2']);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const handler = mockEventHandlers.get('spaceWorkflow.deleted');
		spaceStore.workflows.value = [makeWorkflow('wf1')];

		handler!({ sessionId: 'global', spaceId: 'space-99', workflowId: 'wf1' });

		expect(spaceStore.workflows.value.length).toBe(1);
	});
});

describe('SpaceStore — computed signals', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('activeTasks filters in_progress tasks', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [
			makeTask('t1', 'pending'),
			makeTask('t2', 'in_progress'),
			makeTask('t3', 'in_progress'),
			makeTask('t4', 'completed'),
		];

		expect(spaceStore.activeTasks.value.map((t) => t.id)).toEqual(['t2', 't3']);
	});

	it('activeRuns filters pending and in_progress runs', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.workflowRuns.value = [
			makeRun('r1', 'pending'),
			makeRun('r2', 'in_progress'),
			makeRun('r3', 'completed'),
			makeRun('r4', 'cancelled'),
		];

		const activeIds = spaceStore.activeRuns.value.map((r) => r.id);
		expect(activeIds).toEqual(['r1', 'r2']);
	});

	it('tasksByRun groups tasks by workflowRunId', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [
			makeTask('t1', 'pending', 'run-1'),
			makeTask('t2', 'pending', 'run-1'),
			makeTask('t3', 'pending', 'run-2'),
			makeTask('t4', 'pending'), // no run
		];

		const byRun = spaceStore.tasksByRun.value;
		expect(byRun.get('run-1')?.map((t) => t.id)).toEqual(['t1', 't2']);
		expect(byRun.get('run-2')?.map((t) => t.id)).toEqual(['t3']);
		expect(byRun.has('undefined')).toBe(false);
	});

	it('standaloneTasks returns tasks without a workflowRunId', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [
			makeTask('t1', 'pending', 'run-1'),
			makeTask('t2', 'pending'),
			makeTask('t3', 'pending'),
		];

		expect(spaceStore.standaloneTasks.value.map((t) => t.id)).toEqual(['t2', 't3']);
	});

	it('computed signals update reactively', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1', 'pending')];
		expect(spaceStore.activeTasks.value.length).toBe(0);

		spaceStore.tasks.value = [makeTask('t1', 'in_progress')];
		expect(spaceStore.activeTasks.value.length).toBe(1);
	});
});

describe('SpaceStore — task visibility after real-time events', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('task.created event makes the task immediately visible in tasks signal', async () => {
		await spaceStore.selectSpace('space-1');
		expect(spaceStore.tasks.value).toEqual([]);

		const task = makeTask('t-new', 'open');
		const handler = mockEventHandlers.get('space.task.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 't-new', task });

		expect(spaceStore.tasks.value).toHaveLength(1);
		expect(spaceStore.tasks.value[0].id).toBe('t-new');
	});

	it('task.created event updates computed activeTasks when task is in_progress', async () => {
		await spaceStore.selectSpace('space-1');

		const task = makeTask('t-active', 'in_progress');
		const handler = mockEventHandlers.get('space.task.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 't-active', task });

		expect(spaceStore.activeTasks.value).toHaveLength(1);
		expect(spaceStore.activeTasks.value[0].id).toBe('t-active');
	});

	it('task.updated event updates computed activeTasks reactively', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1', 'open')];
		expect(spaceStore.activeTasks.value).toHaveLength(0);

		const updated = makeTask('t1', 'in_progress');
		const handler = mockEventHandlers.get('space.task.updated');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 't1', task: updated });

		expect(spaceStore.activeTasks.value).toHaveLength(1);
		expect(spaceStore.activeTasks.value[0].status).toBe('in_progress');
	});

	it('task.created with workflowRunId updates tasksByRun computed', async () => {
		await spaceStore.selectSpace('space-1');

		const task = makeTask('t-wf', 'open', 'run-1');
		const handler = mockEventHandlers.get('space.task.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 't-wf', task });

		expect(spaceStore.tasksByRun.value.get('run-1')).toHaveLength(1);
		expect(spaceStore.standaloneTasks.value).toHaveLength(0);
	});

	it('task.created without workflowRunId updates standaloneTasks computed', async () => {
		await spaceStore.selectSpace('space-1');

		const task = makeTask('t-solo', 'open');
		const handler = mockEventHandlers.get('space.task.created');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 't-solo', task });

		expect(spaceStore.standaloneTasks.value).toHaveLength(1);
		expect(spaceStore.standaloneTasks.value[0].id).toBe('t-solo');
	});

	it('multiple rapid task.created events accumulate correctly', async () => {
		await spaceStore.selectSpace('space-1');
		const handler = mockEventHandlers.get('space.task.created');

		handler!({
			sessionId: 'global',
			spaceId: 'space-1',
			taskId: 't1',
			task: makeTask('t1', 'open'),
		});
		handler!({
			sessionId: 'global',
			spaceId: 'space-1',
			taskId: 't2',
			task: makeTask('t2', 'in_progress'),
		});
		handler!({
			sessionId: 'global',
			spaceId: 'space-1',
			taskId: 't3',
			task: makeTask('t3', 'blocked'),
		});

		expect(spaceStore.tasks.value).toHaveLength(3);
		expect(spaceStore.activeTasks.value).toHaveLength(1);
	});

	it('task status transition from in_progress to done removes from activeTasks', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1', 'in_progress')];
		expect(spaceStore.activeTasks.value).toHaveLength(1);

		const updated = makeTask('t1', 'done');
		const handler = mockEventHandlers.get('space.task.updated');
		handler!({ sessionId: 'global', spaceId: 'space-1', taskId: 't1', task: updated });

		expect(spaceStore.activeTasks.value).toHaveLength(0);
		expect(spaceStore.tasks.value[0].status).toBe('done');
	});
});

describe('SpaceStore — CRUD methods', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('updateSpace calls space.update RPC and applies direct response', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.updateSpace({ name: 'New Name' });

		expect(mockHub.request).toHaveBeenCalledWith('space.update', {
			id: 'space-1',
			name: 'New Name',
		});
		// space signal updated from the direct Space response
		expect(spaceStore.space.value?.id).toBe('space-1');
	});

	it('archiveSpace calls space.archive RPC and clears selection', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.archiveSpace();

		expect(mockHub.request).toHaveBeenCalledWith('space.archive', { id: 'space-1' });
		expect(spaceStore.spaceId.value).toBeNull();
	});

	it('deleteSpace calls space.delete RPC and clears selection', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.deleteSpace();

		expect(mockHub.request).toHaveBeenCalledWith('space.delete', { id: 'space-1' });
		expect(spaceStore.spaceId.value).toBeNull();
	});

	it('createTask calls spaceTask.create RPC and returns SpaceTask', async () => {
		await spaceStore.selectSpace('space-1');
		const task = await spaceStore.createTask({ title: 'New Task', description: 'desc' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceTask.create', {
			spaceId: 'space-1',
			title: 'New Task',
			description: 'desc',
		});
		// Returns SpaceTask directly (daemon response is not wrapped)
		expect(task.id).toBe('new-task');
	});

	it('updateTask calls spaceTask.update RPC with taskId (not id)', async () => {
		await spaceStore.selectSpace('space-1');
		const task = await spaceStore.updateTask('t1', { status: 'in_progress' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceTask.update', {
			taskId: 't1',
			spaceId: 'space-1',
			status: 'in_progress',
		});
		expect(task.status).toBe('in_progress');
	});

	it('subscribeTaskActivity subscribes to LiveQuery and applies snapshots', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.subscribeTaskActivity('t1');
		const rows = makeTaskActivityRows('t1');

		expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
			queryName: 'spaceTaskActivity.byTask',
			params: ['t1'],
			subscriptionId: 'spaceTaskActivity-t1',
		});
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'spaceTaskActivity-t1',
			rows,
			version: 1,
		});
		expect(spaceStore.taskActivity.value.get('t1')).toEqual(rows);
	});

	it('subscribeTaskActivity applies deltas and unsubscribeTaskActivity tears down the subscription', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.subscribeTaskActivity('t1');
		const rows = makeTaskActivityRows('t1');
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'spaceTaskActivity-t1',
			rows,
			version: 1,
		});

		const updatedRow = { ...rows[0], state: 'waiting_for_input' as const };
		fireMockEvent('liveQuery.delta', {
			subscriptionId: 'spaceTaskActivity-t1',
			updated: [updatedRow],
			version: 2,
		});
		expect(spaceStore.taskActivity.value.get('t1')).toEqual([updatedRow]);

		spaceStore.unsubscribeTaskActivity();
		expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
			subscriptionId: 'spaceTaskActivity-t1',
		});
	});

	it('createAgent calls spaceAgent.create RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.createAgent({ name: 'Coder' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.create', {
			spaceId: 'space-1',
			name: 'Coder',
		});
	});

	it('updateAgent calls spaceAgent.update RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.updateAgent('a1', { name: 'Renamed' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.update', {
			id: 'a1',
			spaceId: 'space-1',
			name: 'Renamed',
		});
	});

	it('deleteAgent calls spaceAgent.delete RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.deleteAgent('a1');

		expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.delete', {
			id: 'a1',
			spaceId: 'space-1',
		});
	});

	it('createWorkflow calls spaceWorkflow.create RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.createWorkflow({ name: 'My Workflow' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.create', {
			spaceId: 'space-1',
			name: 'My Workflow',
		});
	});

	it('updateWorkflow calls spaceWorkflow.update RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.updateWorkflow('wf1', { name: 'Renamed' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.update', {
			id: 'wf1',
			spaceId: 'space-1',
			name: 'Renamed',
		});
	});

	it('deleteWorkflow calls spaceWorkflow.delete RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.deleteWorkflow('wf1');

		expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.delete', {
			id: 'wf1',
			spaceId: 'space-1',
		});
	});

	it('throws when calling CRUD methods with no space selected', async () => {
		await spaceStore.clearSpace();

		await expect(spaceStore.createTask({ title: 'T', description: 'D' })).rejects.toThrow(
			'No space selected'
		);
		await expect(spaceStore.archiveSpace()).rejects.toThrow('No space selected');
		await expect(spaceStore.deleteSpace()).rejects.toThrow('No space selected');
		await expect(spaceStore.createAgent({ name: 'A' })).rejects.toThrow('No space selected');
		await expect(spaceStore.createWorkflow({ name: 'W' })).rejects.toThrow('No space selected');
	});

	it('pauseSpace calls space.pause RPC and updates space + runtimeState', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.pauseSpace();

		expect(mockHub.request).toHaveBeenCalledWith('space.pause', { id: 'space-1' });
		expect(spaceStore.space.value?.paused).toBe(true);
		expect(spaceStore.runtimeState.value).toBe('paused');
	});

	it('resumeSpace calls space.resume RPC and updates space + runtimeState', async () => {
		await spaceStore.selectSpace('space-1');
		// First pause, then resume
		await spaceStore.pauseSpace();
		expect(spaceStore.runtimeState.value).toBe('paused');

		await spaceStore.resumeSpace();

		expect(mockHub.request).toHaveBeenCalledWith('space.resume', { id: 'space-1' });
		expect(spaceStore.space.value?.paused).toBe(false);
		expect(spaceStore.runtimeState.value).toBe('running');
	});

	it('pauseSpace throws when no space selected', async () => {
		await spaceStore.clearSpace();
		await expect(spaceStore.pauseSpace()).rejects.toThrow('No space selected');
	});

	it('resumeSpace throws when no space selected', async () => {
		await spaceStore.clearSpace();
		await expect(spaceStore.resumeSpace()).rejects.toThrow('No space selected');
	});
});

describe('SpaceStore — runtimeState', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('runtimeState is "running" for active non-paused space', async () => {
		await spaceStore.selectSpace('space-1');
		// makeSpace() returns status: 'active', no paused field → running
		expect(spaceStore.runtimeState.value).toBe('running');
	});

	it('runtimeState is "stopped" for archived space', async () => {
		mockHub.request.mockImplementation(async (method: string) => {
			if (method === 'space.overview') {
				return {
					space: { ...makeSpace(), status: 'archived' },
					tasks: [],
					workflowRuns: [],
					sessions: [],
				};
			}
			return {};
		});

		await spaceStore.selectSpace('space-1');
		expect(spaceStore.runtimeState.value).toBe('stopped');
	});

	it('runtimeState is "paused" for paused space', async () => {
		mockHub.request.mockImplementation(async (method: string) => {
			if (method === 'space.overview') {
				return {
					space: { ...makeSpace(), paused: true },
					tasks: [],
					workflowRuns: [],
					sessions: [],
				};
			}
			return {};
		});

		await spaceStore.selectSpace('space-1');
		expect(spaceStore.runtimeState.value).toBe('paused');
	});

	it('runtimeState is null when no space is selected', async () => {
		await spaceStore.clearSpace();
		expect(spaceStore.runtimeState.value).toBeNull();
	});

	it('space.updated event with paused: true updates runtimeState to paused', async () => {
		await spaceStore.selectSpace('space-1');
		expect(spaceStore.runtimeState.value).toBe('running');

		fireMockEvent('space.updated', {
			spaceId: 'space-1',
			space: { paused: true },
		});

		expect(spaceStore.runtimeState.value).toBe('paused');
		expect(spaceStore.space.value?.paused).toBe(true);
	});

	it('space.updated event with paused: false updates runtimeState to running', async () => {
		await spaceStore.selectSpace('space-1');
		// Set to paused first
		fireMockEvent('space.updated', {
			spaceId: 'space-1',
			space: { paused: true },
		});
		expect(spaceStore.runtimeState.value).toBe('paused');

		// Now resume via event
		fireMockEvent('space.updated', {
			spaceId: 'space-1',
			space: { paused: false },
		});

		expect(spaceStore.runtimeState.value).toBe('running');
	});
});

// -------------------------------------------------------
// Helper to access/reset private globalListInitialized flag
// -------------------------------------------------------

type SpaceStorePrivate = {
	globalListInitialized: boolean;
	globalListCleanupFns: Array<() => void>;
};

function resetGlobalListState() {
	const priv = spaceStore as unknown as SpaceStorePrivate;
	priv.globalListInitialized = false;
	priv.globalListCleanupFns = [];
	spaceStore.spaces.value = [];
}

describe('SpaceStore — initGlobalList', () => {
	beforeEach(async () => {
		await resetStore();
		resetGlobalListState();
	});
	afterEach(() => vi.clearAllMocks());

	it('fetches space list and populates spaces signal', async () => {
		await spaceStore.initGlobalList();

		expect(mockHub.request).toHaveBeenCalledWith('space.listWithTasks', {});
		expect(spaceStore.spaces.value).toHaveLength(2);
		expect(spaceStore.spaces.value[0].id).toBe('s1');
		expect(spaceStore.spaces.value[1].id).toBe('s2');
	});

	it('is idempotent — second call skips fetch', async () => {
		await spaceStore.initGlobalList();
		const callCount = mockHub.request.mock.calls.length;

		await spaceStore.initGlobalList();

		// No additional request calls on the second invocation
		expect(mockHub.request.mock.calls.length).toBe(callCount);
	});

	it('adds new space on space.created when not already in list', async () => {
		await spaceStore.initGlobalList();
		const newSpace = makeSpace('new-s');

		mockEventHandlers.get('space.created')?.({ spaceId: 'new-s', space: newSpace });

		expect(spaceStore.spaces.value.some((s) => s.id === 'new-s')).toBe(true);
		expect(spaceStore.spaces.value).toHaveLength(3);
	});

	it('does not add duplicate on space.created if already in list', async () => {
		await spaceStore.initGlobalList();
		const count = spaceStore.spaces.value.length;

		mockEventHandlers.get('space.created')?.({ spaceId: 's1', space: makeSpace('s1') });

		expect(spaceStore.spaces.value).toHaveLength(count);
	});

	it('updates matching space on space.updated', async () => {
		await spaceStore.initGlobalList();

		mockEventHandlers.get('space.updated')?.({ spaceId: 's1', space: { name: 'Renamed' } });

		expect(spaceStore.spaces.value.find((s) => s.id === 's1')?.name).toBe('Renamed');
		// Other spaces unaffected
		expect(spaceStore.spaces.value.find((s) => s.id === 's2')?.name).toBe('Test Space');
	});

	it('replaces matching space on space.archived', async () => {
		await spaceStore.initGlobalList();
		const archived = { ...makeSpace('s1'), status: 'archived' } as Space;

		mockEventHandlers.get('space.archived')?.({ spaceId: 's1', space: archived });

		expect(spaceStore.spaces.value.find((s) => s.id === 's1')?.status).toBe('archived');
		expect(spaceStore.spaces.value).toHaveLength(2);
	});

	it('removes matching space on space.deleted', async () => {
		await spaceStore.initGlobalList();
		expect(spaceStore.spaces.value.some((s) => s.id === 's1')).toBe(true);

		mockEventHandlers.get('space.deleted')?.({ spaceId: 's1' });

		expect(spaceStore.spaces.value.some((s) => s.id === 's1')).toBe(false);
		expect(spaceStore.spaces.value).toHaveLength(1);
	});

	it('removes stale handlers before re-registering on reconnect re-init', async () => {
		// Initial registration
		await spaceStore.initGlobalList();
		expect(spaceStore.spaces.value).toHaveLength(2);

		// Simulate refresh(): reset flag (stale handlers still on hub)
		const priv = spaceStore as unknown as SpaceStorePrivate;
		priv.globalListInitialized = false;

		// Re-init: must call cleanup fns before re-registering
		await spaceStore.initGlobalList();

		// Fire space.created once — should produce exactly one new entry (not two)
		fireMockEvent('space.created', { spaceId: 'new-s', space: makeSpace('new-s') });
		expect(spaceStore.spaces.value.filter((s) => s.id === 'new-s')).toHaveLength(1);
	});

	it('resets globalListInitialized flag on failure so retry works', async () => {
		mockHub.request.mockRejectedValueOnce(new Error('Network error'));
		await spaceStore.initGlobalList();

		const priv = spaceStore as unknown as SpaceStorePrivate;
		expect(priv.globalListInitialized).toBe(false);

		// Retry should succeed and set flag to true
		await spaceStore.initGlobalList();
		expect(priv.globalListInitialized).toBe(true);
		expect(spaceStore.spaces.value).toHaveLength(2);
	});
});

describe('SpaceStore — refresh', () => {
	beforeEach(async () => {
		await resetStore();
		resetGlobalListState();
	});
	afterEach(() => vi.clearAllMocks());

	it('re-initializes global list on reconnect when previously initialized', async () => {
		await spaceStore.initGlobalList();
		mockHub.request.mockClear();

		await spaceStore.refresh();

		// refresh() fire-and-forgets initGlobalList() via .catch(). The assertion passes
		// because all mocks resolve synchronously (vi.fn async), so the microtask queue
		// drains within the same await tick as refresh() itself.
		expect(mockHub.request).toHaveBeenCalledWith('space.listWithTasks', {});
	});

	it('does not re-init global list when never initialized', async () => {
		// globalListInitialized is false — never called initGlobalList
		await spaceStore.refresh();

		expect(mockHub.request).not.toHaveBeenCalledWith('space.listWithTasks', expect.anything());
	});

	it('re-fetches space overview when a space is selected', async () => {
		await spaceStore.selectSpace('space-1');
		mockHub.request.mockClear();

		await spaceStore.refresh();

		// 'space-1' is not a UUID, so the store sends it as a slug
		expect(mockHub.request).toHaveBeenCalledWith('space.overview', { slug: 'space-1' });
	});

	it('is a no-op for space state when no space is selected', async () => {
		await spaceStore.refresh();

		expect(mockHub.request).not.toHaveBeenCalledWith('space.overview', expect.anything());
	});
});

// -------------------------------------------------------
// Helper: create NodeExecution fixtures
// -------------------------------------------------------

function makeNodeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
	return {
		id: overrides.id ?? 'exec-1',
		workflowRunId: overrides.workflowRunId ?? 'run-1',
		workflowNodeId: overrides.workflowNodeId ?? 'node-1',
		agentName: overrides.agentName ?? 'coder',
		agentId: overrides.agentId ?? 'agent-1',
		agentSessionId: overrides.agentSessionId ?? null,
		status: overrides.status ?? ('pending' as NodeExecution['status']),
		result: overrides.result ?? null,
		data: overrides.data ?? null,
		createdAt: overrides.createdAt ?? Date.now(),
		startedAt: overrides.startedAt ?? null,
		completedAt: overrides.completedAt ?? null,
		updatedAt: overrides.updatedAt ?? Date.now(),
	};
}

describe('SpaceStore — node execution LiveQuery subscriptions', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('subscribes to LiveQuery when workflowRun.created fires', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		const run = makeRun('run-1');
		handler({ spaceId: 'space-1', runId: run.id, run, sessionId: 's1' });

		expect(spaceStore.workflowRuns.value).toContainEqual(run);
		expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
			queryName: 'nodeExecutions.byRun',
			params: ['run-1'],
			subscriptionId: 'nodeExecutions-byRun-run-1',
		});
	});

	it('does not subscribe to LiveQuery if spaceId does not match', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		const run = makeRun('run-2');
		handler({ spaceId: 'space-other', runId: run.id, run, sessionId: 's1' });

		expect(spaceStore.workflowRuns.value).not.toContainEqual(run);
		expect(mockHub.request).not.toHaveBeenCalledWith(
			'liveQuery.subscribe',
			expect.objectContaining({ params: ['run-2'] })
		);
	});

	it('applies LiveQuery snapshot to nodeExecutions signal', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		const run = makeRun('run-1');
		handler({ spaceId: 'space-1', runId: run.id, run, sessionId: 's1' });

		const exec1 = makeNodeExecution({
			id: 'exec-1',
			workflowRunId: 'run-1',
			workflowNodeId: 'node-a',
		});
		const exec2 = makeNodeExecution({
			id: 'exec-2',
			workflowRunId: 'run-1',
			workflowNodeId: 'node-b',
		});
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			rows: [exec1, exec2],
			version: 1,
		});

		expect(spaceStore.nodeExecutions.value).toEqual([exec1, exec2]);
	});

	it('applies LiveQuery delta (add/update/remove) to nodeExecutions signal', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		const run = makeRun('run-1');
		handler({ spaceId: 'space-1', runId: run.id, run, sessionId: 's1' });

		const exec1 = makeNodeExecution({ id: 'exec-1', status: 'pending' });
		const exec2 = makeNodeExecution({ id: 'exec-2', status: 'pending' });
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			rows: [exec1, exec2],
			version: 1,
		});

		const exec1Updated = { ...exec1, status: 'done' as const, result: 'All good' };
		const exec3 = makeNodeExecution({ id: 'exec-3', workflowNodeId: 'node-c' });
		fireMockEvent('liveQuery.delta', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			updated: [exec1Updated],
			removed: [exec2],
			added: [exec3],
			version: 2,
		});

		expect(spaceStore.nodeExecutions.value).toHaveLength(2);
		expect(spaceStore.nodeExecutions.value).toContainEqual(exec1Updated);
		expect(spaceStore.nodeExecutions.value).toContainEqual(exec3);
		expect(spaceStore.nodeExecutions.value).not.toContainEqual(exec2);
	});

	it('replaces snapshot data for a specific run without affecting other runs', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		handler({ spaceId: 'space-1', runId: 'run-1', run: makeRun('run-1'), sessionId: 's1' });
		handler({ spaceId: 'space-1', runId: 'run-2', run: makeRun('run-2'), sessionId: 's1' });

		const exec1 = makeNodeExecution({ id: 'exec-1', workflowRunId: 'run-1' });
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			rows: [exec1],
			version: 1,
		});

		const exec2 = makeNodeExecution({ id: 'exec-2', workflowRunId: 'run-2' });
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-2',
			rows: [exec2],
			version: 1,
		});

		expect(spaceStore.nodeExecutions.value).toHaveLength(2);

		const exec1New = makeNodeExecution({ id: 'exec-1-new', workflowRunId: 'run-1' });
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			rows: [exec1New],
			version: 2,
		});

		expect(spaceStore.nodeExecutions.value).toHaveLength(2);
		expect(spaceStore.nodeExecutions.value).toContainEqual(exec1New);
		expect(spaceStore.nodeExecutions.value).toContainEqual(exec2);
	});

	it('handles empty snapshot (clears executions for that run)', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		handler({ spaceId: 'space-1', runId: 'run-1', run: makeRun('run-1'), sessionId: 's1' });

		const exec1 = makeNodeExecution({ id: 'exec-1', workflowRunId: 'run-1' });
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			rows: [exec1],
			version: 1,
		});
		expect(spaceStore.nodeExecutions.value).toHaveLength(1);

		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			rows: [],
			version: 2,
		});
		expect(spaceStore.nodeExecutions.value).toHaveLength(0);
	});

	it('computes nodeExecutionsByNodeId correctly', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		handler({ spaceId: 'space-1', runId: 'run-1', run: makeRun('run-1'), sessionId: 's1' });

		const exec1 = makeNodeExecution({
			id: 'exec-1',
			workflowRunId: 'run-1',
			workflowNodeId: 'node-a',
		});
		const exec2 = makeNodeExecution({
			id: 'exec-2',
			workflowRunId: 'run-1',
			workflowNodeId: 'node-a',
		});
		const exec3 = makeNodeExecution({
			id: 'exec-3',
			workflowRunId: 'run-1',
			workflowNodeId: 'node-b',
		});
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			rows: [exec1, exec2, exec3],
			version: 1,
		});

		const byNode = spaceStore.nodeExecutionsByNodeId.value;
		expect(byNode.get('node-a')).toEqual([exec1, exec2]);
		expect(byNode.get('node-b')).toEqual([exec3]);
		expect(byNode.get('node-nonexistent')).toBeUndefined();
	});

	it('ignores snapshot events for wrong subscriptionId', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		handler({ spaceId: 'space-1', runId: 'run-1', run: makeRun('run-1'), sessionId: 's1' });

		const exec1 = makeNodeExecution({ id: 'exec-1' });
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'wrong-subscription-id',
			rows: [exec1],
			version: 1,
		});

		expect(spaceStore.nodeExecutions.value).toHaveLength(0);
	});

	it('clears nodeExecutions on space switch', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		handler({ spaceId: 'space-1', runId: 'run-1', run: makeRun('run-1'), sessionId: 's1' });

		const exec1 = makeNodeExecution({ id: 'exec-1' });
		fireMockEvent('liveQuery.snapshot', {
			subscriptionId: 'nodeExecutions-byRun-run-1',
			rows: [exec1],
			version: 1,
		});
		expect(spaceStore.nodeExecutions.value).toHaveLength(1);

		// Override mock for space-2
		mockHub.request.mockImplementation(async (method: string) => {
			if (method === 'space.overview')
				return { space: makeSpace('space-2'), tasks: [], workflowRuns: [], sessions: [] };
			if (method === 'spaceAgent.list') return { agents: [] };
			if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
			if (method === 'spaceWorkflow.list') return { workflows: [] };
			if (method === 'nodeExecution.list') return { executions: [] };
			return {};
		});
		await spaceStore.selectSpace('space-2');

		expect(spaceStore.nodeExecutions.value).toHaveLength(0);
	});

	it('does not duplicate subscription when workflowRun.created fires twice for same run', async () => {
		await spaceStore.selectSpace('space-1');

		const handler = mockEventHandlers.get('space.workflowRun.created')!;
		const run = makeRun('run-1');

		handler({ spaceId: 'space-1', runId: run.id, run, sessionId: 's1' });
		handler({ spaceId: 'space-1', runId: run.id, run, sessionId: 's1' });

		const subscribeCalls = mockHub.request.mock.calls.filter(
			(c: unknown[]) =>
				c[0] === 'liveQuery.subscribe' &&
				(c[1] as Record<string, unknown>)?.queryName === 'nodeExecutions.byRun'
		);
		expect(subscribeCalls).toHaveLength(1);
	});
});
