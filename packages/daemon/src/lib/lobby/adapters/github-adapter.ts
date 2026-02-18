/**
 * GitHub External Source Adapter
 *
 * Adapts GitHub events to the normalized ExternalMessage format.
 * This adapter wraps the existing GitHubService and converts its events.
 */

import type { DaemonHub } from '../../daemon-hub';
import type { ExternalSourceAdapter, ExternalMessage, ExternalMessageCallback } from '../types';
import type { GitHubEvent } from '../../github/types';
import { GitHubService, createGitHubService } from '../../github/github-service';
import type { Database } from '../../../storage/database';
import type { Config } from '../../../config';
import { Logger } from '../../logger';

const log = new Logger('github-adapter');

/**
 * Configuration for the GitHub adapter
 */
export interface GitHubAdapterConfig {
	/** Database instance */
	db: Database;
	/** DaemonHub for events */
	daemonHub: DaemonHub;
	/** Application config */
	config: Config;
	/** API key for AI operations */
	apiKey: string;
	/** Optional GitHub token */
	githubToken?: string;
	/** Callback when external message is produced */
	onMessage: ExternalMessageCallback;
}

/**
 * GitHub External Source Adapter
 *
 * Converts GitHub webhooks and polling events into normalized ExternalMessages.
 */
export class GitHubAdapter implements ExternalSourceAdapter {
	readonly sourceType = 'github' as const;
	readonly name = 'GitHub';

	private githubService: GitHubService;
	private daemonHub: DaemonHub;
	private onMessage: ExternalMessageCallback;
	private unsubscribe?: () => void;
	private healthy = false;
	private messagesProcessed = 0;

	constructor(config: GitHubAdapterConfig) {
		this.githubService = createGitHubService({
			db: config.db,
			daemonHub: config.daemonHub,
			config: config.config,
			apiKey: config.apiKey,
			githubToken: config.githubToken,
		});
		this.daemonHub = config.daemonHub;
		this.onMessage = config.onMessage;
	}

	async start(): Promise<void> {
		log.info('Starting GitHub adapter');

		// Start the underlying GitHub service
		this.githubService.start();

		// Subscribe to GitHub events and convert to external messages
		this.unsubscribe = this.daemonHub.on(
			'github.eventReceived',
			async (event: { sessionId: string; event: GitHubEvent }) => {
				try {
					const externalMessage = this.convertToExternalMessage(event.event);
					await this.onMessage(externalMessage);
					this.messagesProcessed++;
				} catch (error) {
					log.error('Failed to process GitHub event:', error);
				}
			},
			{ sessionId: 'lobby' }
		);

		this.healthy = true;
		log.info('GitHub adapter started');
	}

	async stop(): Promise<void> {
		log.info('Stopping GitHub adapter');

		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}

		this.githubService.stop();
		this.healthy = false;

		log.info('GitHub adapter stopped');
	}

	isHealthy(): boolean {
		return this.healthy && this.githubService.isRunning();
	}

	getStats(): Record<string, number | string> {
		return {
			messagesProcessed: this.messagesProcessed,
			isRunning: this.githubService.isRunning() ? 'true' : 'false',
			isPolling: this.githubService.isPolling() ? 'true' : 'false',
			hasWebhook: this.githubService.hasWebhookHandler() ? 'true' : 'false',
			pendingInbox: this.githubService.getPendingInboxCount(),
		};
	}

	/**
	 * Get the underlying GitHub service for direct access
	 */
	getGitHubService(): GitHubService {
		return this.githubService;
	}

	/**
	 * Handle incoming webhook request
	 */
	async handleWebhook(req: Request): Promise<Response> {
		return this.githubService.handleWebhook(req);
	}

	/**
	 * Convert GitHub event to ExternalMessage
	 */
	private convertToExternalMessage(event: GitHubEvent): ExternalMessage {
		const eventType = event.eventType;
		const action = event.action;

		// Build title from event type
		let title = '';
		if (event.issue) {
			title = event.issue.title;
		} else if (event.comment) {
			// Comment without issue - use comment id
			title = `Comment ${event.comment.id}`;
		}

		// For comments with issue context, add the issue number
		if (event.comment && event.issue) {
			title = `Comment on #${event.issue.number}`;
		}

		// Build body
		const body = event.comment?.body ?? event.issue?.body ?? '';

		// Build labels
		const labels = event.issue?.labels ?? [];

		// Build links (repository name only - no URL in type)
		const links: string[] = [event.repository.fullName];

		return {
			id: event.id,
			source: 'github',
			timestamp: Date.now(),
			sender: {
				name: event.sender.login,
				// id and avatarUrl not available in current type
			},
			content: {
				title,
				body,
				labels,
				links,
			},
			metadata: {
				githubEventType: eventType,
				githubAction: action,
				eventSource: event.source,
			},
			context: {
				repository: event.repository.fullName,
				number: event.issue?.number,
				eventType: eventType,
				action: action,
			},
		};
	}
}

/**
 * Create a GitHub adapter
 */
export function createGitHubAdapter(config: GitHubAdapterConfig): GitHubAdapter {
	return new GitHubAdapter(config);
}
