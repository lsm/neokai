/**
 * Proposal Repository Tests
 *
 * Tests for room agent proposal CRUD operations and status management.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ProposalRepository } from '../../../src/storage/repositories/proposal-repository';
import type {
	RoomProposal,
	CreateProposalParams,
	ProposalStatus,
	ProposalType,
	ProposalFilter,
} from '@neokai/shared';

describe('ProposalRepository', () => {
	let db: Database;
	let repository: ProposalRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE proposals (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				type TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				proposed_changes TEXT NOT NULL,
				reasoning TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				acted_by TEXT,
				action_response TEXT,
				created_at INTEGER NOT NULL,
				acted_at INTEGER
			);

			CREATE INDEX idx_proposals_room ON proposals(room_id);
			CREATE INDEX idx_proposals_status ON proposals(status);
		`);
		repository = new ProposalRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createProposal', () => {
		it('should create a proposal with all fields', () => {
			const params: CreateProposalParams = {
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Update configuration file',
				description: 'Add new settings for feature X',
				proposedChanges: { file: 'config.json', changes: ['add key X'] },
				reasoning: 'Feature X requires new configuration',
			};

			const proposal = repository.createProposal(params);

			expect(proposal.id).toBeDefined();
			expect(proposal.roomId).toBe('room-1');
			expect(proposal.sessionId).toBe('session-1');
			expect(proposal.type).toBe('file_change');
			expect(proposal.title).toBe('Update configuration file');
			expect(proposal.description).toBe('Add new settings for feature X');
			expect(proposal.proposedChanges).toEqual({ file: 'config.json', changes: ['add key X'] });
			expect(proposal.reasoning).toBe('Feature X requires new configuration');
		});

		it('should default status to pending', () => {
			const params: CreateProposalParams = {
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'context_update',
				title: 'Test Proposal',
				description: 'Description',
				proposedChanges: {},
				reasoning: 'Test reasoning',
			};

			const proposal = repository.createProposal(params);

			expect(proposal.status).toBe('pending');
		});

		it('should generate unique ID', () => {
			const params: CreateProposalParams = {
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'goal_create',
				title: 'Proposal 1',
				description: 'Description',
				proposedChanges: {},
				reasoning: 'Reasoning',
			};

			const proposal1 = repository.createProposal(params);
			const proposal2 = repository.createProposal(params);

			expect(proposal1.id).toBeDefined();
			expect(proposal2.id).toBeDefined();
			expect(proposal1.id).not.toBe(proposal2.id);
		});

		it('should set createdAt timestamp', () => {
			const beforeTime = Date.now();
			const params: CreateProposalParams = {
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Description',
				proposedChanges: {},
				reasoning: 'Reasoning',
			};

			const proposal = repository.createProposal(params);

			expect(proposal.createdAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should support all proposal types', () => {
			const types: ProposalType[] = ['file_change', 'context_update', 'goal_create'];

			types.forEach((type, index) => {
				const proposal = repository.createProposal({
					roomId: 'room-1',
					sessionId: 'session-1',
					type,
					title: `Proposal ${index}`,
					description: 'Description',
					proposedChanges: {},
					reasoning: 'Reasoning',
				});
				expect(proposal.type).toBe(type);
			});
		});

		it('should store complex proposedChanges as JSON', () => {
			const complexChanges = {
				files: ['file1.ts', 'file2.ts'],
				operations: [
					{ type: 'create', path: '/new/file.ts' },
					{ type: 'modify', path: '/existing/file.ts', diff: '---\n+++' },
				],
				metadata: { author: 'agent', timestamp: Date.now() },
			};

			const params: CreateProposalParams = {
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Complex Proposal',
				description: 'Description',
				proposedChanges: complexChanges,
				reasoning: 'Reasoning',
			};

			const proposal = repository.createProposal(params);

			expect(proposal.proposedChanges).toEqual(complexChanges);
		});
	});

	describe('getProposal', () => {
		it('should return proposal by ID', () => {
			const created = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Description',
				proposedChanges: {},
				reasoning: 'Reasoning',
			});

			const proposal = repository.getProposal(created.id);

			expect(proposal).not.toBeNull();
			expect(proposal?.id).toBe(created.id);
			expect(proposal?.title).toBe('Test Proposal');
		});

		it('should return null for non-existent ID', () => {
			const proposal = repository.getProposal('non-existent-id');

			expect(proposal).toBeNull();
		});
	});

	describe('listProposals', () => {
		it('should list all proposals for a room', () => {
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Proposal 1',
				description: 'Desc 1',
				proposedChanges: {},
				reasoning: 'Reason 1',
			});
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-2',
				type: 'context_update',
				title: 'Proposal 2',
				description: 'Desc 2',
				proposedChanges: {},
				reasoning: 'Reason 2',
			});
			repository.createProposal({
				roomId: 'room-2',
				sessionId: 'session-3',
				type: 'file_change',
				title: 'Proposal 3',
				description: 'Desc 3',
				proposedChanges: {},
				reasoning: 'Reason 3',
			});

			const proposals = repository.listProposals('room-1');

			expect(proposals.length).toBe(2);
			expect(proposals.map((p) => p.title)).toContain('Proposal 1');
			expect(proposals.map((p) => p.title)).toContain('Proposal 2');
		});

		it('should filter by status', () => {
			const proposal1 = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Pending 1',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			const proposal2 = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Pending 2',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			repository.approveProposal(proposal1.id, 'user-1', 'Looks good');

			const filter: ProposalFilter = { status: 'pending' };
			const pendingProposals = repository.listProposals('room-1', filter);

			expect(pendingProposals.length).toBe(1);
			expect(pendingProposals[0].id).toBe(proposal2.id);
		});

		it('should filter by type', () => {
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'File Change',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'context_update',
				title: 'Context Update',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const filter: ProposalFilter = { type: 'file_change' };
			const fileProposals = repository.listProposals('room-1', filter);

			expect(fileProposals.length).toBe(1);
			expect(fileProposals[0].type).toBe('file_change');
		});

		it('should filter by sessionId', () => {
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Proposal 1',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-2',
				type: 'file_change',
				title: 'Proposal 2',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const filter: ProposalFilter = { sessionId: 'session-1' };
			const proposals = repository.listProposals('room-1', filter);

			expect(proposals.length).toBe(1);
			expect(proposals[0].sessionId).toBe('session-1');
		});

		it('should combine multiple filters', () => {
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Proposal 1',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-2',
				type: 'file_change',
				title: 'Proposal 2',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const filter: ProposalFilter = {
				status: 'pending',
				type: 'file_change',
				sessionId: 'session-1',
			};
			const proposals = repository.listProposals('room-1', filter);

			expect(proposals.length).toBe(1);
			expect(proposals[0].title).toBe('Proposal 1');
		});

		it('should return empty array if no proposals', () => {
			const proposals = repository.listProposals('room-with-no-proposals');

			expect(proposals).toEqual([]);
		});

		it('should return proposals ordered by created_at DESC', async () => {
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Oldest',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			await new Promise((r) => setTimeout(r, 5));
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Middle',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			await new Promise((r) => setTimeout(r, 5));
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Newest',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const proposals = repository.listProposals('room-1');

			expect(proposals[0].title).toBe('Newest');
			expect(proposals[1].title).toBe('Middle');
			expect(proposals[2].title).toBe('Oldest');
		});
	});

	describe('approveProposal', () => {
		it('should update status to approved', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const approved = repository.approveProposal(proposal.id, 'user-1');

			expect(approved).not.toBeNull();
			expect(approved?.status).toBe('approved');
		});

		it('should record acted_by and action_response', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const approved = repository.approveProposal(proposal.id, 'user-1', 'Looks good to me');

			expect(approved?.actedBy).toBe('user-1');
			expect(approved?.actionResponse).toBe('Looks good to me');
		});

		it('should set acted_at timestamp', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			const beforeTime = Date.now();

			const approved = repository.approveProposal(proposal.id, 'user-1');

			expect(approved?.actedAt).toBeDefined();
			expect(approved?.actedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should return null if proposal not pending', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			// First approval succeeds
			repository.approveProposal(proposal.id, 'user-1');

			// Second approval should fail
			const result = repository.approveProposal(proposal.id, 'user-2');

			expect(result).toBeNull();
		});

		it('should return null for non-existent proposal', () => {
			const result = repository.approveProposal('non-existent', 'user-1');

			expect(result).toBeNull();
		});

		it('should work without optional response', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const approved = repository.approveProposal(proposal.id, 'user-1');

			expect(approved?.status).toBe('approved');
			expect(approved?.actionResponse).toBeUndefined();
		});
	});

	describe('rejectProposal', () => {
		it('should update status to rejected', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const rejected = repository.rejectProposal(proposal.id, 'user-1', 'Not needed');

			expect(rejected).not.toBeNull();
			expect(rejected?.status).toBe('rejected');
		});

		it('should require rejection reason', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const rejected = repository.rejectProposal(proposal.id, 'user-1', 'This is the reason');

			expect(rejected?.actedBy).toBe('user-1');
			expect(rejected?.actionResponse).toBe('This is the reason');
		});

		it('should set acted_at timestamp', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			const beforeTime = Date.now();

			const rejected = repository.rejectProposal(proposal.id, 'user-1', 'Reason');

			expect(rejected?.actedAt).toBeDefined();
			expect(rejected?.actedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should return null if proposal not pending', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			repository.approveProposal(proposal.id, 'user-1');
			const result = repository.rejectProposal(proposal.id, 'user-1', 'Too late');

			expect(result).toBeNull();
		});

		it('should return null for non-existent proposal', () => {
			const result = repository.rejectProposal('non-existent', 'user-1', 'Reason');

			expect(result).toBeNull();
		});
	});

	describe('withdrawProposal', () => {
		it('should update status to withdrawn', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const withdrawn = repository.withdrawProposal(proposal.id);

			expect(withdrawn).not.toBeNull();
			expect(withdrawn?.status).toBe('withdrawn');
		});

		it('should only work for pending proposals', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			repository.approveProposal(proposal.id, 'user-1');
			const result = repository.withdrawProposal(proposal.id);

			expect(result).toBeNull();
		});

		it('should return null for non-existent proposal', () => {
			const result = repository.withdrawProposal('non-existent');

			expect(result).toBeNull();
		});

		it('should not set acted_at or acted_by', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			const withdrawn = repository.withdrawProposal(proposal.id);

			expect(withdrawn?.status).toBe('withdrawn');
			expect(withdrawn?.actedBy).toBeUndefined();
			expect(withdrawn?.actedAt).toBeUndefined();
		});
	});

	describe('applyProposal', () => {
		it('should update status to applied', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			repository.approveProposal(proposal.id, 'user-1');
			const applied = repository.applyProposal(proposal.id);

			expect(applied).not.toBeNull();
			expect(applied?.status).toBe('applied');
		});

		it('should only work for approved proposals', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			// Try to apply without approving
			const result = repository.applyProposal(proposal.id);

			expect(result).toBeNull();
		});

		it('should return null for non-existent proposal', () => {
			const result = repository.applyProposal('non-existent');

			expect(result).toBeNull();
		});

		it('should not work for rejected proposals', () => {
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Test Proposal',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			repository.rejectProposal(proposal.id, 'user-1', 'Not good');
			const result = repository.applyProposal(proposal.id);

			expect(result).toBeNull();
		});
	});

	describe('getPendingProposals', () => {
		it('should return only pending proposals', () => {
			const proposal1 = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Pending 1',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			const proposal2 = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Pending 2',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			const proposal3 = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'To Approve',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			repository.approveProposal(proposal3.id, 'user-1');

			const pending = repository.getPendingProposals('room-1');

			expect(pending.length).toBe(2);
			expect(pending.map((p) => p.id)).toContain(proposal1.id);
			expect(pending.map((p) => p.id)).toContain(proposal2.id);
			expect(pending.map((p) => p.id)).not.toContain(proposal3.id);
		});

		it('should return empty array if no pending proposals', () => {
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'To Approve',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			repository.approveProposal(repository.listProposals('room-1')[0].id, 'user-1');

			const pending = repository.getPendingProposals('room-1');

			expect(pending).toEqual([]);
		});
	});

	describe('deleteProposalsForRoom', () => {
		it('should delete all proposals for a room', () => {
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Proposal 1',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Proposal 2',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});
			repository.createProposal({
				roomId: 'room-2',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Proposal 3',
				description: 'Desc',
				proposedChanges: {},
				reasoning: 'Reason',
			});

			repository.deleteProposalsForRoom('room-1');

			expect(repository.listProposals('room-1')).toEqual([]);
			expect(repository.listProposals('room-2').length).toBe(1);
		});

		it('should not throw when deleting for non-existent room', () => {
			expect(() => repository.deleteProposalsForRoom('non-existent')).not.toThrow();
		});
	});

	describe('proposal lifecycle', () => {
		it('should support full approval lifecycle', async () => {
			// Create proposal
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'file_change',
				title: 'Feature Implementation',
				description: 'Implement new feature',
				proposedChanges: { files: ['feature.ts'] },
				reasoning: 'User requested this feature',
			});
			expect(proposal.status).toBe('pending');

			// Approve proposal
			await new Promise((r) => setTimeout(r, 5));
			const approved = repository.approveProposal(proposal.id, 'user-1', 'Looks good');
			expect(approved?.status).toBe('approved');
			expect(approved?.actedBy).toBe('user-1');
			expect(approved?.actionResponse).toBe('Looks good');
			expect(approved?.actedAt).toBeGreaterThan(proposal.createdAt);

			// Apply proposal
			const applied = repository.applyProposal(proposal.id);
			expect(applied?.status).toBe('applied');
		});

		it('should support rejection lifecycle', async () => {
			// Create proposal
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'context_update',
				title: 'Update context',
				description: 'Add new context',
				proposedChanges: { context: 'new data' },
				reasoning: 'Context is outdated',
			});
			expect(proposal.status).toBe('pending');

			// Reject proposal
			await new Promise((r) => setTimeout(r, 5));
			const rejected = repository.rejectProposal(
				proposal.id,
				'user-1',
				'Context is still relevant'
			);
			expect(rejected?.status).toBe('rejected');
			expect(rejected?.actedBy).toBe('user-1');
			expect(rejected?.actionResponse).toBe('Context is still relevant');
			expect(rejected?.actedAt).toBeGreaterThan(proposal.createdAt);

			// Cannot apply rejected proposal
			const applied = repository.applyProposal(proposal.id);
			expect(applied).toBeNull();
		});

		it('should support withdrawal lifecycle', () => {
			// Create proposal
			const proposal = repository.createProposal({
				roomId: 'room-1',
				sessionId: 'session-1',
				type: 'goal_create',
				title: 'Create goal',
				description: 'New goal proposal',
				proposedChanges: { goal: 'New feature' },
				reasoning: 'User wants this',
			});
			expect(proposal.status).toBe('pending');

			// Withdraw proposal
			const withdrawn = repository.withdrawProposal(proposal.id);
			expect(withdrawn?.status).toBe('withdrawn');

			// Cannot approve withdrawn proposal
			const approved = repository.approveProposal(proposal.id, 'user-1');
			expect(approved).toBeNull();
		});
	});
});
