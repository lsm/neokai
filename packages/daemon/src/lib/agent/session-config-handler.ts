/**
 * SessionConfigHandler - Manages session configuration and metadata updates
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession context directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Session config updates with DB persistence and event broadcasting
 * - Session metadata updates with field-level merging
 * - SettingsManager recreation when workspace changes
 */

import type { Session } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import { SettingsManager } from '../settings-manager';
import { Logger } from '../logger';

/**
 * Context interface - what SessionConfigHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface SessionConfigHandlerContext {
	readonly session: Session;
	readonly db: Database;
	readonly daemonHub: DaemonHub;

	// Mutable settings manager (needs to be recreated when workspace changes)
	settingsManager: SettingsManager;
}

export class SessionConfigHandler {
	private logger: Logger;

	constructor(private ctx: SessionConfigHandlerContext) {
		this.logger = new Logger(`SessionConfigHandler ${ctx.session.id}`);
	}

	/**
	 * Update session configuration
	 *
	 * Merges the provided config updates with existing config,
	 * persists to database, and broadcasts the update event.
	 */
	async updateConfig(configUpdates: Partial<Session['config']>): Promise<void> {
		const { session, db, daemonHub } = this.ctx;

		session.config = { ...session.config, ...configUpdates };
		db.updateSession(session.id, { config: session.config });

		await daemonHub.emit('session.updated', {
			sessionId: session.id,
			source: 'config-update',
			session: { config: session.config },
		});

		this.logger.log('Config updated:', Object.keys(configUpdates).join(', '));
	}

	/**
	 * Update session metadata
	 *
	 * Supports partial updates to various session fields:
	 * - title, workspacePath, status, archivedAt, worktree
	 * - metadata: Merged field-by-field, null/undefined values delete fields
	 * - config: Merged with existing config
	 *
	 * When workspacePath changes, recreates the SettingsManager.
	 */
	updateMetadata(updates: Partial<Session>): void {
		const { session, db } = this.ctx;

		if (updates.title) session.title = updates.title;

		if (updates.workspacePath) {
			session.workspacePath = updates.workspacePath;
			// Recreate settings manager for new workspace
			this.ctx.settingsManager = new SettingsManager(db, updates.workspacePath);
		}

		if (updates.status) session.status = updates.status;

		if (updates.metadata) {
			const mergedMetadata = { ...session.metadata };
			for (const [key, value] of Object.entries(updates.metadata)) {
				if (value === undefined || value === null) {
					delete mergedMetadata[key as keyof typeof mergedMetadata];
				} else {
					(mergedMetadata as Record<string, unknown>)[key] = value;
				}
			}
			session.metadata = mergedMetadata;
		}

		if (updates.config) {
			session.config = { ...session.config, ...updates.config };
		}

		if (updates.archivedAt !== undefined) session.archivedAt = updates.archivedAt;
		if (updates.worktree !== undefined) session.worktree = updates.worktree;

		db.updateSession(session.id, updates);
	}
}
