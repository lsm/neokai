/**
 * SlashCommandManager - Manages slash command caching
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Fetching slash commands from SDK
 * - Caching and persisting to database
 * - Combining SDK commands with built-in commands
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session } from '@neokai/shared';
import type { SlashCommand } from '@neokai/shared/sdk';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { Logger } from '../logger';
import { getBuiltInCommandNames } from '../built-in-commands';

/**
 * Context interface - what SlashCommandManager needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface SlashCommandManagerContext {
	readonly session: Session;
	readonly db: Database;
	readonly daemonHub: DaemonHub;
	readonly logger: Logger;

	// SDK state
	readonly queryObject: Query | null;
}

/**
 * Manages slash command fetching and caching
 */
export class SlashCommandManager {
	private slashCommands: string[] = [];
	private commandsFetchedFromSDK = false;

	constructor(private ctx: SlashCommandManagerContext) {
		// Restore from session if available
		if (ctx.session.availableCommands && ctx.session.availableCommands.length > 0) {
			this.slashCommands = ctx.session.availableCommands;
		}
	}

	/**
	 * Get available slash commands
	 */
	async getSlashCommands(): Promise<string[]> {
		const { logger, queryObject } = this.ctx;

		// Return cached commands if available
		if (this.slashCommands.length > 0) {
			// Fire-and-forget: refresh from SDK in background
			if (!this.commandsFetchedFromSDK && queryObject) {
				this.fetchAndCache().catch((e) => {
					logger.warn('Background refresh of slash commands failed:', e);
				});
			}
			return this.slashCommands;
		}

		// Try to fetch from SDK
		await this.fetchAndCache();

		// Fallback to built-in commands
		if (this.slashCommands.length === 0) {
			this.slashCommands = getBuiltInCommandNames();
		}

		return this.slashCommands;
	}

	/**
	 * Fetch and cache slash commands from SDK
	 */
	async fetchAndCache(): Promise<void> {
		const { session, db, daemonHub, logger, queryObject } = this.ctx;

		if (!queryObject || typeof queryObject.supportedCommands !== 'function') {
			return;
		}

		if (this.commandsFetchedFromSDK) {
			return;
		}

		try {
			const commands = await queryObject.supportedCommands();
			const commandNames = commands.map((cmd: SlashCommand) => cmd.name);

			// Add SDK built-in commands
			const sdkBuiltInCommands = ['clear', 'help'];
			// Add NeoKai built-in commands
			const kaiBuiltInCommands = getBuiltInCommandNames();
			const allCommands = [
				...new Set([...commandNames, ...sdkBuiltInCommands, ...kaiBuiltInCommands]),
			];

			this.slashCommands = allCommands;
			this.commandsFetchedFromSDK = true;

			// Save to database
			session.availableCommands = this.slashCommands;
			db.updateSession(session.id, { availableCommands: this.slashCommands });

			// Emit event
			await daemonHub.emit('commands.updated', {
				sessionId: session.id,
				commands: this.slashCommands,
			});
		} catch (error) {
			logger.warn('Failed to fetch slash commands:', error);
		}
	}
}
