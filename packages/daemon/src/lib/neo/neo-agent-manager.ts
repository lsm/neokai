/**
 * NeoAgentManager
 *
 * Manages the singleton `neo:global` agent session.
 *
 * Responsibilities:
 * - provision(): Create or re-attach the Neo session on daemon startup.
 *   Includes a startup health-check that destroys and re-provisions stale/
 *   crashed sessions from a previous daemon run.
 * - getSession(): Return the active AgentSession instance.
 * - healthCheck(): Detect crashed or unresponsive sessions and auto-recover.
 * - cleanup(): Gracefully shut down the Neo session.
 *
 * Neo settings (security mode and model) are read from SettingsManager via the
 * `neoSecurityMode` and `neoModel` keys in GlobalSettings.
 */

import type { McpServerConfig } from '@neokai/shared';
import type { AgentSession } from '../agent/agent-session';
import { Logger } from '../logger';
import type { NeoActivityLogger } from './activity-logger';
import { buildNeoSystemPrompt, type NeoSecurityMode } from './neo-system-prompt';
import {
	createNeoToolsMcpServers,
	type NeoToolsConfig,
	type NeoActionToolsConfig,
} from './tools/neo-tools-server';

export const NEO_SESSION_ID = 'neo:global';
const NEO_SESSION_TITLE = 'Neo';

/**
 * Subset of SessionManager used by NeoAgentManager — allows easy mocking in tests.
 */
export interface NeoSessionManager {
	createSession(params: { sessionId: string; sessionType: 'neo'; title: string }): Promise<string>;
	getSessionAsync(sessionId: string): Promise<AgentSession | null>;
	deleteSession(sessionId: string): Promise<void>;
	unregisterSession(sessionId: string): void;
}

/**
 * Subset of SettingsManager used by NeoAgentManager — allows easy mocking in tests.
 */
export interface NeoSettingsManager {
	getGlobalSettings(): { neoSecurityMode?: string; neoModel?: string; model?: string };
}

/**
 * Minimal interface for the AppMcpLifecycleManager — only the surface used by NeoAgentManager.
 */
export interface NeoAppMcpManager {
	getEnabledMcpConfigs(): Record<string, McpServerConfig>;
}

export class NeoAgentManager {
	private readonly logger = new Logger('NeoAgentManager');
	private session: AgentSession | null = null;
	private toolsConfig: NeoToolsConfig | null = null;
	private actionToolsConfig: NeoActionToolsConfig | null = null;
	private appMcpManager: NeoAppMcpManager | null = null;
	private activityLogger: NeoActivityLogger | null = null;

	constructor(
		private readonly sessionManager: NeoSessionManager,
		private readonly settingsManager: NeoSettingsManager
	) {}

	// ============================================================================
	// Public API
	// ============================================================================

	/**
	 * Provision the Neo session.
	 *
	 * Called once at daemon startup. If a session already exists in the DB
	 * (daemon restart), it is re-attached rather than re-created. A startup
	 * health-check runs immediately after re-attach to discard stale/crashed
	 * sessions from the previous daemon run.
	 */
	async provision(): Promise<void> {
		this.logger.info(`Provisioning Neo session (${NEO_SESSION_ID})`);

		// Try to re-attach an existing session from the DB (daemon restart path).
		let agentSession = await this.sessionManager.getSessionAsync(NEO_SESSION_ID);

		if (agentSession) {
			this.logger.info('Re-attached existing Neo session from DB');
			this.session = agentSession;

			// Startup health-check: the previous daemon run may have left the session
			// in an inconsistent state (in-flight queries, corrupted state, etc.).
			// If unhealthy, destroy and re-provision.
			const healthy = await this.healthCheck({ source: 'startup' });
			if (!healthy) {
				this.logger.info('Startup health-check failed — re-provisioning Neo session');
				await this.destroyAndRecreate();
			}
		} else {
			// First run — create the session.
			try {
				await this.sessionManager.createSession({
					sessionId: NEO_SESSION_ID,
					sessionType: 'neo',
					title: NEO_SESSION_TITLE,
				});
				this.logger.info('Created new Neo session');
			} catch (error) {
				this.logger.error('Failed to create Neo session:', error);
				throw error;
			}

			agentSession = await this.sessionManager.getSessionAsync(NEO_SESSION_ID);
			if (!agentSession) {
				throw new Error(`Failed to get AgentSession for ${NEO_SESSION_ID} after creation`);
			}
			this.session = agentSession;
		}

		// Apply runtime configuration (system prompt, model).
		this.applyRuntimeConfig();

		// Enforce activity log retention policy on each provision cycle.
		this.activityLogger?.pruneOldEntries();

		this.logger.info('Neo session provisioned');
	}

