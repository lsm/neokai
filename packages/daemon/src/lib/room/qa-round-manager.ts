/**
 * QARoundManager - Manages Q&A rounds for context refinement
 *
 * Triggers:
 * - When room is created (initial polish)
 * - When context is updated (background/instructions changed)
 * - When goals are created (optional)
 *
 * The Q&A round allows the agent to ask clarifying questions
 * to better understand the room context before proceeding.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { RoomQARound, QAQuestion, MessageHub, Room } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import { QARoundRepository } from '../../storage/repositories/qa-round-repository';
import { Logger } from '../logger';

const log = new Logger('qa-round-manager');

/**
 * Context for QARoundManager
 */
export interface QARoundManagerContext {
	room: Room;
	db: BunDatabase;
	daemonHub: DaemonHub;
	messageHub: MessageHub;
}

/**
 * Configuration for Q&A rounds
 */
export interface QARoundConfig {
	/** Maximum questions per round */
	maxQuestionsPerRound: number;
	/** Whether to auto-trigger Q&A on room creation */
	autoTriggerOnRoomCreate: boolean;
	/** Whether to auto-trigger Q&A on context update */
	autoTriggerOnContextUpdate: boolean;
}

const DEFAULT_CONFIG: QARoundConfig = {
	maxQuestionsPerRound: 5,
	autoTriggerOnRoomCreate: true,
	autoTriggerOnContextUpdate: true,
};

/**
 * QARoundManager - Manages Q&A rounds for context refinement
 */
export class QARoundManager {
	private repo: QARoundRepository;
	private config: QARoundConfig;
	private activeRound: RoomQARound | null = null;

	constructor(
		private ctx: QARoundManagerContext,
		config?: Partial<QARoundConfig>
	) {
		this.repo = new QARoundRepository(ctx.db);
		this.config = { ...DEFAULT_CONFIG, ...config };

		// Load active round if exists
		this.activeRound = this.repo.getActiveRound(ctx.room.id);
	}

	/**
	 * Start a Q&A round for the given trigger
	 */
	async startRound(trigger: RoomQARound['trigger']): Promise<RoomQARound> {
		// Check if there's already an active round
		const existingRound = this.repo.getActiveRound(this.ctx.room.id);
		if (existingRound) {
			log.info(`Active Q&A round already exists: ${existingRound.id}`);
			this.activeRound = existingRound;
			return existingRound;
		}

		// Create new round
		const round = this.repo.createRound(this.ctx.room.id, trigger);
		this.activeRound = round;

		log.info(`Started Q&A round ${round.id} for room ${this.ctx.room.id} (trigger: ${trigger})`);

		// Emit event
		await this.ctx.daemonHub.emit('qa.roundStarted', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			roundId: round.id,
			trigger,
		});

		return round;
	}

	/**
	 * Ask a question in the current round
	 */
	async askQuestion(question: string): Promise<QAQuestion> {
		if (!this.activeRound) {
			throw new Error('No active Q&A round');
		}

		if (this.activeRound.questions.length >= this.config.maxQuestionsPerRound) {
			throw new Error(`Maximum questions per round (${this.config.maxQuestionsPerRound}) reached`);
		}

		const qa = this.repo.addQuestion(this.activeRound.id, question);
		this.activeRound = this.repo.getRound(this.activeRound.id);

		log.info(`Question ${qa.id} asked in round ${this.activeRound!.id}`);

		// Emit event
		await this.ctx.daemonHub.emit('qa.questionAsked', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			roundId: this.activeRound!.id,
			questionId: qa.id,
			question,
		});

		return qa;
	}

	/**
	 * Answer a question in the round
	 */
	async answerQuestion(questionId: string, answer: string): Promise<QAQuestion> {
		if (!this.activeRound) {
			throw new Error('No active Q&A round');
		}

		const qa = this.repo.answerQuestion(this.activeRound.id, questionId, answer);
		if (!qa) {
			throw new Error(`Question not found: ${questionId}`);
		}

		this.activeRound = this.repo.getRound(this.activeRound.id);

		log.info(`Question ${questionId} answered in round ${this.activeRound!.id}`);

		// Emit event
		await this.ctx.daemonHub.emit('qa.questionAnswered', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			roundId: this.activeRound!.id,
			questionId,
			answer,
		});

		return qa;
	}

	/**
	 * Complete the round and generate summary
	 */
	async completeRound(summary?: string): Promise<RoomQARound> {
		if (!this.activeRound) {
			throw new Error('No active Q&A round');
		}

		const round = this.repo.completeRound(this.activeRound.id, summary);
		if (!round) {
			throw new Error('Failed to complete round');
		}

		log.info(`Q&A round ${round.id} completed`);

		// Emit event
		await this.ctx.daemonHub.emit('qa.roundCompleted', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			roundId: round.id,
			summary: round.summary,
			questionsCount: round.questions.length,
			answeredCount: round.questions.filter((q) => q.answer).length,
		});

		this.activeRound = null;
		return round;
	}

	/**
	 * Cancel the current round
	 */
	async cancelRound(): Promise<RoomQARound | null> {
		if (!this.activeRound) {
			return null;
		}

		const round = this.repo.cancelRound(this.activeRound.id);

		log.info(`Q&A round ${this.activeRound.id} cancelled`);

		// Emit event
		await this.ctx.daemonHub.emit('qa.roundCancelled', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			roundId: this.activeRound.id,
		});

		this.activeRound = null;
		return round;
	}

	/**
	 * Get the active Q&A round
	 */
	getActiveRound(): RoomQARound | null {
		return this.activeRound;
	}

	/**
	 * Check if there's an active round
	 */
	hasActiveRound(): boolean {
		return this.activeRound !== null;
	}

	/**
	 * Get unanswered questions in the active round
	 */
	getUnansweredQuestions(): QAQuestion[] {
		if (!this.activeRound) {
			return [];
		}
		return this.activeRound.questions.filter((q) => !q.answer);
	}

	/**
	 * Get the next unanswered question
	 */
	getNextUnansweredQuestion(): QAQuestion | null {
		const unanswered = this.getUnansweredQuestions();
		return unanswered.length > 0 ? unanswered[0] : null;
	}

	/**
	 * Check if all questions have been answered
	 */
	allQuestionsAnswered(): boolean {
		if (!this.activeRound) {
			return true;
		}
		return this.activeRound.questions.every((q) => q.answer);
	}

	/**
	 * Get Q&A round history for the room
	 */
	getRoundHistory(limit?: number): RoomQARound[] {
		return this.repo.listRounds(this.ctx.room.id, limit);
	}

	/**
	 * Check if should auto-trigger for room creation
	 */
	shouldAutoTriggerOnRoomCreate(): boolean {
		return this.config.autoTriggerOnRoomCreate;
	}

	/**
	 * Check if should auto-trigger for context update
	 */
	shouldAutoTriggerOnContextUpdate(): boolean {
		return this.config.autoTriggerOnContextUpdate;
	}

	/**
	 * Refresh the active round from database
	 */
	refreshActiveRound(): RoomQARound | null {
		this.activeRound = this.repo.getActiveRound(this.ctx.room.id);
		return this.activeRound;
	}
}
