/**
 * Proposal RPC Handlers
 *
 * RPC handlers for room agent proposals:
 * - proposal.create - Create a proposal (agent only)
 * - proposal.get - Get proposal details
 * - proposal.list - List proposals in room
 * - proposal.approve - Approve a proposal (human)
 * - proposal.reject - Reject a proposal (human)
 * - proposal.withdraw - Withdraw a proposal (agent)
 */

import type { MessageHub, ProposalStatus, ProposalType } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { RoomManager } from '../room/room-manager';
import { ProposalRepository } from '../../storage/repositories/proposal-repository';

export function setupProposalHandlers(
	messageHub: MessageHub,
	roomManager: RoomManager,
	daemonHub: DaemonHub,
	db: Database
): void {
	const rawDb = db.getDatabase();
	const proposalRepo = new ProposalRepository(rawDb);

	/**
	 * Emit proposal.created event
	 */
	const emitProposalCreated = (roomId: string, proposal: import('@neokai/shared').RoomProposal) => {
		daemonHub
			.emit('proposal.created', {
				sessionId: `room:${roomId}`,
				roomId,
				proposalId: proposal.id,
				proposal,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	/**
	 * Emit proposal.approved event
	 */
	const emitProposalApproved = (
		roomId: string,
		proposal: import('@neokai/shared').RoomProposal
	) => {
		daemonHub
			.emit('proposal.approved', {
				sessionId: `room:${roomId}`,
				roomId,
				proposalId: proposal.id,
				proposal,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	/**
	 * Emit proposal.rejected event
	 */
	const emitProposalRejected = (
		roomId: string,
		proposal: import('@neokai/shared').RoomProposal
	) => {
		daemonHub
			.emit('proposal.rejected', {
				sessionId: `room:${roomId}`,
				roomId,
				proposalId: proposal.id,
				proposal,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});
	};

	// proposal.create - Create a proposal
	messageHub.onRequest('proposal.create', async (data) => {
		const params = data as {
			roomId: string;
			sessionId: string;
			type: ProposalType;
			title: string;
			description: string;
			proposedChanges: Record<string, unknown>;
			reasoning: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.sessionId) {
			throw new Error('Session ID is required');
		}
		if (!params.title) {
			throw new Error('Proposal title is required');
		}

		// Verify room exists
		const room = roomManager.getRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		const proposal = proposalRepo.createProposal({
			roomId: params.roomId,
			sessionId: params.sessionId,
			type: params.type,
			title: params.title,
			description: params.description ?? '',
			proposedChanges: params.proposedChanges ?? {},
			reasoning: params.reasoning ?? '',
		});

		// Emit creation event
		emitProposalCreated(params.roomId, proposal);

		return { proposal };
	});

	// proposal.get - Get proposal details
	messageHub.onRequest('proposal.get', async (data) => {
		const params = data as { roomId: string; proposalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.proposalId) {
			throw new Error('Proposal ID is required');
		}

		const proposal = proposalRepo.getProposal(params.proposalId);

		if (!proposal) {
			throw new Error(`Proposal not found: ${params.proposalId}`);
		}

		// Verify proposal belongs to the room
		if (proposal.roomId !== params.roomId) {
			throw new Error(`Proposal not found in room: ${params.proposalId}`);
		}

		return { proposal };
	});

	// proposal.list - List proposals in room
	messageHub.onRequest('proposal.list', async (data) => {
		const params = data as {
			roomId: string;
			status?: ProposalStatus;
			type?: ProposalType;
			sessionId?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const proposals = proposalRepo.listProposals(params.roomId, {
			status: params.status,
			type: params.type,
			sessionId: params.sessionId,
		});

		return { proposals };
	});

	// proposal.approve - Approve a proposal
	messageHub.onRequest('proposal.approve', async (data) => {
		const params = data as {
			roomId: string;
			proposalId: string;
			actedBy: string;
			response?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.proposalId) {
			throw new Error('Proposal ID is required');
		}
		if (!params.actedBy) {
			throw new Error('actedBy is required');
		}

		// Verify proposal exists and belongs to room
		const existingProposal = proposalRepo.getProposal(params.proposalId);
		if (!existingProposal) {
			throw new Error(`Proposal not found: ${params.proposalId}`);
		}
		if (existingProposal.roomId !== params.roomId) {
			throw new Error(`Proposal not found in room: ${params.proposalId}`);
		}
		if (existingProposal.status !== 'pending') {
			throw new Error(`Proposal is not pending: ${existingProposal.status}`);
		}

		const proposal = proposalRepo.approveProposal(
			params.proposalId,
			params.actedBy,
			params.response
		);

		if (!proposal) {
			throw new Error('Failed to approve proposal');
		}

		// Emit approval event
		emitProposalApproved(params.roomId, proposal);

		return { proposal };
	});

	// proposal.reject - Reject a proposal
	messageHub.onRequest('proposal.reject', async (data) => {
		const params = data as {
			roomId: string;
			proposalId: string;
			actedBy: string;
			response: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.proposalId) {
			throw new Error('Proposal ID is required');
		}
		if (!params.actedBy) {
			throw new Error('actedBy is required');
		}
		if (!params.response) {
			throw new Error('Response/reason is required for rejection');
		}

		// Verify proposal exists and belongs to room
		const existingProposal = proposalRepo.getProposal(params.proposalId);
		if (!existingProposal) {
			throw new Error(`Proposal not found: ${params.proposalId}`);
		}
		if (existingProposal.roomId !== params.roomId) {
			throw new Error(`Proposal not found in room: ${params.proposalId}`);
		}
		if (existingProposal.status !== 'pending') {
			throw new Error(`Proposal is not pending: ${existingProposal.status}`);
		}

		const proposal = proposalRepo.rejectProposal(
			params.proposalId,
			params.actedBy,
			params.response
		);

		if (!proposal) {
			throw new Error('Failed to reject proposal');
		}

		// Emit rejection event
		emitProposalRejected(params.roomId, proposal);

		return { proposal };
	});

	// proposal.withdraw - Withdraw a proposal
	messageHub.onRequest('proposal.withdraw', async (data) => {
		const params = data as { roomId: string; proposalId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.proposalId) {
			throw new Error('Proposal ID is required');
		}

		// Verify proposal exists and belongs to room
		const existingProposal = proposalRepo.getProposal(params.proposalId);
		if (!existingProposal) {
			throw new Error(`Proposal not found: ${params.proposalId}`);
		}
		if (existingProposal.roomId !== params.roomId) {
			throw new Error(`Proposal not found in room: ${params.proposalId}`);
		}
		if (existingProposal.status !== 'pending') {
			throw new Error(`Proposal is not pending: ${existingProposal.status}`);
		}

		const proposal = proposalRepo.withdrawProposal(params.proposalId);

		if (!proposal) {
			throw new Error('Failed to withdraw proposal');
		}

		return { proposal };
	});
}
