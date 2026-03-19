// @ts-nocheck
/**
 * Unit tests for SpaceStore
 *
 * Covers:
 * - Space selection and clearSpace
 * - Promise-chain lock (race condition prevention)
 * - State clearing on space switch
 * - Event subscriptions: tasks, workflowRuns, agents, workflows
 * - Auto-cleanup on space switch
 * - Computed signals: activeTasks, activeRuns, tasksByRun, standaloneTask
 * - CRUD methods call correct RPC endpoints
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// -------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works
// -------------------------------------------------------

let mockEventHandlers: Map<string, (event: unknown) => void>;
let mockHub: ReturnType<typeof makeMockHub>;

function makeSpace(id = 'space-1') {
	return {
		id,
		name: 'Test Space',
		workspacePath: '/workspace',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active' as const,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeTask(id: string, status = 'pending', workflowRunId?: string) {
	return {
		id,
		spaceId: 'space-1',
		title: `Task ${id}`,
		description: '',
		status,
		priority: 'normal' as const,
		dependsOn: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...(workflowRunId ? { workflowRunId } : {}),
	};
}

function makeRun(id: string, status = 'pending') {
	return {
		id,
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: `Run ${id}`,
		currentStepIndex: 0,
		status,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeAgent(id: string) {
	return {
		id,
		spaceId: 'space-1',
		name: `Agent ${id}`,
		role: 'coder',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeWorkflow(id: string) {
	return {
		id,
		spaceId: 'space-1',
		name: `Workflow ${id}`,
		steps: [],
		rules: [],
		tags: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function makeMockHub() {
	return {
		joinChannel: vi.fn(),
		leaveChannel: vi.fn(),
		onEvent: vi.fn((eventName: string, handler: (e: unknown) => void) => {
			mockEventHandlers.set(eventName, handler);
			return () => mockEventHandlers.delete(eventName);
		}),
		request: vi.fn(async (method: string, _params?: unknown) => {
			if (method === 'space.overview') {
				return {
					space: makeSpace(),
					tasks: [],
					workflowRuns: [],
					sessions: [],
				};
			}
			if (method === 'spaceAgent.list') return { agents: [] };
			if (method === 'spaceWorkflow.list') return { workflows: [] };
			if (method === 'space.update') return { space: makeSpace() };
			if (method === 'spaceTask.create') return { task: makeTask('new-task') };
			if (method === 'spaceTask.update') return { task: makeTask('t1', 'in_progress') };
			if (method === 'spaceWorkflowRun.create') return { run: makeRun('new-run') };
			if (method === 'spaceAgent.create') return { agent: makeAgent('new-agent') };
			if (method === 'spaceAgent.update') return { agent: makeAgent('a1') };
			if (method === 'spaceWorkflow.create') return { workflow: makeWorkflow('new-wf') };
			if (method === 'spaceWorkflow.update') return { workflow: makeWorkflow('wf1') };
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
		expect(mockHub.request).toHaveBeenCalledWith('space.overview', { id: 'space-1' });
		expect(spaceStore.space.value?.id).toBe('space-1');
	});

	it('fetches agents and workflows on selectSpace()', async () => {
		await spaceStore.selectSpace('space-1');
		expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.list', { spaceId: 'space-1' });
		expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.list', { spaceId: 'space-1' });
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
		// (space-2 overview returns empty tasks, so tasks should be empty)
		expect(spaceStore.tasks.value).toEqual([]);
		expect(spaceStore.spaceId.value).toBe('space-2');
	});
});

describe('SpaceStore — event subscriptions auto-cleanup', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('registers event handlers on selectSpace()', async () => {
		await spaceStore.selectSpace('space-1');

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

		// Switch to space-2; old handlers should be removed and new ones added
		await spaceStore.selectSpace('space-2');
		// Handlers should still exist but now filter for space-2
		expect(mockEventHandlers.size).toBeGreaterThan(0);
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
		handler({ sessionId: 'global', spaceId: 'space-1', taskId: 'new-t', task });

		expect(spaceStore.tasks.value).toContainEqual(task);
	});

	it('does not append duplicate tasks', async () => {
		await spaceStore.selectSpace('space-1');
		const task = makeTask('dup');
		spaceStore.tasks.value = [task];

		const handler = mockEventHandlers.get('space.task.created');
		handler({ sessionId: 'global', spaceId: 'space-1', taskId: 'dup', task });

		expect(spaceStore.tasks.value.length).toBe(1);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const task = makeTask('other');

		const handler = mockEventHandlers.get('space.task.created');
		handler({ sessionId: 'global', spaceId: 'space-99', taskId: 'other', task });

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
		handler({ sessionId: 'global', spaceId: 'space-1', taskId: 't1', task: updated });

		expect(spaceStore.tasks.value[0].status).toBe('in_progress');
	});

	it('appends task if not yet in list', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [];

		const task = makeTask('t2', 'in_progress');
		const handler = mockEventHandlers.get('space.task.updated');
		handler({ sessionId: 'global', spaceId: 'space-1', taskId: 't2', task });

		expect(spaceStore.tasks.value).toContainEqual(task);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1', 'pending')];

		const updated = makeTask('t1', 'in_progress');
		const handler = mockEventHandlers.get('space.task.updated');
		handler({ sessionId: 'global', spaceId: 'space-99', taskId: 't1', task: updated });

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
		handler({ sessionId: 'global', spaceId: 'space-1', runId: 'run-1', run });

		expect(spaceStore.workflowRuns.value).toContainEqual(run);
	});

	it('does not append duplicate runs', async () => {
		await spaceStore.selectSpace('space-1');
		const run = makeRun('run-dup');
		spaceStore.workflowRuns.value = [run];

		const handler = mockEventHandlers.get('space.workflowRun.created');
		handler({ sessionId: 'global', spaceId: 'space-1', runId: 'run-dup', run });

		expect(spaceStore.workflowRuns.value.length).toBe(1);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const run = makeRun('run-other');

		const handler = mockEventHandlers.get('space.workflowRun.created');
		handler({ sessionId: 'global', spaceId: 'space-99', runId: 'run-other', run });

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
		handler({
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
		handler({ sessionId: 'global', spaceId: 'space-1', runId: 'run-1' });

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
		handler({ sessionId: 'global', spaceId: 'space-1', agent });

		expect(spaceStore.agents.value).toContainEqual(agent);
	});

	it('replaces agent on updated event', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.agents.value = [{ ...makeAgent('a1'), name: 'Old Name' }];

		const updated = { ...makeAgent('a1'), name: 'New Name' };
		const handler = mockEventHandlers.get('spaceAgent.updated');
		handler({ sessionId: 'global', spaceId: 'space-1', agent: updated });

		expect(spaceStore.agents.value[0].name).toBe('New Name');
	});

	it('removes agent on deleted event', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.agents.value = [makeAgent('a1'), makeAgent('a2')];

		const handler = mockEventHandlers.get('spaceAgent.deleted');
		handler({ sessionId: 'global', spaceId: 'space-1', agentId: 'a1' });

		expect(spaceStore.agents.value.map((a) => a.id)).toEqual(['a2']);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const handler = mockEventHandlers.get('spaceAgent.created');
		handler({ sessionId: 'global', spaceId: 'space-99', agent: makeAgent('a1') });

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
		handler({ sessionId: 'global', spaceId: 'space-1', workflow: wf });

		expect(spaceStore.workflows.value).toContainEqual(wf);
	});

	it('replaces workflow on updated event', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.workflows.value = [{ ...makeWorkflow('wf1'), name: 'Old' }];

		const updated = { ...makeWorkflow('wf1'), name: 'New' };
		const handler = mockEventHandlers.get('spaceWorkflow.updated');
		handler({ sessionId: 'global', spaceId: 'space-1', workflow: updated });

		expect(spaceStore.workflows.value[0].name).toBe('New');
	});

	it('removes workflow on deleted event', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.workflows.value = [makeWorkflow('wf1'), makeWorkflow('wf2')];

		const handler = mockEventHandlers.get('spaceWorkflow.deleted');
		handler({ sessionId: 'global', spaceId: 'space-1', workflowId: 'wf1' });

		expect(spaceStore.workflows.value.map((w) => w.id)).toEqual(['wf2']);
	});

	it('ignores events for a different space', async () => {
		await spaceStore.selectSpace('space-1');
		const handler = mockEventHandlers.get('spaceWorkflow.deleted');
		spaceStore.workflows.value = [makeWorkflow('wf1')];

		handler({ sessionId: 'global', spaceId: 'space-99', workflowId: 'wf1' });

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

	it('standaloneTask returns tasks without a workflowRunId', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [
			makeTask('t1', 'pending', 'run-1'),
			makeTask('t2', 'pending'),
			makeTask('t3', 'pending'),
		];

		expect(spaceStore.standaloneTask.value.map((t) => t.id)).toEqual(['t2', 't3']);
	});

	it('computed signals update reactively', async () => {
		await spaceStore.selectSpace('space-1');
		spaceStore.tasks.value = [makeTask('t1', 'pending')];
		expect(spaceStore.activeTasks.value.length).toBe(0);

		spaceStore.tasks.value = [makeTask('t1', 'in_progress')];
		expect(spaceStore.activeTasks.value.length).toBe(1);
	});
});

describe('SpaceStore — CRUD methods', () => {
	beforeEach(resetStore);
	afterEach(() => vi.clearAllMocks());

	it('updateSpace calls space.update RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.updateSpace({ name: 'New Name' });

		expect(mockHub.request).toHaveBeenCalledWith('space.update', {
			id: 'space-1',
			name: 'New Name',
		});
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

	it('createTask calls spaceTask.create RPC with spaceId', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.createTask({ title: 'New Task', description: 'desc' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceTask.create', {
			spaceId: 'space-1',
			title: 'New Task',
			description: 'desc',
		});
	});

	it('updateTask calls spaceTask.update RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.updateTask('t1', { status: 'in_progress' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceTask.update', {
			id: 't1',
			spaceId: 'space-1',
			status: 'in_progress',
		});
	});

	it('startWorkflowRun calls spaceWorkflowRun.create RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.startWorkflowRun({ workflowId: 'wf-1', title: 'Run 1' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflowRun.create', {
			spaceId: 'space-1',
			workflowId: 'wf-1',
			title: 'Run 1',
		});
	});

	it('createAgent calls spaceAgent.create RPC', async () => {
		await spaceStore.selectSpace('space-1');
		await spaceStore.createAgent({ name: 'Coder', role: 'coder' });

		expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.create', {
			spaceId: 'space-1',
			name: 'Coder',
			role: 'coder',
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
		// Ensure no space selected
		await spaceStore.clearSpace();

		await expect(spaceStore.createTask({ title: 'T', description: 'D' })).rejects.toThrow(
			'No space selected'
		);
		await expect(spaceStore.archiveSpace()).rejects.toThrow('No space selected');
		await expect(spaceStore.deleteSpace()).rejects.toThrow('No space selected');
		await expect(spaceStore.createAgent({ name: 'A', role: 'coder' })).rejects.toThrow(
			'No space selected'
		);
		await expect(spaceStore.createWorkflow({ name: 'W' })).rejects.toThrow('No space selected');
	});
});
