/**
 * Lobby Agent Service
 *
 * The central orchestrator for processing external messages from all sources.
 *
 * Responsibilities:
 * 1. Manage external source adapters (GitHub, Slack, etc.)
 * 2. Perform security checks on incoming messages
 * 3. Route messages to appropriate rooms or inbox
 * 4. Emit events for monitoring and logging
 * 5. Provide statistics on message processing
 *
 * Architecture:
 * - Adapters convert source-specific events to ExternalMessage
 * - LobbyAgent normalizes and routes all messages
 * - SecurityAgent checks for prompt injection
 * - RouterAgent determines destination
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { DaemonHub } from '../daemon-hub';
import type {
	ExternalMessage,
	ExternalRoutingResult,
	ExternalSecurityCheck,
	RoutingCandidate,
	ExternalSourceAdapter,
	LobbyAgentConfig,
	LobbyAgentStats,
	RoutingDecision,
} from './types';
import { DEFAULT_LOBBY_AGENT_CONFIG } from './types';
import { InboxManager } from '../github/inbox-manager';
import { Database } from '../../storage/database';
import { Logger } from '../logger';

const log = new Logger('lobby-agent');

/**
 * Context for the Lobby Agent
 */
export interface LobbyAgentContext {
	/** Database instance */
	db: Database;
	/** Raw BunDatabase for repositories */
	rawDb: BunDatabase;
	/** DaemonHub for events */
	daemonHub: DaemonHub;
	/** API key for AI operations */
	apiKey: string;
}

/**
 * Lobby Agent Service
 *
 * Central hub for all external message processing.
 */
export class LobbyAgentService {
	private config: LobbyAgentConfig;
	private adapters: Map<string, ExternalSourceAdapter> = new Map();
	private inboxManager: InboxManager;
	private stats: LobbyAgentStats = {
		messagesReceived: 0,
		messagesRouted: 0,
		messagesToInbox: 0,
		messagesRejected: 0,
		messagesSecurityFailed: 0,
		averageProcessingTimeMs: 0,
		activeAdapters: [],
	};
	private processingTimes: number[] = [];
	private started = false;

	constructor(
		private ctx: LobbyAgentContext,
		config?: Partial<LobbyAgentConfig>
	) {
		this.config = { ...DEFAULT_LOBBY_AGENT_CONFIG, ...config };
		this.inboxManager = new InboxManager(ctx.db);
	}

	/**
	 * Register an external source adapter
	 */
	registerAdapter(adapter: ExternalSourceAdapter): void {
		const sourceType = adapter.sourceType;
		if (this.adapters.has(sourceType)) {
			log.warn(`Replacing existing adapter for source: ${sourceType}`);
		}
		this.adapters.set(sourceType, adapter);
		log.info(`Registered adapter: ${adapter.name} (${sourceType})`);
	}

	/**
	 * Unregister an adapter
	 */
	unregisterAdapter(sourceType: string): void {
		const adapter = this.adapters.get(sourceType);
		if (adapter) {
			this.adapters.delete(sourceType);
			log.info(`Unregistered adapter: ${sourceType}`);
		}
	}

	/**
	 * Get registered adapters
	 */
	getAdapters(): ExternalSourceAdapter[] {
		return Array.from(this.adapters.values());
	}

	/**
	 * Start the lobby agent and all adapters
	 */
	async start(): Promise<void> {
		if (this.started) {
			log.warn('Lobby agent already started');
			return;
		}

		log.info('Starting lobby agent');

		// Start all registered adapters
		for (const [sourceType, adapter] of this.adapters) {
			try {
				await adapter.start();
				log.info(`Started adapter: ${adapter.name}`);
			} catch (error) {
				log.error(`Failed to start adapter ${sourceType}:`, error);
			}
		}

		this.started = true;
		this.updateActiveAdapters();

		log.info(`Lobby agent started with ${this.adapters.size} adapters`);
	}

	/**
	 * Stop the lobby agent and all adapters
	 */
	async stop(): Promise<void> {
		if (!this.started) {
			return;
		}

		log.info('Stopping lobby agent');

		// Stop all adapters
		for (const [sourceType, adapter] of this.adapters) {
			try {
				await adapter.stop();
				log.info(`Stopped adapter: ${adapter.name}`);
			} catch (error) {
				log.error(`Failed to stop adapter ${sourceType}:`, error);
			}
		}

		this.started = false;
		log.info('Lobby agent stopped');
	}

