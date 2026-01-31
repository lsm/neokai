/**
 * Database Facade
 *
 * Re-exports for backward compatibility.
 * The Database class composes all repositories and maintains the exact same public API.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import type { Session, GlobalToolsConfig, GlobalSettings } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { DatabaseCore } from './database-core';
import { SessionRepository } from './repositories/session-repository';
import { SDKMessageRepository, type SendStatus } from './repositories/sdk-message-repository';
import { SettingsRepository } from './repositories/settings-repository';
// @knip-ignore
export { runMigrations } from './schema';
// @knip-ignore
export { runMigration12 } from './schema';

// Re-export components for direct access if needed
export { DatabaseCore } from './database-core';
export { SessionRepository } from './repositories/session-repository';
export {
	SDKMessageRepository,
	type SendStatus,
} from './repositories/sdk-message-repository';
export { SettingsRepository } from './repositories/settings-repository';
export type { SQLiteValue } from './types';

/**
 * Database facade class that maintains backward compatibility with the original Database class.
 *
 * This class composes all repositories and delegates method calls to the appropriate repository.
 * All existing consumers can continue using this class without any changes.
 */
export class Database {
	private core: DatabaseCore;
	private sessionRepo!: SessionRepository;
	private sdkMessageRepo!: SDKMessageRepository;
	private settingsRepo!: SettingsRepository;

	constructor(dbPath: string) {
		this.core = new DatabaseCore(dbPath);
	}

	async initialize(): Promise<void> {
		await this.core.initialize();

		// Initialize repositories with the raw BunDatabase instance
		const db = this.core.getDb();
		this.sessionRepo = new SessionRepository(db);
		this.sdkMessageRepo = new SDKMessageRepository(db);
		this.settingsRepo = new SettingsRepository(db);
	}

	// ============================================================================
	// Session operations (delegated to SessionRepository)
	// ============================================================================

	createSession(session: Session): void {
		this.sessionRepo.createSession(session);
	}

	getSession(id: string): Session | null {
		return this.sessionRepo.getSession(id);
	}

	listSessions(): Session[] {
		return this.sessionRepo.listSessions();
	}

	updateSession(id: string, updates: Partial<Session>): void {
		this.sessionRepo.updateSession(id, updates);
	}

	deleteSession(id: string): void {
		this.sessionRepo.deleteSession(id);
	}

	// ============================================================================
	// SDK Message operations (delegated to SDKMessageRepository)
	// ============================================================================

	saveSDKMessage(sessionId: string, message: SDKMessage): boolean {
		return this.sdkMessageRepo.saveSDKMessage(sessionId, message);
	}

	getSDKMessages(sessionId: string, limit = 100, before?: number, since?: number): SDKMessage[] {
		return this.sdkMessageRepo.getSDKMessages(sessionId, limit, before, since);
	}

	getSDKMessagesByType(
		sessionId: string,
		messageType: string,
		messageSubtype?: string,
		limit = 100
	): SDKMessage[] {
		return this.sdkMessageRepo.getSDKMessagesByType(sessionId, messageType, messageSubtype, limit);
	}

	getSDKMessageCount(sessionId: string): number {
		return this.sdkMessageRepo.getSDKMessageCount(sessionId);
	}

	// Message Query Mode operations
	saveUserMessage(sessionId: string, message: SDKMessage, sendStatus: SendStatus = 'sent'): string {
		return this.sdkMessageRepo.saveUserMessage(sessionId, message, sendStatus);
	}

	getMessagesByStatus(
		sessionId: string,
		status: SendStatus
	): Array<SDKMessage & { dbId: string; timestamp: number }> {
		return this.sdkMessageRepo.getMessagesByStatus(sessionId, status);
	}

	updateMessageStatus(messageIds: string[], newStatus: SendStatus): void {
		this.sdkMessageRepo.updateMessageStatus(messageIds, newStatus);
	}

	getMessageCountByStatus(sessionId: string, status: SendStatus): number {
		return this.sdkMessageRepo.getMessageCountByStatus(sessionId, status);
	}

	deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
		return this.sdkMessageRepo.deleteMessagesAfter(sessionId, afterTimestamp);
	}

	// ============================================================================
	// Global Configuration operations (delegated to SettingsRepository)
	// ============================================================================

	getGlobalToolsConfig(): GlobalToolsConfig {
		return this.settingsRepo.getGlobalToolsConfig();
	}

	saveGlobalToolsConfig(config: GlobalToolsConfig): void {
		this.settingsRepo.saveGlobalToolsConfig(config);
	}

	getGlobalSettings(): GlobalSettings {
		return this.settingsRepo.getGlobalSettings();
	}

	saveGlobalSettings(settings: GlobalSettings): void {
		this.settingsRepo.saveGlobalSettings(settings);
	}

	updateGlobalSettings(updates: Partial<GlobalSettings>): GlobalSettings {
		return this.settingsRepo.updateGlobalSettings(updates);
	}

	// ============================================================================
	// Core operations (delegated to DatabaseCore)
	// ============================================================================

	/**
	 * Get the underlying Bun SQLite database instance
	 * Used by background job queues (e.g., liteque) that need direct DB access
	 */
	getDatabase(): BunDatabase {
		return this.core.getDb();
	}

	/**
	 * Get the database file path
	 * Used by background job queues to create their own connections to the same DB file
	 */
	getDatabasePath(): string {
		return this.core.getDbPath();
	}

	close(): void {
		this.core.close();
	}
}
