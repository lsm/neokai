/**
 * SpaceWorkflowManager Unit Tests
 *
 * Tests for endNodeId validation on create and update operations.
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

	describe('endNodeId validation on create', () => {
		it('accepts null endNodeId (no end node constraint)', () => {
			const result = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				endNodeId: null,
			});
			// SpaceWorkflow type uses optional string — null in DB maps to undefined
			expect(result.endNodeId).toBeUndefined();
		});

		it('accepts undefined endNodeId (defaults to no end node)', () => {
			const result = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});
			expect(result.endNodeId).toBeUndefined();
		});

		it('accepts valid endNodeId referencing an existing node', () => {
			const result = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				endNodeId: 'node-2',
			});
			expect(result.endNodeId).toBe('node-2');
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
			).toThrow('endNodeId must be a non-empty string or null');
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

	describe('endNodeId validation on update', () => {
		it('accepts null endNodeId to remove end node constraint', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				endNodeId: 'node-2',
			});
			expect(created.endNodeId).toBe('node-2');

			const updated = manager.updateWorkflow(created.id, { endNodeId: null });
			// null clears the end node — stored as NULL in DB, returned as undefined
			expect(updated?.endNodeId).toBeUndefined();
		});

		it('accepts undefined endNodeId (no change)', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				endNodeId: 'node-2',
			});

			const updated = manager.updateWorkflow(created.id, {});
			expect(updated?.endNodeId).toBe('node-2');
		});

		it('accepts valid endNodeId referencing existing node on update (no nodes change)', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			// Update only endNodeId, not nodes — should validate against existing nodes
			const updated = manager.updateWorkflow(created.id, { endNodeId: 'node-1' });
			expect(updated?.endNodeId).toBe('node-1');
		});

		it('rejects endNodeId that does not match any existing node on update (no nodes change)', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			// Update only endNodeId, not nodes — should validate against existing nodes
			expect(() => manager.updateWorkflow(created.id, { endNodeId: 'nonexistent' })).toThrow(
				'endNodeId "nonexistent" does not match any node in this workflow'
			);
		});

		it('accepts valid endNodeId referencing existing node on update (no nodes change)', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			const updated = manager.updateWorkflow(created.id, { endNodeId: 'node-1' });
			expect(updated?.endNodeId).toBe('node-1');
		});

		it('validates endNodeId against effective nodes when updating nodes and endNodeId together', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			// endNodeId 'node-2' references a node in the NEW nodes list
			const updated = manager.updateWorkflow(created.id, {
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				endNodeId: 'node-2',
			});
			expect(updated?.endNodeId).toBe('node-2');
		});

		it('rejects endNodeId referencing old node when nodes are replaced', () => {
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
					endNodeId: 'node-old',
				})
			).toThrow('endNodeId "node-old" does not match any node in this workflow');
		});

		it('rejects empty string endNodeId on update', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
			});

			expect(() => manager.updateWorkflow(created.id, { endNodeId: '  ' })).toThrow(
				'endNodeId must be a non-empty string or null'
			);
		});
	});
});