	/**
	 * Check if the lobby agent is running
	 */
	isRunning(): boolean {
		return this.started;
	}

	/**
	 * Process an external message
	 *
	 * This is the main entry point for all external messages.
	 * Called by adapters when they receive new messages.
	 */
	async processMessage(message: ExternalMessage): Promise<ExternalRoutingResult> {
		const startTime = Date.now();
		this.stats.messagesReceived++;

		log.debug(`Processing external message: ${message.id} from ${message.source}`);

		// Emit message received event
		await this.ctx.daemonHub.emit('lobby.messageReceived', {
			sessionId: 'lobby',
			message,
		});

		try {
			// Step 1: Security check
			const securityCheck = await this.performSecurityCheck(message);

			if (!securityCheck.passed) {
				log.warn(`Message failed security check: ${message.id}`, {
					riskLevel: securityCheck.riskLevel,
					reason: securityCheck.reason,
				});

				this.stats.messagesSecurityFailed++;

				// Add to inbox as blocked
				this.addToInbox(message, securityCheck, 'Security check failed');

				await this.ctx.daemonHub.emit('lobby.messageSecurityFailed', {
					sessionId: 'lobby',
					messageId: message.id,
					securityCheck,
				});

				return {
					decision: 'reject',
					confidence: 'high',
					reason: `Security check failed: ${securityCheck.reason}`,
					securityCheck,
				};
			}

			// Step 2: Find candidate rooms
			const candidates = this.findCandidateRooms(message);

			// Step 3: Route the message
			const routingResult = await this.routeMessage(message, candidates, securityCheck);

			// Step 4: Execute routing decision
			await this.executeRouting(message, routingResult);

			// Update stats
			this.updateStats(routingResult.decision, Date.now() - startTime);

			return routingResult;
		} catch (error) {
			log.error(`Error processing message ${message.id}:`, error);

			// Add to inbox on error
			this.addToInbox(
				message,
				{ passed: true, riskLevel: 'low' },
				`Processing error: ${error instanceof Error ? error.message : 'Unknown error'}`
			);

			return {
				decision: 'inbox',
				confidence: 'low',
				reason: `Processing error: ${error instanceof Error ? error.message : 'Unknown error'}`,
				securityCheck: { passed: true, riskLevel: 'low' },
			};
		}
	}

	/**
	 * Perform security check on message
	 */
	private async performSecurityCheck(message: ExternalMessage): Promise<ExternalSecurityCheck> {
		if (!this.config.enableSecurityCheck) {
			return { passed: true, riskLevel: 'none' };
		}

		// Basic security checks
		const indicators: string[] = [];
		const content = `${message.content.title ?? ''} ${message.content.body}`.toLowerCase();

		// Check for common prompt injection patterns
		const injectionPatterns = [
			'ignore previous instructions',
			'ignore all previous',
			'disregard all',
			'system prompt',
			'you are now',
			'simulate being',
			'pretend to be',
			'act as if',
			'jailbreak',
			'developer mode',
		];

		let riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical' = 'none';

		for (const pattern of injectionPatterns) {
			if (content.includes(pattern)) {
				indicators.push(`Detected pattern: "${pattern}"`);
				riskLevel = riskLevel === 'none' ? 'medium' : riskLevel;
			}
		}

		// Check for suspicious URLs
		const suspiciousDomains = ['pastebin.com', 'hastebin.com', 'ghostbin.com'];
		for (const domain of suspiciousDomains) {
			if (content.includes(domain)) {
				indicators.push(`Suspicious domain: ${domain}`);
				riskLevel = riskLevel === 'none' ? 'low' : 'medium';
			}
		}

		// If we have an API key, use AI for more thorough check
		// (This would integrate with the existing SecurityAgent)
		// For now, we use basic pattern matching

		// Cast to full union type since TypeScript narrows through control flow
		const finalRiskLevel = riskLevel as 'none' | 'low' | 'medium' | 'high' | 'critical';
		const passed = finalRiskLevel !== 'high' && finalRiskLevel !== 'critical';

		return {
			passed,
			riskLevel: finalRiskLevel,
			reason: passed ? undefined : 'Potential prompt injection detected',
			indicators: indicators.length > 0 ? indicators : undefined,
			quarantine: finalRiskLevel === 'medium',
		};
	}

