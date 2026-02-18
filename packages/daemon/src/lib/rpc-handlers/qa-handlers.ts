/**
 * Q&A Round RPC Handlers
 *
 * RPC handlers for Q&A round operations:
 * - qa.startRound - Start a new Q&A round
 * - qa.answerQuestion - Answer a question in the round
 * - qa.getActiveRound - Get the active Q&A round
 * - qa.completeRound - Complete the current round
 * - qa.cancelRound - Cancel the current round
 * - qa.getRoundHistory - Get Q&A round history for a room
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { QARoundManager } from '../room/qa-round-manager';

export function setupQAHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	getQARoundManager: (roomId: string) => QARoundManager | null
): void {
	// qa.startRound - Start a new Q&A round
	messageHub.onRequest('qa.startRound', async (data) => {
		const params = data as {
			roomId: string;
			trigger: 'room_created' | 'context_updated' | 'goal_created';
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		if (!params.trigger) {
			throw new Error('Trigger is required');
		}

		const qaManager = getQARoundManager(params.roomId);
		if (!qaManager) {
			throw new Error('Q&A round manager not available for this room');
		}

		const round = await qaManager.startRound(params.trigger);
		return { round };
	});

	// qa.answerQuestion - Answer a question in the round
	messageHub.onRequest('qa.answerQuestion', async (data) => {
		const params = data as {
			roomId: string;
			roundId: string;
			questionId: string;
			answer: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.roundId) {
			throw new Error('Round ID is required');
		}
		if (!params.questionId) {
			throw new Error('Question ID is required');
		}
		if (!params.answer) {
			throw new Error('Answer is required');
		}

		const qaManager = getQARoundManager(params.roomId);
		if (!qaManager) {
			throw new Error('Q&A round manager not available for this room');
		}

		const question = await qaManager.answerQuestion(params.questionId, params.answer);
		return { question };
	});

	// qa.getActiveRound - Get the active Q&A round
	messageHub.onRequest('qa.getActiveRound', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const qaManager = getQARoundManager(params.roomId);
		if (!qaManager) {
			throw new Error('Q&A round manager not available for this room');
		}

		const round = qaManager.getActiveRound();
		return { round };
	});

	// qa.completeRound - Complete the current round
	messageHub.onRequest('qa.completeRound', async (data) => {
		const params = data as {
			roomId: string;
			summary?: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const qaManager = getQARoundManager(params.roomId);
		if (!qaManager) {
			throw new Error('Q&A round manager not available for this room');
		}

		const round = await qaManager.completeRound(params.summary);
		return { round };
	});

	// qa.cancelRound - Cancel the current round
	messageHub.onRequest('qa.cancelRound', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const qaManager = getQARoundManager(params.roomId);
		if (!qaManager) {
			throw new Error('Q&A round manager not available for this room');
		}

		const round = await qaManager.cancelRound();
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

		const qaManager = getQARoundManager(params.roomId);
		if (!qaManager) {
			throw new Error('Q&A round manager not available for this room');
		}

		const rounds = qaManager.getRoundHistory(params.limit);
		return { rounds };
	});

	// qa.askQuestion - Agent asks a question (for use by room agent)
	messageHub.onRequest('qa.askQuestion', async (data) => {
		const params = data as {
			roomId: string;
			question: string;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}
		if (!params.question) {
			throw new Error('Question is required');
		}

		const qaManager = getQARoundManager(params.roomId);
		if (!qaManager) {
			throw new Error('Q&A round manager not available for this room');
		}

		const question = await qaManager.askQuestion(params.question);
		return { question };
	});
}
