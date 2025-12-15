/**
 * SimpleTitleQueue - Bun-compatible background job queue for title generation
 *
 * This is a lightweight alternative to liteque that works with Bun's native SQLite.
 * Uses the existing database connection instead of requiring better-sqlite3.
 *
 * Features:
 * - Persistent job queue using existing Bun SQLite database
 * - Automatic retry with exponential backoff
 * - Non-blocking job processing
 * - EventBus integration
 */

import { z } from 'zod';
import type { EventBus } from '@liuboer/shared';
import type { SDKUserMessage } from '@liuboer/shared/sdk';
import type { Database } from '../storage/database.ts';
import { generateTitleFromUserInput } from './title-generator.ts';
import { Logger } from './logger.ts';
import { generateUUID } from '@liuboer/shared';

const logger = new Logger('TitleQueue');

/**
 * Job data schema for type safety and validation
 */
const titleJobSchema = z.object({
	sessionId: z.string(),
	workspacePath: z.string(),
	userMessages: z.array(z.record(z.string(), z.unknown())),
});

type TitleGenerationJob = z.infer<typeof titleJobSchema>;

interface TitleQueueOptions {
	maxRetries?: number;
	pollIntervalMs?: number;
	timeoutSecs?: number;
}

/**
 * Simple Bun-compatible title generation queue
 */
export class SimpleTitleQueue {
	private pollInterval: Timer | null = null;
	private eventBusUnsubscribe?: () => void;
	private isRunning = false;
	private maxRetries: number;
	private pollIntervalMs: number;
	private timeoutMs: number;

	constructor(
		private database: Database,
		private eventBus: EventBus,
		options: TitleQueueOptions = {}
	) {
		this.maxRetries = options.maxRetries ?? 3;
		this.pollIntervalMs = options.pollIntervalMs ?? 1000;
		this.timeoutMs = (options.timeoutSecs ?? 30) * 1000;

		// Create queue table
		this.initializeTable();
	}

	private initializeTable() {
		const db = this.database.getDatabase();
		db.exec(`
			CREATE TABLE IF NOT EXISTS title_queue (
				id TEXT PRIMARY KEY,
				session_id TEXT UNIQUE NOT NULL,
				data TEXT NOT NULL,
				attempts INTEGER DEFAULT 0,
				status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
				created_at INTEGER DEFAULT (strftime('%s', 'now')),
				updated_at INTEGER DEFAULT (strftime('%s', 'now'))
			)
		`);
	}

	async start(): Promise<void> {
		if (this.isRunning) {
			logger.warn('Queue already running');
			return;
		}

		logger.log('Starting title generation queue...');

		// Listen to message:sent events
		this.eventBusUnsubscribe = this.eventBus.on('message:sent', async (data) => {
			await this.handleMessageSent(data.sessionId);
		});

		// Start polling for jobs
		this.pollInterval = setInterval(() => {
			this.processNext().catch((err) => {
				logger.error('Error processing job:', err);
			});
		}, this.pollIntervalMs);

		this.isRunning = true;
		logger.log('Title generation queue started');
	}

	async stop(): Promise<void> {
		if (!this.isRunning) {
			return;
		}

		logger.log('Stopping title generation queue...');

		// Unsubscribe from EventBus
		if (this.eventBusUnsubscribe) {
			this.eventBusUnsubscribe();
			this.eventBusUnsubscribe = undefined;
		}

		// Stop polling
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}

