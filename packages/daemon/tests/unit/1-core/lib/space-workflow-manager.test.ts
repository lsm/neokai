/**
 * SpaceWorkflowManager Unit Tests
 *
 * Verifies start/end node invariants on create and update operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import { createSpaceAgentSchema, insertSpace } from '../../helpers/space-agent-schema';

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
				completionAutonomyLevel: 3,
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
				completionAutonomyLevel: 3,
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
				completionAutonomyLevel: 3,
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
					completionAutonomyLevel: 3,
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
					completionAutonomyLevel: 3,
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
					completionAutonomyLevel: 3,
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
					completionAutonomyLevel: 3,
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
				completionAutonomyLevel: 3,
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
				completionAutonomyLevel: 3,
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
				completionAutonomyLevel: 3,
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
				completionAutonomyLevel: 3,
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
				completionAutonomyLevel: 3,
			});

			expect(() => manager.updateWorkflow(created.id, { endNodeId: 'nonexistent' })).toThrow(
				'endNodeId "nonexistent" does not match any node in this workflow'
			);
		});

		it('validates start/end against effective nodes when stable nodes are updated', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Old Step 1', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Old Step 2', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				completionAutonomyLevel: 3,
			});

			const updated = manager.updateWorkflow(created.id, {
				nodes: [
					{ id: 'node-1', name: 'New Step 1', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'New Step 2', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				startNodeId: 'node-2',
				endNodeId: 'node-1',
			});

			expect(updated?.startNodeId).toBe('node-2');
			expect(updated?.endNodeId).toBe('node-1');
		});

		it('updates stable nodes in place without changing row IDs', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Stable Update Workflow',
				nodes: [
					{ id: 'node-1', name: 'Old Step 1', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Old Step 2', agents: [{ agentId: 'agent-2', name: 'reviewer' }] },
				],
				completionAutonomyLevel: 3,
			});
			const createdNodeRows = db
				.prepare(
					`SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
				)
				.all(created.id) as Array<{ id: string; rowid: number }>;

			const updated = manager.updateWorkflow(created.id, {
				nodes: [
					{ id: 'node-1', name: 'New Step 1', agents: [{ agentId: 'agent-3', name: 'coder' }] },
					{ id: 'node-2', name: 'New Step 2', agents: [{ agentId: 'agent-4', name: 'reviewer' }] },
				],
			});
			const updatedNodeRows = db
				.prepare(
					`SELECT id, rowid FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`
				)
				.all(created.id) as Array<{ id: string; rowid: number }>;

			expect(updated?.nodes.map((node) => node.id)).toEqual(['node-1', 'node-2']);
			expect(updated?.nodes.map((node) => node.name)).toEqual(['New Step 1', 'New Step 2']);
			expect(updatedNodeRows).toEqual(createdNodeRows);
		});

		it('rejects attempts to add, remove, duplicate, regenerate, or omit node IDs on update', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-old', name: 'Old Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-other', name: 'Other Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				completionAutonomyLevel: 3,
			});

			expect(() =>
				manager.updateWorkflow(created.id, {
					nodes: [
						{ id: 'node-new', name: 'New Step', agents: [{ agentId: 'agent-1', name: 'coder' }] },
						{
							id: 'node-other',
							name: 'Other Step',
							agents: [{ agentId: 'agent-1', name: 'coder' }],
						},
					],
					startNodeId: 'node-new',
				})
			).toThrow(
				'Workflow node IDs are stable and cannot be added, removed, regenerated, or omitted during update'
			);

			expect(() =>
				manager.updateWorkflow(created.id, {
					nodes: [
						{
							id: 'node-old',
							name: 'Duplicate 1',
							agents: [{ agentId: 'agent-1', name: 'coder' }],
						},
						{
							id: 'node-old',
							name: 'Duplicate 2',
							agents: [{ agentId: 'agent-1', name: 'coder' }],
						},
					],
				})
			).toThrow(
				'Workflow node IDs are stable and cannot be added, removed, regenerated, or omitted during update'
			);

			expect(() =>
				manager.updateWorkflow(created.id, {
					nodes: [{ name: 'Missing ID', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
				})
			).toThrow(
				'Workflow node IDs are stable and cannot be added, removed, regenerated, or omitted during update'
			);
		});

		it('rejects empty string startNodeId/endNodeId on update', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Test Workflow',
				nodes: [
					{ id: 'node-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					{ id: 'node-2', name: 'Step Two', agents: [{ agentId: 'agent-1', name: 'coder' }] },
				],
				completionAutonomyLevel: 3,
			});

			expect(() => manager.updateWorkflow(created.id, { startNodeId: '  ' })).toThrow(
				'startNodeId must be a non-empty string'
			);
			expect(() => manager.updateWorkflow(created.id, { endNodeId: '  ' })).toThrow(
				'endNodeId must be a non-empty string'
			);
		});
	});

	describe('postApproval validation', () => {
		it('accepts a postApproval route targeting "task-agent" on create', () => {
			const wf = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'WF',
				nodes: [{ id: 'node-1', name: 'Step', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
				completionAutonomyLevel: 3,
				postApproval: { targetAgent: 'task-agent', instructions: 'merge {{pr_url}}' },
			});
			expect(wf.postApproval).toEqual({
				targetAgent: 'task-agent',
				instructions: 'merge {{pr_url}}',
			});
		});

		it('accepts a postApproval route targeting a node agent name', () => {
			const wf = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'WF',
				nodes: [{ id: 'node-1', name: 'Coding', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
				completionAutonomyLevel: 3,
				postApproval: { targetAgent: 'coder', instructions: '' },
			});
			expect(wf.postApproval?.targetAgent).toBe('coder');
		});

		it('rejects a postApproval route whose target does not resolve', () => {
			expect(() =>
				manager.createWorkflow({
					spaceId: 'space-1',
					name: 'WF',
					nodes: [
						{ id: 'node-1', name: 'Coding', agents: [{ agentId: 'agent-1', name: 'coder' }] },
					],
					completionAutonomyLevel: 3,
					postApproval: { targetAgent: 'ghost', instructions: '' },
				})
			).toThrow('"ghost"');
		});

		it('re-validates an existing postApproval route when stable nodes are updated', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'WF',
				nodes: [
					{
						id: 'node-1',
						name: 'Coding',
						agents: [{ agentId: 'agent-1', name: 'reviewer' }],
					},
				],
				completionAutonomyLevel: 3,
				postApproval: { targetAgent: 'reviewer', instructions: '' },
			});

			// Update the stable node so `reviewer` is no longer a declared agent.
			expect(() =>
				manager.updateWorkflow(created.id, {
					nodes: [
						{
							id: 'node-1',
							name: 'Coding',
							agents: [{ agentId: 'agent-2', name: 'coder' }],
						},
					],
				})
			).toThrow('existing postApproval route is no longer valid');
		});

		it('allows clearing the postApproval route with null', () => {
			const created = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'WF',
				nodes: [{ id: 'node-1', name: 'Coding', agents: [{ agentId: 'agent-1', name: 'coder' }] }],
				completionAutonomyLevel: 3,
				postApproval: { targetAgent: 'task-agent', instructions: 'hi' },
			});
			expect(created.postApproval).toBeDefined();

			const cleared = manager.updateWorkflow(created.id, { postApproval: null });
			expect(cleared?.postApproval).toBeUndefined();
		});

		it('strips a stale postApproval route on read instead of failing', () => {
			// Persist a route that is valid at create time, then corrupt the DB
			// to simulate a post-hoc node rename that was never re-validated.
			const wf = manager.createWorkflow({
				spaceId: 'space-1',
				name: 'WF',
				nodes: [
					{
						id: 'node-1',
						name: 'Coding',
						agents: [{ agentId: 'agent-1', name: 'reviewer' }],
					},
				],
				completionAutonomyLevel: 3,
				postApproval: { targetAgent: 'reviewer', instructions: '' },
			});

			// Rename the node agent directly in the config JSON to make the
			// saved route stale. Manager.getWorkflow should sanitise on read.
			const staleCfg = JSON.stringify({
				agents: [{ agentId: 'agent-1', name: 'coder' }],
			});
			db.prepare(`UPDATE space_workflow_nodes SET config = ? WHERE workflow_id = ?`).run(
				staleCfg,
				wf.id
			);

			const fetched = manager.getWorkflow(wf.id);
			expect(fetched).not.toBeNull();
			expect(fetched?.postApproval).toBeUndefined();
		});
	});
});
