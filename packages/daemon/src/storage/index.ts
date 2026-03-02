/**
 * Database Facade
 *
 * Re-exports for backward compatibility.
 * The Database class composes all repositories and maintains the exact same public API.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import type {
	Session,
	GlobalToolsConfig,
	GlobalSettings,
	RoomGitHubMapping,
	InboxItem,
	RoomGoal,
} from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { DatabaseCore } from './database-core';
import { SessionRepository } from './repositories/session-repository';
import { SDKMessageRepository, type SendStatus } from './repositories/sdk-message-repository';
import { SettingsRepository } from './repositories/settings-repository';
import { GitHubMappingRepository } from './repositories/github-mapping-repository';
import {
	InboxItemRepository,
	type CreateInboxItemParams,
	type InboxItemFilter,
} from './repositories/inbox-item-repository';
import {
	GoalRepository,
	type CreateGoalParams,
	type UpdateGoalParams,
} from './repositories/goal-repository';
import { JobQueueRepository } from './repositories/job-queue-repository';

export type { SendStatus } from './repositories/sdk-message-repository';
export type { SQLiteValue } from './types';
export type { CreateInboxItemParams, InboxItemFilter } from './repositories/inbox-item-repository';
export type { CreateGoalParams, UpdateGoalParams } from './repositories/goal-repository';
export type { Job, EnqueueParams } from './repositories/job-queue-repository';
export { JobQueueProcessor } from './job-queue-processor';
export type { JobHandler, JobQueueProcessorOptions } from './job-queue-processor';

// @public - Library export
// Re-export repository classes for direct use
export { GoalRepository } from './repositories/goal-repository';

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
	private githubMappingRepo!: GitHubMappingRepository;
	private inboxItemRepo!: InboxItemRepository;
	private goalRepo!: GoalRepository;
	private jobQueueRepo!: JobQueueRepository;

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
		this.githubMappingRepo = new GitHubMappingRepository(db);
		this.inboxItemRepo = new InboxItemRepository(db);
		this.goalRepo = new GoalRepository(db);
		this.jobQueueRepo = new JobQueueRepository(db);
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

	listSessions(options?: { status?: string; includeArchived?: boolean }): Session[] {
		return this.sessionRepo.listSessions(options);
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

	getSDKMessages(
		sessionId: string,
		limit?: number,
		before?: number,
		since?: number
	): { messages: SDKMessage[]; hasMore: boolean } {
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

	updateMessageTimestamp(messageId: string, timestampMs?: number): void {
		this.sdkMessageRepo.updateMessageTimestamp(messageId, timestampMs);
	}

	getMessageCountByStatus(sessionId: string, status: SendStatus): number {
		return this.sdkMessageRepo.getMessageCountByStatus(sessionId, status);
	}

	deleteMessagesAfter(sessionId: string, afterTimestamp: number): number {
		return this.sdkMessageRepo.deleteMessagesAfter(sessionId, afterTimestamp);
	}

	deleteMessagesAtAndAfter(sessionId: string, atTimestamp: number): number {
		return this.sdkMessageRepo.deleteMessagesAtAndAfter(sessionId, atTimestamp);
	}

	// Rewind feature: get user messages as checkpoints
	getUserMessages(sessionId: string): Array<{ uuid: string; timestamp: number; content: string }> {
		return this.sdkMessageRepo.getUserMessages(sessionId);
	}

	getUserMessageByUuid(
		sessionId: string,
		uuid: string
	): { uuid: string; timestamp: number; content: string } | undefined {
		return this.sdkMessageRepo.getUserMessageByUuid(sessionId, uuid);
	}

	countMessagesAfter(sessionId: string, afterTimestamp: number): number {
		return this.sdkMessageRepo.countMessagesAfter(sessionId, afterTimestamp);
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
	// GitHub Mapping operations (delegated to GitHubMappingRepository)
	// ============================================================================

	createGitHubMapping(params: {
		roomId: string;
		repositories: Array<{
			owner: string;
			repo: string;
			labels?: string[];
			issueNumbers?: number[];
		}>;
		priority?: number;
	}): RoomGitHubMapping {
		return this.githubMappingRepo.createMapping(params);
	}

	getGitHubMapping(id: string): RoomGitHubMapping | null {
		return this.githubMappingRepo.getMapping(id);
	}

	getGitHubMappingByRoomId(roomId: string): RoomGitHubMapping | null {
		return this.githubMappingRepo.getMappingByRoomId(roomId);
	}

	listGitHubMappings(): RoomGitHubMapping[] {
		return this.githubMappingRepo.listMappings();
	}

	listGitHubMappingsForRepository(owner: string, repo: string): RoomGitHubMapping[] {
		return this.githubMappingRepo.listMappingsForRepository(owner, repo);
	}

	updateGitHubMapping(
		id: string,
		params: {
			repositories?: Array<{
				owner: string;
				repo: string;
				labels?: string[];
				issueNumbers?: number[];
			}>;
			priority?: number;
		}
	): RoomGitHubMapping | null {
		return this.githubMappingRepo.updateMapping(id, params);
	}

	deleteGitHubMapping(id: string): void {
		this.githubMappingRepo.deleteMapping(id);
	}

	deleteGitHubMappingByRoomId(roomId: string): void {
		this.githubMappingRepo.deleteMappingByRoomId(roomId);
	}

	// ============================================================================
	// Inbox Item operations (delegated to InboxItemRepository)
	// ============================================================================

	createInboxItem(params: CreateInboxItemParams): InboxItem {
		return this.inboxItemRepo.createItem(params);
	}

	getInboxItem(id: string): InboxItem | null {
		return this.inboxItemRepo.getItem(id);
	}

	listInboxItems(filter?: InboxItemFilter): InboxItem[] {
		return this.inboxItemRepo.listItems(filter);
	}

	listPendingInboxItems(limit?: number): InboxItem[] {
		return this.inboxItemRepo.listPendingItems(limit);
	}

	updateInboxItemStatus(
		id: string,
		status: 'pending' | 'routed' | 'dismissed' | 'blocked',
		routedToRoomId?: string
	): InboxItem | null {
		return this.inboxItemRepo.updateItemStatus(id, status, routedToRoomId);
	}

	dismissInboxItem(id: string): InboxItem | null {
		return this.inboxItemRepo.dismissItem(id);
	}

	routeInboxItem(id: string, roomId: string): InboxItem | null {
		return this.inboxItemRepo.routeItem(id, roomId);
	}

	blockInboxItem(id: string): InboxItem | null {
		return this.inboxItemRepo.blockItem(id);
	}

	deleteInboxItem(id: string): void {
		this.inboxItemRepo.deleteItem(id);
	}

	deleteInboxItemsForRepository(repository: string): number {
		return this.inboxItemRepo.deleteItemsForRepository(repository);
	}

	countInboxItemsByStatus(status: 'pending' | 'routed' | 'dismissed' | 'blocked'): number {
		return this.inboxItemRepo.countByStatus(status);
	}

	// ============================================================================
	// Goal operations (delegated to GoalRepository)
	// ============================================================================

	createGoal(params: CreateGoalParams): RoomGoal {
		return this.goalRepo.createGoal(params);
	}

	getGoal(id: string): RoomGoal | null {
		return this.goalRepo.getGoal(id);
	}

	listGoals(roomId: string, status?: import('@neokai/shared').GoalStatus): RoomGoal[] {
		return this.goalRepo.listGoals(roomId, status);
	}

	updateGoal(id: string, params: UpdateGoalParams): RoomGoal | null {
		return this.goalRepo.updateGoal(id, params);
	}

	deleteGoal(id: string): boolean {
		return this.goalRepo.deleteGoal(id);
	}

	linkTaskToGoal(goalId: string, taskId: string): RoomGoal | null {
		return this.goalRepo.linkTaskToGoal(goalId, taskId);
	}

	unlinkTaskFromGoal(goalId: string, taskId: string): RoomGoal | null {
		return this.goalRepo.unlinkTaskFromGoal(goalId, taskId);
	}

	getGoalsForTask(taskId: string): RoomGoal[] {
		return this.goalRepo.getGoalsForTask(taskId);
	}

	getActiveGoalCount(roomId: string): number {
		return this.goalRepo.getActiveGoalCount(roomId);
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
	 * Get the SDK message repository
	 * Used by SessionBridge for direct access to SDK messages
	 */
	getSDKMessageRepo(): SDKMessageRepository {
		return this.sdkMessageRepo;
	}

	/**
	 * Get the goal repository
	 * Used by GoalManager for direct access to goals
	 */
	getGoalRepo(): GoalRepository {
		return this.goalRepo;
	}

	/**
	 * Get the database file path
	 * Used by background job queues to create their own connections to the same DB file
	 */
	getDatabasePath(): string {
		return this.core.getDbPath();
	}

	/**
	 * Get the job queue repository
	 * Used for generic database-backed job queue operations
	 */
	getJobQueueRepo(): JobQueueRepository {
		return this.jobQueueRepo;
	}

	close(): void {
		this.core.close();
	}
}