		this.isRunning = false;
		logger.log('Title generation queue stopped');
	}

	private async handleMessageSent(sessionId: string): Promise<void> {
		try {
			// Check if title already generated
			const session = this.database.getSession(sessionId);
			if (!session) {
				logger.warn(`Session ${sessionId} not found, skipping title generation`);
				return;
			}

			if (session.metadata.titleGenerated) {
				return; // Already generated
			}

			// Get user messages
			const messages = this.database.getSDKMessages(sessionId, 100);
			const userMessages = messages.filter(
				(m) => m.type === 'user' && !(m as { isSynthetic?: boolean }).isSynthetic
			);

			if (userMessages.length === 0) {
				logger.warn(`No user messages found for session ${sessionId}`);
				return;
			}

			// Enqueue job
			await this.enqueue({
				sessionId,
				workspacePath: session.workspacePath,
				userMessages: userMessages.map((m) => m as Record<string, unknown>),
			});

			logger.log(`Enqueued title generation for session ${sessionId}`);
		} catch (error) {
			logger.error(`Failed to enqueue title generation for session ${sessionId}:`, error);
		}
	}

	private async enqueue(job: TitleGenerationJob): Promise<void> {
		const db = this.database.getDatabase();
		const id = generateUUID();

		// Insert or ignore if already exists
		db.prepare(
			`
			INSERT OR IGNORE INTO title_queue (id, session_id, data)
			VALUES (?, ?, ?)
		`
		).run(id, job.sessionId, JSON.stringify(job));
	}

	private async processNext(): Promise<void> {
		const db = this.database.getDatabase();

		// Get next pending job
		const job = db
			.prepare(
				`
			SELECT * FROM title_queue
			WHERE status = 'pending' AND attempts < ?
			ORDER BY created_at ASC LIMIT 1
		`
			)
			.get(this.maxRetries) as
			| { id: string; session_id: string; data: string; attempts: number }
			| undefined;

		if (!job) {
			return; // No jobs to process
		}

		// Mark as processing
		db.prepare(
			`
			UPDATE title_queue
			SET status = 'processing', updated_at = strftime('%s', 'now')
			WHERE id = ?
		`
		).run(job.id);

		try {
			// Parse and validate job data
			const data = titleJobSchema.parse(JSON.parse(job.data));

			// Generate title with timeout
			const titlePromise = this.processJob(data);
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('Job timeout')), this.timeoutMs)
			);

			await Promise.race([titlePromise, timeoutPromise]);

			// Mark as completed
			db.prepare('DELETE FROM title_queue WHERE id = ?').run(job.id);

			logger.log(`Title generation completed for session ${data.sessionId}`);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const attempts = job.attempts + 1;

			logger.warn(
				`Title generation failed for session ${job.session_id} (attempt ${attempts}):`,
				err.message
			);

			if (attempts >= this.maxRetries) {
				// Max retries reached
				db.prepare(
					`
					UPDATE title_queue
					SET status = 'failed', attempts = ?, updated_at = strftime('%s', 'now')
					WHERE id = ?
				`
				).run(attempts, job.id);

				await this.eventBus.emit('title:generation:failed', {
					sessionId: job.session_id,
					error: err,
					attempts,
				});
			} else {
				// Retry with exponential backoff
				const backoffMs = Math.min(1000 * Math.pow(2, attempts), 30000);

				db.prepare(
					`
					UPDATE title_queue
					SET status = 'pending', attempts = ?, updated_at = strftime('%s', 'now')
					WHERE id = ?
				`
				).run(attempts, job.id);

				// Schedule retry
				setTimeout(() => {
					this.processNext().catch((err) => {
						logger.error('Error in retry:', err);
					});
				}, backoffMs);
			}
		}
	}

	private async processJob(job: TitleGenerationJob): Promise<void> {
		const { sessionId, workspacePath, userMessages } = job;

		// Generate title
		const title = await generateTitleFromUserInput(
			userMessages as unknown as SDKUserMessage[],
			workspacePath
		);

		// Atomic update with fresh DB read
		const currentSession = this.database.getSession(sessionId);
		if (!currentSession) {
			throw new Error(`Session ${sessionId} not found during title update`);
		}

		// Double-check titleGenerated flag (race condition protection)
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

		// Emit success event
		await this.eventBus.emit('title:generated', {
			sessionId,
			title,
		});

		logger.log(`Successfully generated and saved title for session ${sessionId}: "${title}"`);
	}

	async getStats(): Promise<{
		pending: number;
		processing: number;
		completed: number;
		failed: number;
	}> {
		const db = this.database.getDatabase();

		const pending = db
			.prepare('SELECT COUNT(*) as count FROM title_queue WHERE status = "pending"')
			.get() as { count: number } | undefined;

		const processing = db
			.prepare('SELECT COUNT(*) as count FROM title_queue WHERE status = "processing"')
			.get() as { count: number } | undefined;

		const completed = db
			.prepare('SELECT COUNT(*) as count FROM title_queue WHERE status = "completed"')
			.get() as { count: number } | undefined;

		const failed = db
			.prepare('SELECT COUNT(*) as count FROM title_queue WHERE status = "failed"')
			.get() as { count: number } | undefined;

		return {
			pending: pending?.count ?? 0,
			processing: processing?.count ?? 0,
			completed: completed?.count ?? 0,
			failed: failed?.count ?? 0,
		};
	}

	async enqueueManually(sessionId: string): Promise<void> {
		await this.handleMessageSent(sessionId);
	}
}
