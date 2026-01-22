/**
 * SDKRuntimeConfig - Runtime SDK configuration management
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - setMaxThinkingTokens - Adjust thinking tokens at runtime
 * - setPermissionMode - Change permission mode
 * - getMcpServerStatus - Get MCP server status
 * - updateToolsConfig - Update tools configuration with restart
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session } from '@liuboer/shared';
import type { DaemonHub } from '../daemon-hub';
import { Database } from '../../storage/database';
import { Logger } from '../logger';
import type { SettingsManager } from '../settings-manager';
import type { MessageQueue } from './message-queue';

/**
 * Dependencies required for SDKRuntimeConfig
 */
export interface SDKRuntimeConfigDependencies {
	session: Session;
	db: Database;
	daemonHub: DaemonHub;
	settingsManager: SettingsManager;
	messageQueue: MessageQueue;
	logger: Logger;

	// State accessors
	getQueryObject: () => Query | null;
	isTransportReady: () => boolean;
	restartQuery: () => Promise<void>;
}

/**
 * Result of a config update operation
 */
interface ConfigUpdateResult {
	success: boolean;
	error?: string;
}

/**
 * MCP server status entry
 */
interface McpServerStatus {
	name: string;
	status: string;
	error?: string;
}

/**
 * Manages SDK runtime configuration
 */
export class SDKRuntimeConfig {
	private deps: SDKRuntimeConfigDependencies;

	constructor(deps: SDKRuntimeConfigDependencies) {
		this.deps = deps;
	}

	/**
	 * Set max thinking tokens at runtime
	 */
	async setMaxThinkingTokens(tokens: number | null): Promise<ConfigUpdateResult> {
		const { session, db, daemonHub, logger } = this.deps;

		logger.log(`Setting max thinking tokens to: ${tokens}`);

		try {
			const queryObject = this.deps.getQueryObject();
			const transportReady = this.deps.isTransportReady();

			// If query not running or transport not ready, just update config
			if (!queryObject || !transportReady) {
				session.config.maxThinkingTokens = tokens;
				db.updateSession(session.id, { config: session.config });
				logger.log('Max thinking tokens saved to config (query not active)');
				return { success: true };
			}

			// Use SDK's native method
			if ('setMaxThinkingTokens' in queryObject) {
				await (
					queryObject as Query & { setMaxThinkingTokens: (t: number | null) => Promise<void> }
				).setMaxThinkingTokens(tokens);
			}

			// Update config
			session.config.maxThinkingTokens = tokens;
			db.updateSession(session.id, { config: session.config });

			// Emit event for UI update
			await daemonHub.emit('session.updated', {
				sessionId: session.id,
				source: 'thinking-tokens',
				session: { config: session.config },
			});

			logger.log('Max thinking tokens set successfully');
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error('Failed to set max thinking tokens:', error);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Set permission mode at runtime
	 */
	async setPermissionMode(mode: string): Promise<ConfigUpdateResult> {
		const { session, db, daemonHub, logger } = this.deps;

		logger.log(`Setting permission mode to: ${mode}`);

		try {
			const queryObject = this.deps.getQueryObject();
			const transportReady = this.deps.isTransportReady();

			// If query not running or transport not ready, just update config
			if (!queryObject || !transportReady) {
				session.config.permissionMode = mode as Session['config']['permissionMode'];
				db.updateSession(session.id, { config: session.config });
				logger.log('Permission mode saved to config (query not active)');
				return { success: true };
			}

			// Use SDK's native method
			if ('setPermissionMode' in queryObject) {
				await (
					queryObject as Query & { setPermissionMode: (m: string) => Promise<void> }
				).setPermissionMode(mode);
			}

			// Update config
			session.config.permissionMode = mode as Session['config']['permissionMode'];
			db.updateSession(session.id, { config: session.config });

			// Emit event for UI update
			await daemonHub.emit('session.updated', {
				sessionId: session.id,
				source: 'permission-mode',
				session: { config: session.config },
			});

			logger.log('Permission mode set successfully');
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error('Failed to set permission mode:', error);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Get MCP server status from SDK
	 */
	async getMcpServerStatus(): Promise<McpServerStatus[]> {
		const { logger } = this.deps;
		const queryObject = this.deps.getQueryObject();
		const transportReady = this.deps.isTransportReady();

		if (!queryObject || !transportReady) {
			return [];
		}

		try {
			if ('mcpServerStatus' in queryObject) {
				const status = await (
					queryObject as Query & { mcpServerStatus: () => Promise<unknown[]> }
				).mcpServerStatus();
				return status as McpServerStatus[];
			}
			return [];
		} catch (error) {
			logger.warn('Failed to get MCP server status:', error);
			return [];
		}
	}

	/**
	 * Update tools configuration and restart query to apply changes
	 */
	async updateToolsConfig(tools: Session['config']['tools']): Promise<ConfigUpdateResult> {
		const { session, db, daemonHub, settingsManager, messageQueue, logger } = this.deps;

		try {
			logger.log('Updating tools config:', tools);

			// 1. Update session config in memory and DB
			const newConfig = { ...session.config, tools };
			session.config = newConfig;
			db.updateSession(session.id, { config: newConfig });

			// 2. Write MCP settings to .claude/settings.local.json
			if (tools?.disabledMcpServers !== undefined) {
				logger.log('Writing disabledMcpServers to settings.local.json:', tools.disabledMcpServers);
				await settingsManager.setDisabledMcpServers(tools.disabledMcpServers);

				// Restart query to reload MCP settings
				await this.deps.restartQuery();
			}

			// 3. Queue /context to get updated context breakdown
			if (messageQueue.isRunning()) {
				try {
					logger.log('Queuing /context for updated context breakdown...');
					await messageQueue.enqueue('/context', true);
				} catch (contextError) {
					logger.warn('Failed to queue /context after tools update:', contextError);
				}
			}

			// 4. Emit event for StateManager
			await daemonHub.emit('session.updated', {
				sessionId: session.id,
				source: 'config',
				session: { config: session.config },
			});

			logger.log('Tools config updated successfully');
			return { success: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.error('Failed to update tools config:', error);
			return { success: false, error: errorMessage };
		}
	}
}
