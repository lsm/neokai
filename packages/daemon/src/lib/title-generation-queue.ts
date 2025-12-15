/**
 * TitleGenerationQueue - Background job queue for session title generation
 *
 * Architecture:
 * - Listens to EventBus 'message:sent' events (decoupled from RPC handlers)
 * - Uses liteque for persistent job queue with automatic retry
 * - Generates titles from user input only (no dependency on assistant responses)
 * - Emits success/failure events back to EventBus
 * - Ensures exactly one title generation per session
 *
 * Benefits:
 * - Reliable: Automatic retries with exponential backoff
 * - Non-blocking: Fire-and-forget job enqueueing
 * - Persistent: Jobs survive daemon restarts
 * - Decoupled: No direct dependencies on message handlers
 * - Type-safe: Zod schema validation for job data
 */

import { SqliteQueue, Runner, buildDBClient } from 'liteque';
import type { DequeuedJob, DequeuedJobError } from 'liteque';
import { z } from 'zod';
import type { EventBus } from '@liuboer/shared';
import type { SDKUserMessage } from '@liuboer/shared/sdk';
import type { Database } from '../storage/database.ts';
import { generateTitleFromUserInput } from './title-generator.ts';
import { Logger } from './logger.ts';

const logger = new Logger('TitleQueue');

/**
 * Job data schema for type safety and validation
 */
const titleJobSchema = z.object({
	sessionId: z.string(),
	workspacePath: z.string(),
	userMessages: z.array(z.record(z.string(), z.unknown())), // Serialized SDKUserMessage[]
});

type TitleGenerationJob = z.infer<typeof titleJobSchema>;

/**
 * Configuration options
 */
interface TitleGenerationQueueOptions {
	/** Maximum retry attempts per job (default: 3) */
	maxRetries?: number;
	/** Polling interval in milliseconds (default: 1000) */
	pollIntervalMs?: number;
	/** Job timeout in seconds (default: 30) */
	timeoutSecs?: number;
	/** Whether to keep failed jobs in database (default: false) */
	keepFailedJobs?: boolean;
}

/**
 * TitleGenerationQueue - Manages background title generation jobs
 */
export class TitleGenerationQueue {
	private queue: SqliteQueue<TitleGenerationJob>;
	private runner: Runner<TitleGenerationJob>;
	private eventBusUnsubscribe?: () => void;
	private runnerPromise: Promise<void> | null = null;
	private maxRetries: number;

	constructor(
		private database: Database,
		private eventBus: EventBus,
		options: TitleGenerationQueueOptions = {}
	) {
		const {
			maxRetries = 3,
			pollIntervalMs = 1000,
			timeoutSecs = 30,
			keepFailedJobs = false,
		} = options;

		this.maxRetries = maxRetries;

		// Get database path from Database instance
		// Note: liteque will create its own database connection for the queue tables
		// This is separate from the main database connection but uses the same file
		const dbPath = this.database.getDatabasePath();
		const db = buildDBClient(dbPath, { runMigrations: true });

		// Create queue with liteque
		this.queue = new SqliteQueue<TitleGenerationJob>('title_generation_jobs', db, {
			defaultJobArgs: { numRetries: maxRetries },
			keepFailedJobs,
		});

		// Create worker runner
		this.runner = new Runner<TitleGenerationJob>(
			this.queue,
			{
				run: async (job: DequeuedJob<TitleGenerationJob>) => {
					// Validate job data with Zod
					const validatedData = titleJobSchema.parse(job.data);
					await this.processJob(validatedData);
				},
				onComplete: async (job: DequeuedJob<TitleGenerationJob>) => {
					logger.log(`Title generation completed for session ${job.data.sessionId}`);
				},
				onError: async (job: DequeuedJobError<TitleGenerationJob>) => {
					const err = job.error;
					const sessionId = job.data?.sessionId || 'unknown';
					logger.warn(
						`Title generation failed for session ${sessionId} (attempt ${job.runNumber}):`,
						err.message
					);

					// Emit failure event on final retry
					if (job.runNumber >= maxRetries) {
						await this.eventBus.emit('title:generation:failed', {
							sessionId,
							error: err,
							attempts: job.runNumber,
						});
					}
				},
			},
			{
				concurrency: 1, // Process one title at a time
				pollIntervalMs,
				timeoutSecs,
			}
		);
	}