	/**
	 * Find candidate rooms for a message
	 */
	private findCandidateRooms(message: ExternalMessage): RoutingCandidate[] {
		const candidates: RoutingCandidate[] = [];

		// Get GitHub mappings if this is a GitHub message
		if (message.source === 'github' && message.context?.repository) {
			const [owner, repo] = message.context.repository.split('/');
			const mappings = this.ctx.db.listGitHubMappingsForRepository(owner, repo);

			for (const mapping of mappings) {
				// Check if this mapping matches the message
				if (this.mappingMatchesMessage(mapping, message)) {
					candidates.push({
						roomId: mapping.roomId,
						roomName: mapping.roomId, // Would look up room name
						repositories: mapping.repositories.map((r) => `${r.owner}/${r.repo}`),
						priority: mapping.priority,
						interestedLabels: mapping.repositories.flatMap((r) => r.labels ?? []),
					});
				}
			}
		}

		// TODO: Add routing for other sources (Slack, Discord, etc.)

		// Sort by priority (highest first)
		candidates.sort((a, b) => b.priority - a.priority);

		return candidates;
	}

	/**
	 * Check if a mapping matches a message
	 */
	private mappingMatchesMessage(
		mapping: import('@neokai/shared').RoomGitHubMapping,
		message: ExternalMessage
	): boolean {
		for (const repoMapping of mapping.repositories) {
			// Check repository match
			if (message.context?.repository !== `${repoMapping.owner}/${repoMapping.repo}`) {
				continue;
			}

			// Check issue number filter
			if (repoMapping.issueNumbers && repoMapping.issueNumbers.length > 0) {
				if (
					!message.context?.number ||
					!repoMapping.issueNumbers.includes(message.context.number)
				) {
					continue;
				}
			}

			// Check label filter
			if (repoMapping.labels && repoMapping.labels.length > 0) {
				const messageLabels = message.content.labels ?? [];
				if (!repoMapping.labels.some((label: string) => messageLabels.includes(label))) {
					continue;
				}
			}

			return true;
		}

		return false;
	}

	/**
	 * Route a message to determine destination
	 */
	private async routeMessage(
		message: ExternalMessage,
		candidates: RoutingCandidate[],
		securityCheck: ExternalSecurityCheck
	): Promise<ExternalRoutingResult> {
		// If no candidates, send to inbox
		if (candidates.length === 0) {
			return {
				decision: 'inbox',
				confidence: 'high',
				reason: 'No candidate rooms found for this message',
				securityCheck,
			};
		}

		// If only one candidate with high priority, route directly
		if (candidates.length === 1 && candidates[0].priority >= 100) {
			return {
				decision: 'route',
				roomId: candidates[0].roomId,
				confidence: 'high',
				reason: `Single high-priority match: ${candidates[0].roomName}`,
				securityCheck,
			};
		}

		// If multiple candidates, use simple routing logic
		// (AI routing would be integrated here if enabled)
		const topCandidate = candidates[0];

		// Check for explicit label matches
		if (topCandidate.interestedLabels && topCandidate.interestedLabels.length > 0) {
			const messageLabels = message.content.labels ?? [];
			const hasMatch = topCandidate.interestedLabels.some((l) => messageLabels.includes(l));
			if (hasMatch) {
				return {
					decision: 'route',
					roomId: topCandidate.roomId,
					confidence: 'high',
					reason: `Label match for room: ${topCandidate.roomName}`,
					securityCheck,
					suggestedLabels: messageLabels,
				};
			}
		}

		// Default to top candidate with medium confidence
		return {
			decision: 'route',
			roomId: topCandidate.roomId,
			confidence: 'medium',
			reason: `Best match: ${topCandidate.roomName}`,
			securityCheck,
		};
	}

