/**
 * SlashCommandManager - Manages slash command caching
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - Fetching slash commands from SDK
 * - Caching and persisting to database
 * - Combining SDK commands with built-in commands
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session } from '@liuboer/shared';
import type { SlashCommand } from '@liuboer/shared/sdk';
import type { DaemonHub } from '../daemon-hub';
import { Database } from '../../storage/database';
import { Logger } from '../logger';
import { getBuiltInCommandNames } from '../built-in-commands';

/**
 * Dependencies required for SlashCommandManager
 */
export interface SlashCommandManagerDependencies {
	session: Session;
	db: Database;
	daemonHub: DaemonHub;
	logger: Logger;

	// State accessor
	getQueryObject: () => Query | null;
}

/**
 * Manages slash command fetching and caching
 */
export class SlashCommandManager {
	private deps: SlashCommandManagerDependencies;
	private slashCommands: string[] = [];
	private commandsFetchedFromSDK = false;

	constructor(deps: SlashCommandManagerDependencies) {
		this.deps = deps;

		// Restore from session if available
		if (deps.session.availableCommands && deps.session.availableCommands.length > 0) {
			this.slashCommands = deps.session.availableCommands;
			deps.logger.log(`Restored ${this.slashCommands.length} slash commands from session data`);
		}
	}

	/**
	 * Get available slash commands
	 */
	async getSlashCommands(): Promise<string[]> {
		const { logger } = this.deps;

		// Return cached commands if available
		if (this.slashCommands.length > 0) {
			// Fire-and-forget: refresh from SDK in background
			if (!this.commandsFetchedFromSDK && this.deps.getQueryObject()) {
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
		const { session, db, daemonHub, logger } = this.deps;
		const queryObject = this.deps.getQueryObject();

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
			// Add Liuboer built-in commands
			const liuboerBuiltInCommands = getBuiltInCommandNames();
			const allCommands = [
				...new Set([...commandNames, ...sdkBuiltInCommands, ...liuboerBuiltInCommands]),
			];

			this.slashCommands = allCommands;
			this.commandsFetchedFromSDK = true;

			logger.log(`Fetched ${this.slashCommands.length} slash commands from SDK`);

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
