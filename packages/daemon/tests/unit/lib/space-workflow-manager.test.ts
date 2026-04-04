/**
 * SpaceWorkflowManager Unit Tests
 *
 * Verifies start/end node invariants on create and update operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager';
import { createSpaceAgentSchema, insertSpace } from '../helpers/space-agent-schema';

describe('SpaceWorkflowManager', () => {
	let db: Database;
	let repo: SpaceWorkflowRepository;
	let manager: SpaceWorkflowManager;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceAgentSchema(db);
		insertSpace(db);
		repo = new SpaceWorkflowRepository(db as any);
		manager = new SpaceWorkflowManager(repo, null);
	});

	afterEach(() => {
		db.close();
	});

	describe('start/end node validation on create', () => {
		it('defaults startNodeId and endNodeId to first/last node when omitted', () => {
			const result = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			expect(result.startNodeId).toBe('node-1');
			expect(result.endNodeId).toBe('node-2');
		});

		it('normalizes null start/end inputs to first/last node', () => {
			const result = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				startNodeId: null as unknown as string,
				endNodeId: null as unknown as string,
			});

			expect(result.startNodeId).toBe('node-1');
			expect(result.endNodeId).toBe('node-2');
		});

		it('accepts explicit startNodeId/endNodeId that reference existing nodes', () => {
			const result = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				startNodeId: 'node-2',
				endNodeId: 'node-1',
			});

			expect(result.startNodeId).toBe('node-2');
			expect(result.endNodeId).toBe('node-1');
		});

		it('rejects empty string startNodeId', () => {
			expect(() =>
				manager.createWorkflow({
					spaceId: 'space-1',
					name: 'Test Workflow',
					nodes: [
						{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					],
					startNodeId: '  ',
				})
			).toThrow('startNodeId must be a non-empty string');
		});

		it('rejects empty string endNodeId', () => {
			expect(() =>
				manager.createWorkflow({
					spaceId: 'space-1',
					name: 'Test Workflow',
					nodes: [
						{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					],
					endNodeId: '   ',
				})
			).toThrow('endNodeId must be a non-empty string');
		});

		it('rejects startNodeId that does not match any node', () => {
			expect(() =>
				manager.createWorkflow({
					spaceId: 'space-1',
					name: 'Test Workflow',
					nodes: [
						{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					],
					startNodeId: 'nonexistent-node',
				})
			).toThrow('startNodeId "nonexistent-node" does not match any node in this workflow');
		});

		it('rejects endNodeId that does not match any node', () => {
			expect(() =>
				manager.createWorkflow({
					spaceId: 'space-1',
					name: 'Test Workflow',
					nodes: [
						{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					],
					endNodeId: 'nonexistent-node',
				})
			).toThrow('endNodeId "nonexistent-node" does not match any node in this workflow');
		});
	});

	describe('start/end node validation on update', () => {
		it('keeps startNodeId/endNodeId unchanged when omitted', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				startNodeId: 'node-1',
				endNodeId: 'node-2',
			});

			const updated = manager.updateWorkflow(created.id, {});
			expect(updated?.startNodeId).toBe('node-1');
			expect(updated?.endNodeId).toBe('node-2');
		});

		it('resets startNodeId/endNodeId to first/last node when null is provided', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				startNodeId: 'node-2',
				endNodeId: 'node-1',
			});

			const updated = manager.updateWorkflow(created.id, { startNodeId: null, endNodeId: null });
			expect(updated?.startNodeId).toBe('node-1');
			expect(updated?.endNodeId).toBe('node-2');
		});

		it('accepts valid startNodeId/endNodeId on update (no nodes change)', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			const updated = manager.updateWorkflow(created.id, {
				startNodeId: 'node-2',
				endNodeId: 'node-1',
			});
			expect(updated?.startNodeId).toBe('node-2');
			expect(updated?.endNodeId).toBe('node-1');
		});

		it('rejects startNodeId that does not match any existing node', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			expect(() => manager.updateWorkflow(created.id, { startNodeId: 'nonexistent' })).toThrow(
				'startNodeId "nonexistent" does not match any node in this workflow'
			);
		});

		it('rejects endNodeId that does not match any existing node', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			expect(() => manager.updateWorkflow(created.id, { endNodeId: 'nonexistent' })).toThrow(
				'endNodeId "nonexistent" does not match any node in this workflow'
			);
		});

		it('validates start/end against effective nodes when nodes are replaced', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-old', name: 'Old Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			const updated = manager.updateWorkflow(created.id, {
				nodes: [
					{ id: 'node-new-1', name: 'New Step 1', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-new-2', name: 'New Step 2', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				startNodeId: 'node-new-2',
				endNodeId: 'node-new-1',
			});

			expect(updated?.startNodeId).toBe('node-new-2');
			expect(updated?.endNodeId).toBe('node-new-1');
		});

		it('rejects stale startNodeId/endNodeId when nodes are replaced', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-old', name: 'Old Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			expect(() =>
				manager.updateWorkflow(created.id, {
					nodes: [
						{ id: 'node-new', name: 'New Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					],
					startNodeId: 'node-old',
				})
			).toThrow('startNodeId "node-old" does not match any node in this workflow');

			expect(() =>
				manager.updateWorkflow(created.id, {
					nodes: [
						{ id: 'node-new', name: 'New Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					],
					startNodeId: 'node-new',
					endNodeId: 'node-old',
				})
			).toThrow('endNodeId "node-old" does not match any node in this workflow');
		});

		it('rejects empty string startNodeId/endNodeId on update', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			expect(() => manager.updateWorkflow(created.id, { startNodeId: '  ' })).toThrow(
				'startNodeId must be a non-empty string'
			);
			expect(() => manager.updateWorkflow(created.id, { endNodeId: '  ' })).toThrow(
				'endNodeId must be a non-empty string'
			);
		});
	});
});
