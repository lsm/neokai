/**
 * Tests for Proposal RPC Handlers
 *
 * Tests the RPC handlers for proposal operations:
 * - proposal.create - Create a proposal (agent only)
 * - proposal.get - Get proposal details
 * - proposal.list - List proposals in room
 * - proposal.approve - Approve a proposal (human)
 * - proposal.reject - Reject a proposal (human)
 * - proposal.withdraw - Withdraw a proposal (agent)
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	MessageHub,
	type RoomProposal,
	type ProposalStatus,
	type ProposalType,
} from '@neokai/shared';
import { setupProposalHandlers } from '../../../src/lib/rpc-handlers/proposal-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../src/lib/room/room-manager';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Helper to create a minimal mock MessageHub that captures handlers
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

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emit: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emit: emitMock };
}

// Helper to create mock RoomManager
function createMockRoomManager(): {
	roomManager: RoomManager;
	getRoom: ReturnType<typeof mock>;
} {
	const getRoomMock = mock(() => ({ id: 'room-123', name: 'Test Room' }));

	const roomManager = {
		createRoom: mock(() => ({ id: 'room-123' })),
		listRooms: mock(() => []),
		getRoom: getRoomMock,
		getRoomOverview: mock(() => ({
			room: { id: 'room-123', name: 'Test Room' },
			sessions: [],
			activeTasks: [],
		})),
		updateRoom: mock(() => null),
		archiveRoom: mock(() => null),
		getRoomStatus: mock(() => null),
		assignSession: mock(() => null),
		unassignSession: mock(() => null),
		addAllowedPath: mock(() => null),
		removeAllowedPath: mock(() => null),
	} as unknown as RoomManager;

	return { roomManager, getRoom: getRoomMock };
}

// Helper to create in-memory database with proposals table
function createTestDatabase(): {
	db: { getDatabase: () => Database };
	rawDb: Database;
} {
	const rawDb = new Database(':memory:');
	rawDb.exec(`
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

	const db = {
		getDatabase: () => rawDb,
	};

	return { db, rawDb };
}

describe('ProposalHandlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let roomManagerData: ReturnType<typeof createMockRoomManager>;
	let dbData: ReturnType<typeof createTestDatabase>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		roomManagerData = createMockRoomManager();
		dbData = createTestDatabase();

		// Setup handlers
		setupProposalHandlers(
			messageHubData.hub,
			roomManagerData.roomManager,
			daemonHubData.daemonHub,
			dbData.db as any
		);
	});

	afterEach(() => {
		dbData.rawDb.close();
		mock.restore();
	});

	describe('proposal.create', () => {
		it('should create a proposal', async () => {
			const handler = messageHubData.handlers.get('proposal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				sessionId: 'session-456',
				type: 'file_change' as ProposalType,
				title: 'Update config file',
				description: 'Add new settings',
				proposedChanges: { file: 'config.json', changes: ['add key'] },
				reasoning: 'Feature requires new config',
			};

			const result = (await handler!(params, {})) as { proposal: RoomProposal };

			expect(result.proposal).toBeDefined();
			expect(result.proposal.roomId).toBe('room-123');
			expect(result.proposal.sessionId).toBe('session-456');
			expect(result.proposal.type).toBe('file_change');
			expect(result.proposal.title).toBe('Update config file');
			expect(result.proposal.status).toBe('pending');
		});

		it('should emit proposal.created event', async () => {
			const handler = messageHubData.handlers.get('proposal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				sessionId: 'session-456',
				type: 'file_change' as ProposalType,
				title: 'Test Proposal',
				description: 'Description',
				proposedChanges: {},
				reasoning: 'Reasoning',
			};

			await handler!(params, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'proposal.created',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					proposalId: expect.any(String),
					proposal: expect.objectContaining({
						roomId: 'room-123',
						title: 'Test Proposal',
					}),
				})
			);
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('proposal.create');
			expect(handler).toBeDefined();

			const params = {
				sessionId: 'session-456',
				type: 'file_change' as ProposalType,
				title: 'Test',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('should require sessionId', async () => {
			const handler = messageHubData.handlers.get('proposal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				type: 'file_change' as ProposalType,
				title: 'Test',
			};

			await expect(handler!(params, {})).rejects.toThrow('Session ID is required');
		});

		it('should require title', async () => {
			const handler = messageHubData.handlers.get('proposal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				sessionId: 'session-456',
				type: 'file_change' as ProposalType,
			};

			await expect(handler!(params, {})).rejects.toThrow('Proposal title is required');
		});

		it('should throw error if room not found', async () => {
			roomManagerData.getRoom.mockReturnValueOnce(null);

			const handler = messageHubData.handlers.get('proposal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'non-existent-room',
				sessionId: 'session-456',
				type: 'file_change' as ProposalType,
				title: 'Test',
			};

			await expect(handler!(params, {})).rejects.toThrow('Room not found: non-existent-room');
		});

		it('should create proposal with minimal params', async () => {
			const handler = messageHubData.handlers.get('proposal.create');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				sessionId: 'session-456',
				type: 'file_change' as ProposalType,
				title: 'Minimal Proposal',
			};

			const result = (await handler!(params, {})) as { proposal: RoomProposal };

			expect(result.proposal).toBeDefined();
			expect(result.proposal.description).toBe('');
			expect(result.proposal.proposedChanges).toEqual({});
			expect(result.proposal.reasoning).toBe('');
		});
	});

	describe('proposal.get', () => {
		it('should return proposal by ID', async () => {
			// First create a proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
					description: 'Description',
					proposedChanges: {},
					reasoning: 'Reasoning',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.get');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				proposalId: createResult.proposal.id,
			};

			const result = (await handler!(params, {})) as { proposal: RoomProposal };

			expect(result.proposal).toBeDefined();
			expect(result.proposal.id).toBe(createResult.proposal.id);
			expect(result.proposal.title).toBe('Test Proposal');
		});

		it('should throw error if proposal not found', async () => {
			const handler = messageHubData.handlers.get('proposal.get');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				proposalId: 'non-existent',
			};

			await expect(handler!(params, {})).rejects.toThrow('Proposal not found: non-existent');
		});

		it('should throw error if proposal belongs to different room', async () => {
			// Create proposal in room-123
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
					description: '',
					proposedChanges: {},
					reasoning: '',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.get');
			expect(handler).toBeDefined();

			// Try to get from different room
			const params = {
				roomId: 'room-456',
				proposalId: createResult.proposal.id,
			};

			await expect(handler!(params, {})).rejects.toThrow(
				'Proposal not found in room: ' + createResult.proposal.id
			);
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('proposal.get');
			expect(handler).toBeDefined();

			await expect(handler!({ proposalId: 'some-id' }, {})).rejects.toThrow('Room ID is required');
		});

		it('should require proposalId', async () => {
			const handler = messageHubData.handlers.get('proposal.get');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Proposal ID is required');
		});
	});

	describe('proposal.list', () => {
		it('should list proposals with filters', async () => {
			const createHandler = messageHubData.handlers.get('proposal.create');

			// Create multiple proposals
			await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-1',
					type: 'file_change' as ProposalType,
					title: 'Proposal 1',
				},
				{}
			);
			await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-2',
					type: 'context_update' as ProposalType,
					title: 'Proposal 2',
				},
				{}
			);

			const handler = messageHubData.handlers.get('proposal.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { proposals: RoomProposal[] };

			expect(result.proposals).toHaveLength(2);
		});

		it('should filter by status', async () => {
			const createHandler = messageHubData.handlers.get('proposal.create');

			// Create proposals
			const created1 = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-1',
					type: 'file_change' as ProposalType,
					title: 'Proposal 1',
				},
				{}
			)) as { proposal: RoomProposal };
			await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-1',
					type: 'file_change' as ProposalType,
					title: 'Proposal 2',
				},
				{}
			);

			// Approve one
			const approveHandler = messageHubData.handlers.get('proposal.approve');
			await approveHandler!(
				{
					roomId: 'room-123',
					proposalId: created1.proposal.id,
					actedBy: 'user-1',
				},
				{}
			);

			const handler = messageHubData.handlers.get('proposal.list');
			const params = {
				roomId: 'room-123',
				status: 'pending' as ProposalStatus,
			};

			const result = (await handler!(params, {})) as { proposals: RoomProposal[] };

			expect(result.proposals).toHaveLength(1);
			expect(result.proposals[0].status).toBe('pending');
		});

		it('should filter by type', async () => {
			const createHandler = messageHubData.handlers.get('proposal.create');

			await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-1',
					type: 'file_change' as ProposalType,
					title: 'File Change',
				},
				{}
			);
			await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-1',
					type: 'context_update' as ProposalType,
					title: 'Context Update',
				},
				{}
			);

			const handler = messageHubData.handlers.get('proposal.list');
			const params = {
				roomId: 'room-123',
				type: 'file_change' as ProposalType,
			};

			const result = (await handler!(params, {})) as { proposals: RoomProposal[] };

			expect(result.proposals).toHaveLength(1);
			expect(result.proposals[0].type).toBe('file_change');
		});

		it('should filter by sessionId', async () => {
			const createHandler = messageHubData.handlers.get('proposal.create');

			await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-1',
					type: 'file_change' as ProposalType,
					title: 'Proposal 1',
				},
				{}
			);
			await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-2',
					type: 'file_change' as ProposalType,
					title: 'Proposal 2',
				},
				{}
			);

			const handler = messageHubData.handlers.get('proposal.list');
			const params = {
				roomId: 'room-123',
				sessionId: 'session-1',
			};

			const result = (await handler!(params, {})) as { proposals: RoomProposal[] };

			expect(result.proposals).toHaveLength(1);
			expect(result.proposals[0].sessionId).toBe('session-1');
		});

		it('should return empty array if no proposals', async () => {
			const handler = messageHubData.handlers.get('proposal.list');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
			};

			const result = (await handler!(params, {})) as { proposals: RoomProposal[] };

			expect(result.proposals).toEqual([]);
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('proposal.list');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('proposal.approve', () => {
		it('should approve a proposal', async () => {
			// Create proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.approve');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				proposalId: createResult.proposal.id,
				actedBy: 'user-1',
				response: 'Looks good!',
			};

			const result = (await handler!(params, {})) as { proposal: RoomProposal };

			expect(result.proposal.status).toBe('approved');
			expect(result.proposal.actedBy).toBe('user-1');
			expect(result.proposal.actionResponse).toBe('Looks good!');
		});

		it('should emit proposal.approved event', async () => {
			// Create proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.approve');
			expect(handler).toBeDefined();

			await handler!(
				{
					roomId: 'room-123',
					proposalId: createResult.proposal.id,
					actedBy: 'user-1',
				},
				{}
			);

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'proposal.approved',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					proposalId: createResult.proposal.id,
					proposal: expect.objectContaining({
						status: 'approved',
					}),
				})
			);
		});

		it('should throw error if proposal not pending', async () => {
			// Create and approve proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const approveHandler = messageHubData.handlers.get('proposal.approve');
			await approveHandler!(
				{
					roomId: 'room-123',
					proposalId: createResult.proposal.id,
					actedBy: 'user-1',
				},
				{}
			);

			// Try to approve again
			await expect(
				approveHandler!(
					{
						roomId: 'room-123',
						proposalId: createResult.proposal.id,
						actedBy: 'user-2',
					},
					{}
				)
			).rejects.toThrow('Proposal is not pending: approved');
		});

		it('should require actedBy', async () => {
			// Create proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.approve');
			expect(handler).toBeDefined();

			await expect(
				handler!(
					{
						roomId: 'room-123',
						proposalId: createResult.proposal.id,
					},
					{}
				)
			).rejects.toThrow('actedBy is required');
		});
	});

	describe('proposal.reject', () => {
		it('should reject a proposal', async () => {
			// Create proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.reject');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				proposalId: createResult.proposal.id,
				actedBy: 'user-1',
				response: 'Not needed anymore',
			};

			const result = (await handler!(params, {})) as { proposal: RoomProposal };

			expect(result.proposal.status).toBe('rejected');
			expect(result.proposal.actedBy).toBe('user-1');
			expect(result.proposal.actionResponse).toBe('Not needed anymore');
		});

		it('should emit proposal.rejected event', async () => {
			// Create proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.reject');
			expect(handler).toBeDefined();

			await handler!(
				{
					roomId: 'room-123',
					proposalId: createResult.proposal.id,
					actedBy: 'user-1',
					response: 'Rejecting',
				},
				{}
			);

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'proposal.rejected',
				expect.objectContaining({
					sessionId: 'room:room-123',
					roomId: 'room-123',
					proposalId: createResult.proposal.id,
					proposal: expect.objectContaining({
						status: 'rejected',
					}),
				})
			);
		});

		it('should require response/reason for rejection', async () => {
			// Create proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.reject');
			expect(handler).toBeDefined();

			await expect(
				handler!(
					{
						roomId: 'room-123',
						proposalId: createResult.proposal.id,
						actedBy: 'user-1',
					},
					{}
				)
			).rejects.toThrow('Response/reason is required for rejection');
		});

		it('should throw error if proposal not pending', async () => {
			// Create and approve proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const approveHandler = messageHubData.handlers.get('proposal.approve');
			await approveHandler!(
				{
					roomId: 'room-123',
					proposalId: createResult.proposal.id,
					actedBy: 'user-1',
				},
				{}
			);

			// Try to reject approved proposal
			const rejectHandler = messageHubData.handlers.get('proposal.reject');
			await expect(
				rejectHandler!(
					{
						roomId: 'room-123',
						proposalId: createResult.proposal.id,
						actedBy: 'user-1',
						response: 'Too late',
					},
					{}
				)
			).rejects.toThrow('Proposal is not pending: approved');
		});
	});

	describe('proposal.withdraw', () => {
		it('should withdraw a proposal', async () => {
			// Create proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const handler = messageHubData.handlers.get('proposal.withdraw');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				proposalId: createResult.proposal.id,
			};

			const result = (await handler!(params, {})) as { proposal: RoomProposal };

			expect(result.proposal.status).toBe('withdrawn');
		});

		it('should throw error if proposal not pending', async () => {
			// Create and approve proposal
			const createHandler = messageHubData.handlers.get('proposal.create');
			const createResult = (await createHandler!(
				{
					roomId: 'room-123',
					sessionId: 'session-456',
					type: 'file_change' as ProposalType,
					title: 'Test Proposal',
				},
				{}
			)) as { proposal: RoomProposal };

			const approveHandler = messageHubData.handlers.get('proposal.approve');
			await approveHandler!(
				{
					roomId: 'room-123',
					proposalId: createResult.proposal.id,
					actedBy: 'user-1',
				},
				{}
			);

			// Try to withdraw approved proposal
			const withdrawHandler = messageHubData.handlers.get('proposal.withdraw');
			await expect(
				withdrawHandler!(
					{
						roomId: 'room-123',
						proposalId: createResult.proposal.id,
					},
					{}
				)
			).rejects.toThrow('Proposal is not pending: approved');
		});

		it('should require roomId', async () => {
			const handler = messageHubData.handlers.get('proposal.withdraw');
			expect(handler).toBeDefined();

			await expect(handler!({ proposalId: 'some-id' }, {})).rejects.toThrow('Room ID is required');
		});

		it('should require proposalId', async () => {
			const handler = messageHubData.handlers.get('proposal.withdraw');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow('Proposal ID is required');
		});
	});
});