	/**
	 * Start the queue worker and listen to EventBus
	 */
	async start(): Promise<void> {
		if (this.runnerPromise) {
			logger.warn('Queue already running');
			return;
		}

		logger.log('Starting title generation queue...');

		// Listen to message:sent events
		this.eventBusUnsubscribe = this.eventBus.on('message:sent', async (data) => {
			await this.handleMessageSent(data.sessionId);
		});

		// Start liteque worker (run returns a promise that resolves when stopped)
		this.runnerPromise = this.runner.run();

		logger.log('Title generation queue started');
	}

	/**
	 * Stop the queue worker and cleanup
	 */
	async stop(): Promise<void> {
		if (!this.runnerPromise) {
			return;
		}

		logger.log('Stopping title generation queue...');

		// Unsubscribe from EventBus
		if (this.eventBusUnsubscribe) {
			this.eventBusUnsubscribe();
			this.eventBusUnsubscribe = undefined;
		}

		// Stop liteque worker (finishes current job)
		this.runner.stop();

		// Wait for runner to finish
		await this.runnerPromise;
		this.runnerPromise = null;

		logger.log('Title generation queue stopped');
	}

	/**
	 * Handle message:sent event - enqueue title generation if needed
	 */
	private async handleMessageSent(sessionId: string): Promise<void> {
		try {
			// Check if title already generated
			const session = this.database.getSession(sessionId);
			if (!session) {
				logger.warn(`Session ${sessionId} not found, skipping title generation`);
				return;
			}

			if (session.metadata.titleGenerated) {
				// Already generated, skip
				return;
			}

			// Get user messages from database
			const messages = this.database.getSDKMessages(sessionId, 100);
			const userMessages = messages.filter(
				(m) => m.type === 'user' && !(m as { isSynthetic?: boolean }).isSynthetic
			);

			if (userMessages.length === 0) {
				logger.warn(`No user messages found for session ${sessionId}`);
				return;
			}

			// Enqueue job (fire-and-forget)
			await this.queue.enqueue({
				sessionId,
				workspacePath: session.workspacePath,
				userMessages: userMessages.map((m) => m as Record<string, unknown>),
			});

			logger.log(`Enqueued title generation for session ${sessionId}`);
		} catch (error) {
			logger.error(`Failed to enqueue title generation for session ${sessionId}:`, error);
		}
	}

	/**
	 * Process a title generation job
	 */
	private async processJob(job: TitleGenerationJob): Promise<void> {
		const { sessionId, workspacePath, userMessages } = job;

		// Generate title from user messages
		const title = await generateTitleFromUserInput(
			userMessages as unknown as SDKUserMessage[],
			workspacePath
		);

		// Atomically update session with fresh DB read
		const currentSession = this.database.getSession(sessionId);
		if (!currentSession) {
			throw new Error(`Session ${sessionId} not found during title update`);
		}

		// Double-check titleGenerated flag (avoid race condition)
		if (currentSession.metadata.titleGenerated) {
			logger.log(`Title already generated for session ${sessionId}, skipping update`);
			return;
		}

		// Update database
		this.database.updateSession(sessionId, {
			title,
			metadata: {
				...currentSession.metadata,
				titleGenerated: true,
			},
		});

		// Emit success event (StateManager will broadcast to clients)
		await this.eventBus.emit('title:generated', {
			sessionId,
			title,
		});

		logger.log(`Successfully generated and saved title for session ${sessionId}: "${title}"`);
	}

	/**
	 * Get queue statistics (for monitoring/debugging)
	 */
	async getStats(): Promise<{
		pending: number;
		pending_retry: number;
		running: number;
		failed: number;
	}> {
		return await this.queue.stats();
	}

	/**
	 * Manually enqueue title generation for a session (for debugging/testing)
	 */
	async enqueueManually(sessionId: string): Promise<void> {
		await this.handleMessageSent(sessionId);
	}
}
