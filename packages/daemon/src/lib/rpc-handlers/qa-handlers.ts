/**
 * Q&A Round RPC Handlers
 *
 * RPC handlers for Q&A round operations:
 * - qa.getActiveRound - Get the active Q&A round
 * - qa.getRoundHistory - Get Q&A round history for a room
 * - qa.answerQuestion - Answer a question in the round
 * - qa.completeRound - Complete the current round
 *
 * Note: Q&A rounds are primarily managed by QARoundManager in the room-agent-service.
 * These handlers provide read-only access for the UI.
 */

import type { MessageHub } from '@neokai/shared';
import type { Database } from '../../storage/database';
import { QARoundRepository } from '../../storage/repositories/qa-round-repository';

export function setupQAHandlers(messageHub: MessageHub, db: Database): void {
	const getRepo = () => new QARoundRepository(db.getDatabase());

	// qa.getActiveRound - Get the active Q&A round
	messageHub.onRequest('qa.getActiveRound', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const round = getRepo().getActiveRound(params.roomId);
		return { round };
	});

	// qa.getRoundHistory - Get Q&A round history for a room
	messageHub.onRequest('qa.getRoundHistory', async (data) => {
		const params = data as {
			roomId: string;
			limit?: number;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const rounds = getRepo().listRounds(params.roomId, params.limit);
		return { rounds };
	});

	// qa.answerQuestion - Answer a question in the active round
	messageHub.onRequest('qa.answerQuestion', async (data) => {
		const params = data as {
			roomId: string;
			questionId: string;
			answer: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.questionId) {
			throw new Error('Question ID is required');
		}
		if (!params.answer) {
			throw new Error('Answer is required');
		}

		const repo = getRepo();
		const activeRound = repo.getActiveRound(params.roomId);
		if (!activeRound) {
			throw new Error('No active Q&A round for this room');
		}

		const question = repo.answerQuestion(activeRound.id, params.questionId, params.answer);
		return { question };
	});

	// qa.completeRound - Complete the active round
	messageHub.onRequest('qa.completeRound', async (data) => {
		const params = data as {
			roomId: string;
			summary?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const repo = getRepo();
		const activeRound = repo.getActiveRound(params.roomId);
		if (!activeRound) {
			throw new Error('No active Q&A round for this room');
		}

		const round = repo.completeRound(activeRound.id, params.summary);
		return { round };
	});
}