	/**
	 * Return the active AgentSession, or null if not yet provisioned.
	 */
	getSession(): AgentSession | null {
		return this.session;
	}

	/**
	 * Wire in the query tools dependencies and optional MCP registry manager.
	 *
	 * Must be called before `provision()`. When set, `provision()` will create the
	 * neo-query MCP server and attach it to the session alongside any registry-sourced
	 * servers from AppMcpLifecycleManager (same pattern as provisionGlobalSpacesAgent).
	 *
	 * @param toolsConfig  All dependencies needed by createNeoQueryMcpServer().
	 * @param appMcpManager  Optional registry manager; when provided, its globally-enabled
	 *   servers are merged in. The in-process neo-query server always wins on collision.
	 */
	setToolsConfig(toolsConfig: NeoToolsConfig, appMcpManager?: NeoAppMcpManager): void {
		this.toolsConfig = toolsConfig;
		this.appMcpManager = appMcpManager ?? null;
	}

	/**
	 * Wire in the action tools dependencies.
	 *
	 * Must be called before `provision()`. When set, `provision()` will create the
	 * neo-action MCP server and attach it alongside the neo-query server.
	 *
	 * @param actionToolsConfig  All dependencies needed by createNeoActionMcpServer().
	 */
	setActionToolsConfig(actionToolsConfig: NeoActionToolsConfig): void {
		this.actionToolsConfig = actionToolsConfig;
		// Propagate activity logger if already set (order-independent wiring).
		if (this.activityLogger) {
			this.actionToolsConfig.activityLogger = this.activityLogger;
		}
	}

	/**
	 * Wire in the activity logger.
	 *
	 * Must be called before `provision()`. When set, the activity logger is made
	 * available to the action tools config (for tool-call logging) and its
	 * `pruneOldEntries()` is called during provision and health-check cycles to
	 * enforce the 30-day / 10 000-row retention policy.
	 */
	setActivityLogger(activityLogger: NeoActivityLogger): void {
		this.activityLogger = activityLogger;
		// Propagate to action tools config if already set (order-independent wiring).
		if (this.actionToolsConfig) {
			this.actionToolsConfig.activityLogger = activityLogger;
		}
	}

	/**
	 * Health-check the Neo session.
	 *
	 * Detects:
	 * - No active session in memory (null).
	 * - Session that has been stopped or is in an error/corrupted state.
	 * - In-flight queries from a previous run that will never complete.
	 *
	 * Returns `true` if the session is healthy, `false` otherwise.
	 * When called with `source: 'runtime'`, auto-recovers on failure.
	 *
	 * @param opts.source - 'startup' (called from provision) or 'runtime' (called before neo.send).
	 */
	async healthCheck(
		opts: { source: 'startup' | 'runtime' } = { source: 'runtime' }
	): Promise<boolean> {
		if (!this.session) {
			this.logger.warn(`[healthCheck:${opts.source}] No session in memory`);
			if (opts.source === 'runtime') {
				await this.destroyAndRecreate();
			}
			return false;
		}

		// Check for in-flight queries that will never complete (leftover from a crash).
		// If queryPromise is set but queryObject is null the session is in a stuck state.
		const processingState = this.session.getProcessingState();
		const isStuck =
			processingState.status === 'processing' &&
			this.session.queryPromise !== null &&
			this.session.queryObject === null;

		if (isStuck) {
			this.logger.warn(
				`[healthCheck:${opts.source}] Session has stuck in-flight query — marking unhealthy`
			);
			if (opts.source === 'runtime') {
				await this.destroyAndRecreate();
			}
			return false;
		}

		// Check for sessions that errored out and are no longer accepting messages.
		// A stopped AgentSession sets its internal cleanup flag which prevents future queries.
		if (this.session.isCleaningUp()) {
			this.logger.warn(`[healthCheck:${opts.source}] Session is cleaning up — marking unhealthy`);
			if (opts.source === 'runtime') {
				await this.destroyAndRecreate();
			}
			return false;
		}

		return true;
	}

	/**
	 * Clear the current Neo session and start a fresh one.
	 *
	 * Used by the `neo.clearSession` RPC handler. Delegates to
	 * `destroyAndRecreate()` which is atomic: if re-creation fails, the error
	 * propagates to the caller (the session is not left in a half-destroyed
	 * state — `destroyAndRecreate` will throw before returning).
	 */
	async clearSession(): Promise<void> {
		this.logger.info('Clearing Neo session on user request');
		await this.destroyAndRecreate();
	}

