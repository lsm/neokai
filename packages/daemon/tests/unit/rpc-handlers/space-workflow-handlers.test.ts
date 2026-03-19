/**
 * Tests for Space Workflow RPC Handlers
 *
 * Covers:
 * - spaceWorkflow.create: happy path, missing spaceId, missing/empty name, space not found,
 *   validation error propagation, event emission (space.workflow.created)
 * - spaceWorkflow.list: happy path, missing spaceId, space not found
 * - spaceWorkflow.get: happy path, missing id, workflow not found, optional spaceId ownership
 * - spaceWorkflow.update: happy path, missing id, workflow not found, validation error,
 *   event emission (space.workflow.updated), optional spaceId ownership
 * - spaceWorkflow.delete: happy path, missing id, workflow not found, event emission
 *   (space.workflow.deleted), optional spaceId ownership
 * - spaceWorkflow.setDefault: throws (unsupported — concept removed)
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { Space, SpaceWorkflow } from '@neokai/shared';
import { setupSpaceWorkflowHandlers } from '../../../src/lib/rpc-handlers/space-workflow-handlers';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager';
import type { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager';
import { WorkflowValidationError } from '../../../src/lib/space/managers/space-workflow-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

type RequestHandler = (data: unknown) => Promise<unknown>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.now();

const mockSpace: Space = {
	id: 'space-1',
	workspacePath: '/tmp/test-workspace',
	name: 'Test Space',
	description: '',
	backgroundContext: '',
	instructions: '',
	sessionIds: [],
	status: 'active',
	createdAt: NOW,
	updatedAt: NOW,
};

const mockWorkflow: SpaceWorkflow = {
	id: 'wf-1',
	spaceId: 'space-1',
	name: 'Test Workflow',
	description: 'A test workflow',
	steps: [
		{
			id: 'step-1',
			name: 'Code',
			agentRefType: 'builtin',
			agentRef: 'coder',
			order: 0,
		},
	],
	rules: [],
	tags: [],
	createdAt: NOW,
	updatedAt: NOW,
};

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
	return {
		getSpace: mock(async () => space),
	} as unknown as SpaceManager;
}

function createMockWorkflowManager(
	workflow: SpaceWorkflow | null = mockWorkflow
): SpaceWorkflowManager {
	return {
		createWorkflow: mock(() => workflow!),
		getWorkflow: mock(() => workflow),
		listWorkflows: mock(() => (workflow ? [workflow] : [])),
		updateWorkflow: mock(() => ({ ...workflow!, name: 'Updated' })),
		deleteWorkflow: mock(() => true),
	} as unknown as SpaceWorkflowManager;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('space-workflow-handlers', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let spaceManager: SpaceManager;
	let workflowManager: SpaceWorkflowManager;

	function setup(space: Space | null = mockSpace, workflow: SpaceWorkflow | null = mockWorkflow) {
		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;
		daemonHub = createMockDaemonHub();
		spaceManager = createMockSpaceManager(space);
		workflowManager = createMockWorkflowManager(workflow);
		setupSpaceWorkflowHandlers(hub, spaceManager, workflowManager, daemonHub);
	}

	const call = (method: string, data: unknown) => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`No handler registered for ${method}`);
		return handler(data);
	};

	// ─── spaceWorkflow.create ──────────────────────────────────────────────────

	describe('spaceWorkflow.create', () => {
		beforeEach(() => setup());

		it('creates a workflow and emits space.workflow.created', async () => {
			const result = (await call('spaceWorkflow.create', {
				spaceId: 'space-1',
				name: 'Test Workflow',
				steps: [{ name: 'Code', agentRefType: 'builtin', agentRef: 'coder' }],
			})) as { workflow: SpaceWorkflow };

			expect(result.workflow).toEqual(mockWorkflow);
			expect(workflowManager.createWorkflow).toHaveBeenCalledTimes(1);
			expect(daemonHub.emit).toHaveBeenCalledWith('space.workflow.created', {
				sessionId: 'global',
				spaceId: 'space-1',
				workflowId: mockWorkflow.id,
				workflow: mockWorkflow,
			});
		});

		it('throws when spaceId is missing', async () => {
			await expect(call('spaceWorkflow.create', { name: 'Wf' })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('throws when name is missing', async () => {
			await expect(call('spaceWorkflow.create', { spaceId: 'space-1' })).rejects.toThrow(
				'name is required'
			);
		});

		it('throws when name is empty string', async () => {
			await expect(
				call('spaceWorkflow.create', { spaceId: 'space-1', name: '   ' })
			).rejects.toThrow('name is required');
		});

		it('throws when space not found', async () => {
			setup(null);
			await expect(call('spaceWorkflow.create', { spaceId: 'ghost', name: 'Wf' })).rejects.toThrow(
				'Space not found: ghost'
			);
			expect(workflowManager.createWorkflow).not.toHaveBeenCalled();
		});

		it('propagates WorkflowValidationError from manager', async () => {
			(workflowManager.createWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
				throw new WorkflowValidationError(
					'A workflow named "Test Workflow" already exists in this space'
				);
			});

			await expect(
				call('spaceWorkflow.create', {
					spaceId: 'space-1',
					name: 'Test Workflow',
					steps: [{ name: 'Code', agentRefType: 'builtin', agentRef: 'coder' }],
				})
			).rejects.toThrow('already exists in this space');
		});

		it('propagates step validation error from manager', async () => {
			(workflowManager.createWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
				throw new WorkflowValidationError('A workflow must have at least one step');
			});

			await expect(
				call('spaceWorkflow.create', {
					spaceId: 'space-1',
					name: 'Empty',
					steps: [],
				})
			).rejects.toThrow('at least one step');
		});
	});

	// ─── spaceWorkflow.list ────────────────────────────────────────────────────

	describe('spaceWorkflow.list', () => {
		beforeEach(() => setup());

		it('lists workflows for a space', async () => {
			const result = (await call('spaceWorkflow.list', { spaceId: 'space-1' })) as {
				workflows: SpaceWorkflow[];
			};
			expect(result.workflows).toEqual([mockWorkflow]);
			expect(workflowManager.listWorkflows).toHaveBeenCalledWith('space-1');
		});

		it('throws when spaceId is missing', async () => {
			await expect(call('spaceWorkflow.list', {})).rejects.toThrow('spaceId is required');
		});

		it('throws when space not found', async () => {
			setup(null);
			await expect(call('spaceWorkflow.list', { spaceId: 'ghost' })).rejects.toThrow(
				'Space not found: ghost'
			);
			expect(workflowManager.listWorkflows).not.toHaveBeenCalled();
		});

		it('returns empty list when space has no workflows', async () => {
			setup(mockSpace, null);
			const result = (await call('spaceWorkflow.list', { spaceId: 'space-1' })) as {
				workflows: SpaceWorkflow[];
			};
			expect(result.workflows).toEqual([]);
		});
	});

	// ─── spaceWorkflow.get ─────────────────────────────────────────────────────

	describe('spaceWorkflow.get', () => {
		beforeEach(() => setup());

		it('returns the workflow when found', async () => {
			const result = (await call('spaceWorkflow.get', { id: 'wf-1' })) as {
				workflow: SpaceWorkflow;
			};
			expect(result.workflow).toEqual(mockWorkflow);
			expect(workflowManager.getWorkflow).toHaveBeenCalledWith('wf-1');
		});

		it('accepts matching optional spaceId', async () => {
			const result = (await call('spaceWorkflow.get', {
				id: 'wf-1',
				spaceId: 'space-1',
			})) as { workflow: SpaceWorkflow };
			expect(result.workflow).toEqual(mockWorkflow);
		});

		it('throws when spaceId does not match workflow owner', async () => {
			await expect(
				call('spaceWorkflow.get', { id: 'wf-1', spaceId: 'space-other' })
			).rejects.toThrow('Workflow not found: wf-1');
		});

		it('throws when id is missing', async () => {
			await expect(call('spaceWorkflow.get', {})).rejects.toThrow('id is required');
		});

		it('throws when workflow not found', async () => {
			setup(mockSpace, null);
			await expect(call('spaceWorkflow.get', { id: 'ghost' })).rejects.toThrow(
				'Workflow not found: ghost'
			);
		});
	});

	// ─── spaceWorkflow.update ──────────────────────────────────────────────────

	describe('spaceWorkflow.update', () => {
		beforeEach(() => setup());

		it('updates a workflow and emits space.workflow.updated', async () => {
			const updated = { ...mockWorkflow, name: 'Updated' };
			(workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(updated);

			const result = (await call('spaceWorkflow.update', {
				id: 'wf-1',
				name: 'Updated',
			})) as { workflow: SpaceWorkflow };

			expect(result.workflow.name).toBe('Updated');
			expect(workflowManager.updateWorkflow).toHaveBeenCalledWith('wf-1', { name: 'Updated' });
			expect(daemonHub.emit).toHaveBeenCalledWith('space.workflow.updated', {
				sessionId: 'global',
				spaceId: updated.spaceId,
				workflowId: 'wf-1',
				workflow: updated,
			});
		});

		it('rejects when optional spaceId does not match workflow owner', async () => {
			await expect(
				call('spaceWorkflow.update', { id: 'wf-1', spaceId: 'space-other', name: 'X' })
			).rejects.toThrow('Workflow not found: wf-1');
			expect(workflowManager.updateWorkflow).not.toHaveBeenCalled();
		});

		it('throws when id is missing', async () => {
			await expect(call('spaceWorkflow.update', { name: 'X' })).rejects.toThrow('id is required');
		});

		it('throws when workflow not found', async () => {
			(workflowManager.updateWorkflow as ReturnType<typeof mock>).mockReturnValue(null);
			await expect(call('spaceWorkflow.update', { id: 'ghost', name: 'X' })).rejects.toThrow(
				'Workflow not found: ghost'
			);
			expect(daemonHub.emit).not.toHaveBeenCalled();
		});

		it('propagates WorkflowValidationError from manager (e.g. duplicate name)', async () => {
			(workflowManager.updateWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
				throw new WorkflowValidationError('A workflow named "Dupe" already exists in this space');
			});

			await expect(call('spaceWorkflow.update', { id: 'wf-1', name: 'Dupe' })).rejects.toThrow(
				'already exists in this space'
			);
		});

		it('propagates step validation error (invalid builtin agentRef)', async () => {
			(workflowManager.updateWorkflow as ReturnType<typeof mock>).mockImplementation(() => {
				throw new WorkflowValidationError('step[0]: invalid builtin agentRef "leader"');
			});

			await expect(
				call('spaceWorkflow.update', {
					id: 'wf-1',
					steps: [
						{ id: 's1', name: 'Lead', agentRefType: 'builtin', agentRef: 'leader', order: 0 },
					],
				})
			).rejects.toThrow('invalid builtin agentRef');
		});
	});

	// ─── spaceWorkflow.delete ──────────────────────────────────────────────────

	describe('spaceWorkflow.delete', () => {
		beforeEach(() => setup());

		it('deletes a workflow and emits space.workflow.deleted', async () => {
			const result = (await call('spaceWorkflow.delete', { id: 'wf-1' })) as { success: boolean };

			expect(result.success).toBe(true);
			expect(workflowManager.deleteWorkflow).toHaveBeenCalledWith('wf-1');
			expect(daemonHub.emit).toHaveBeenCalledWith('space.workflow.deleted', {
				sessionId: 'global',
				spaceId: mockWorkflow.spaceId,
				workflowId: 'wf-1',
			});
		});

		it('rejects when optional spaceId does not match workflow owner', async () => {
			await expect(
				call('spaceWorkflow.delete', { id: 'wf-1', spaceId: 'space-other' })
			).rejects.toThrow('Workflow not found: wf-1');
			expect(workflowManager.deleteWorkflow).not.toHaveBeenCalled();
			expect(daemonHub.emit).not.toHaveBeenCalled();
		});

		it('throws when id is missing', async () => {
			await expect(call('spaceWorkflow.delete', {})).rejects.toThrow('id is required');
		});

		it('throws when workflow not found (getWorkflow returns null)', async () => {
			setup(mockSpace, null);
			await expect(call('spaceWorkflow.delete', { id: 'ghost' })).rejects.toThrow(
				'Workflow not found: ghost'
			);
			expect(workflowManager.deleteWorkflow).not.toHaveBeenCalled();
			expect(daemonHub.emit).not.toHaveBeenCalled();
		});

		it('throws when deleteWorkflow returns false', async () => {
			(workflowManager.deleteWorkflow as ReturnType<typeof mock>).mockReturnValue(false);

			await expect(call('spaceWorkflow.delete', { id: 'wf-1' })).rejects.toThrow(
				'Workflow not found: wf-1'
			);
		});
	});

	// ─── spaceWorkflow.setDefault ──────────────────────────────────────────────

	describe('spaceWorkflow.setDefault', () => {
		beforeEach(() => setup());

		it('throws — default workflow concept is not supported', async () => {
			await expect(
				call('spaceWorkflow.setDefault', { spaceId: 'space-1', workflowId: 'wf-1' })
			).rejects.toThrow('spaceWorkflow.setDefault is not supported');
		});

		it('does not emit any event', async () => {
			await call('spaceWorkflow.setDefault', { spaceId: 'space-1', workflowId: 'wf-1' }).catch(
				() => {}
			);
			expect(daemonHub.emit).not.toHaveBeenCalled();
		});
	});
});