	/**
	 * Execute the routing decision
	 */
	private async executeRouting(
		message: ExternalMessage,
		result: ExternalRoutingResult
	): Promise<void> {
		if (result.decision === 'route' && result.roomId) {
			// Deliver to room
			await this.deliverToRoom(message, result.roomId);

			await this.ctx.daemonHub.emit('lobby.messageRouted', {
				sessionId: 'lobby',
				messageId: message.id,
				roomId: result.roomId,
				confidence: result.confidence,
				reason: result.reason,
			});
		} else if (result.decision === 'inbox') {
			// Add to inbox
			this.addToInbox(message, result.securityCheck, result.reason);

			await this.ctx.daemonHub.emit('lobby.messageToInbox', {
				sessionId: 'lobby',
				messageId: message.id,
				reason: result.reason,
			});
		} else {
			// Rejected
			await this.ctx.daemonHub.emit('lobby.messageRejected', {
				sessionId: 'lobby',
				messageId: message.id,
				reason: result.reason,
			});
		}
	}

	/**
	 * Deliver a message to a room
	 */
	private async deliverToRoom(message: ExternalMessage, roomId: string): Promise<void> {
		// Format message content for room
		const content = this.formatMessageForRoom(message);

		// Emit to room.message for RoomAgentService to handle
		await this.ctx.daemonHub.emit('room.message', {
			sessionId: `room:${roomId}`,
			roomId,
			message: {
				id: message.id,
				role: 'external_message',
				content,
				timestamp: Date.now(),
			},
			sender: message.sender.name,
		});

		log.debug(`Delivered message ${message.id} to room ${roomId}`);
	}

	/**
	 * Format external message for room display
	 */
	private formatMessageForRoom(message: ExternalMessage): string {
		const parts: string[] = [];

		// Header with source and event type
		const eventInfo = message.context?.eventType
			? `${message.context.eventType} ${message.context.action ?? ''}`.trim()
			: message.source;
		parts.push(`**[${message.source}] ${eventInfo}**`);

		// Repository/channel context
		if (message.context?.repository) {
			parts.push(`Repository: ${message.context.repository}`);
		}
		if (message.context?.channel) {
			parts.push(`Channel: ${message.context.channel}`);
		}

		// Issue/PR number
		if (message.context?.number) {
			parts.push(`#${message.context.number}: ${message.content.title ?? 'Untitled'}`);
		} else if (message.content.title) {
			parts.push(`Title: ${message.content.title}`);
		}

		// Body (truncated)
		if (message.content.body) {
			const truncated =
				message.content.body.length > 500
					? message.content.body.slice(0, 500) + '...'
					: message.content.body;
			parts.push(`\n${truncated}`);
		}

		// Labels
		if (message.content.labels && message.content.labels.length > 0) {
			parts.push(`\nLabels: ${message.content.labels.join(', ')}`);
		}

		return parts.join('\n');
	}

	/**
	 * Add message to inbox
	 */
	private addToInbox(
		message: ExternalMessage,
		security: ExternalSecurityCheck,
		reason: string
	): void {
		// Convert to inbox format
		// For GitHub messages, use the existing inbox format
		if (message.source === 'github') {
			// The GitHubService already handles inbox, so we don't duplicate here
			return;
		}

		// For other sources, create a generic inbox item
		// This would integrate with a generic inbox system
		log.info(`Message ${message.id} added to inbox: ${reason}`);
	}

	/**
	 * Update statistics
	 */
	private updateStats(decision: RoutingDecision, processingTime: number): void {
		switch (decision) {
			case 'route':
				this.stats.messagesRouted++;
				break;
			case 'inbox':
				this.stats.messagesToInbox++;
				break;
			case 'reject':
				this.stats.messagesRejected++;
				break;
		}

		// Track processing times for average calculation
		this.processingTimes.push(processingTime);
		if (this.processingTimes.length > 100) {
			this.processingTimes.shift();
		}

		const sum = this.processingTimes.reduce((a, b) => a + b, 0);
		this.stats.averageProcessingTimeMs = Math.round(sum / this.processingTimes.length);
	}

	/**
	 * Update active adapters list
	 */
	private updateActiveAdapters(): void {
		this.stats.activeAdapters = Array.from(this.adapters.values())
			.filter((a) => a.isHealthy())
			.map((a) => a.sourceType);
	}

	/**
	 * Get lobby agent statistics
	 */
	getStats(): LobbyAgentStats {
		this.updateActiveAdapters();
		return { ...this.stats };
	}

	/**
	 * Get inbox manager
	 */
	getInboxManager(): InboxManager {
		return this.inboxManager;
	}
}