	/**
	 * Gracefully shut down the Neo session.
	 *
	 * Called during daemon shutdown. Delegates to AgentSession.cleanup().
	 */
	async cleanup(): Promise<void> {
		if (!this.session) return;

		this.logger.info('Cleaning up Neo session');
		try {
			await this.session.cleanup();
		} catch (error) {
			this.logger.error('Error during Neo session cleanup:', error);
		}
		this.session = null;
	}

	// ============================================================================
	// Settings accessors
	// ============================================================================

	/**
	 * Return the active Neo security mode from GlobalSettings.
	 * Defaults to 'balanced' if not set.
	 */
	getSecurityMode(): NeoSecurityMode {
		const settings = this.settingsManager.getGlobalSettings();
		const mode = settings.neoSecurityMode;
		if (mode === 'conservative' || mode === 'balanced' || mode === 'autonomous') {
			return mode;
		}
		return 'balanced';
	}

	/**
	 * Return the Neo-specific model from GlobalSettings.
	 * Falls back to the global default model, then to 'sonnet'.
	 */
	getModel(): string {
		const settings = this.settingsManager.getGlobalSettings();
		return settings.neoModel ?? settings.model ?? 'sonnet';
	}

	// ============================================================================
	// Internal helpers
	// ============================================================================

	/**
	 * Destroy the current Neo session and create a fresh one.
	 *
	 * Recovery flow:
	 * 1. Stop any in-flight SDK queries (cleanup).
	 * 2. Unregister the session from the session cache.
	 * 3. Delete the session from DB.
	 * 4. Create a fresh session and re-attach.
	 */
	private async destroyAndRecreate(): Promise<void> {
		this.logger.info('Destroying and re-creating Neo session');

		// Step 1: Stop any in-flight SDK queries.
		if (this.session) {
			try {
				await this.session.cleanup();
			} catch (error) {
				this.logger.warn('Error cleaning up stale Neo session (ignoring):', error);
			}
			this.session = null;
		}

		// Step 2 & 3: Unregister from cache and delete from DB.
		this.sessionManager.unregisterSession(NEO_SESSION_ID);
		try {
			await this.sessionManager.deleteSession(NEO_SESSION_ID);
		} catch (error) {
			this.logger.warn('Error deleting stale Neo session from DB (ignoring):', error);
		}

		// Step 4: Create a fresh session.
		await this.sessionManager.createSession({
			sessionId: NEO_SESSION_ID,
			sessionType: 'neo',
			title: NEO_SESSION_TITLE,
		});

		const agentSession = await this.sessionManager.getSessionAsync(NEO_SESSION_ID);
		if (!agentSession) {
			throw new Error(`Failed to get AgentSession for ${NEO_SESSION_ID} after recovery`);
		}
		this.session = agentSession;
		this.applyRuntimeConfig();
		this.logger.info('Neo session re-created successfully');
	}

	/**
	 * Apply runtime configuration to the current session.
	 *
	 * Sets the system prompt (based on the active security mode), the model
	 * override from settings, and — when toolsConfig has been provided via
	 * setToolsConfig() — the neo-query MCP server merged with any registry-
	 * sourced servers. All values are in-memory only (not persisted to DB).
	 */
	private applyRuntimeConfig(): void {
		if (!this.session) return;

		const securityMode = this.getSecurityMode();
		const systemPromptText = buildNeoSystemPrompt(securityMode);
		this.session.setRuntimeSystemPrompt(systemPromptText);

		const model = this.getModel();
		this.session.setRuntimeModel(model);

		this.attachTools();
	}

	/**
	 * Attach the neo-query and (when available) neo-action MCP servers to the
	 * current session, merged with any globally-enabled registry servers from
	 * AppMcpLifecycleManager.
	 *
	 * Mirrors the pattern used in provisionGlobalSpacesAgent():
	 *   - Registry servers loaded from appMcpManager (if set).
	 *   - In-process servers ('neo-query', 'neo-action') always win on name collision.
	 *   - No subscription to mcp.registry.changed — registry changes take effect
	 *     on the next daemon restart (consistent with the global spaces agent).
	 *
	 * No-op when toolsConfig has not been set via setToolsConfig().
	 */
	private attachTools(): void {
		if (!this.session || !this.toolsConfig) return;

		const inProcessServers = createNeoToolsMcpServers(
			this.toolsConfig,
			this.actionToolsConfig ?? undefined
		);
		const registryMcpServers = this.appMcpManager?.getEnabledMcpConfigs() ?? {};

		for (const name of Object.keys(registryMcpServers)) {
			if (name in inProcessServers) {
				this.logger.warn(
					`Neo: MCP server name collision on '${name}' — ` +
						`in-process server takes precedence over registry entry.`
				);
			}
		}

		this.session.setRuntimeMcpServers({
			...registryMcpServers,
			...inProcessServers,
		});
	}
}
