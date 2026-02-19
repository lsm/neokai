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
	RecurringJob,
	RoomAgentState,
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
import {
	RecurringJobRepository,
	type CreateRecurringJobParams,
	type UpdateRecurringJobParams,
} from './repositories/recurring-job-repository';
import {
	RoomAgentStateRepository,
	type CreateRoomAgentStateParams,
	type UpdateRoomAgentStateParams,
} from './repositories/room-agent-state-repository';

export type { SendStatus } from './repositories/sdk-message-repository';
export type { SQLiteValue } from './types';
export type { CreateInboxItemParams, InboxItemFilter } from './repositories/inbox-item-repository';
export type { CreateGoalParams, UpdateGoalParams } from './repositories/goal-repository';
export type {
	CreateRecurringJobParams,
	UpdateRecurringJobParams,
} from './repositories/recurring-job-repository';
export type {
	CreateRoomAgentStateParams,
	UpdateRoomAgentStateParams,
} from './repositories/room-agent-state-repository';

// @public - Library export
// Re-export repository classes for direct use
export { GoalRepository } from './repositories/goal-repository';
// @public - Library export
export { RecurringJobRepository } from './repositories/recurring-job-repository';
// @public - Library export
export { RoomAgentStateRepository } from './repositories/room-agent-state-repository';

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
	private recurringJobRepo!: RecurringJobRepository;
	private roomAgentStateRepo!: RoomAgentStateRepository;

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
		this.recurringJobRepo = new RecurringJobRepository(db);
		this.roomAgentStateRepo = new RoomAgentStateRepository(db);
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
	// Recurring Job operations (delegated to RecurringJobRepository)
	// ============================================================================

	createRecurringJob(params: CreateRecurringJobParams): RecurringJob {
		return this.recurringJobRepo.createJob(params);
	}

	getRecurringJob(id: string): RecurringJob | null {
		return this.recurringJobRepo.getJob(id);
	}

	listRecurringJobs(roomId: string, enabledOnly?: boolean): RecurringJob[] {
		return this.recurringJobRepo.listJobs(roomId, enabledOnly);
	}

	getAllEnabledRecurringJobs(): RecurringJob[] {
		return this.recurringJobRepo.getAllEnabledJobs();
	}

	getDueRecurringJobs(now?: number): RecurringJob[] {
		return this.recurringJobRepo.getDueJobs(now);
	}

	updateRecurringJob(id: string, params: UpdateRecurringJobParams): RecurringJob | null {
		return this.recurringJobRepo.updateJob(id, params);
	}

	markRecurringJobRun(id: string, nextRunAt: number): RecurringJob | null {
		return this.recurringJobRepo.markJobRun(id, nextRunAt);
	}

	enableRecurringJob(id: string): RecurringJob | null {
		return this.recurringJobRepo.enableJob(id);
	}

	disableRecurringJob(id: string): RecurringJob | null {
		return this.recurringJobRepo.disableJob(id);
	}

	deleteRecurringJob(id: string): boolean {
		return this.recurringJobRepo.deleteJob(id);
	}

	// ============================================================================
	// Room Agent State operations (delegated to RoomAgentStateRepository)
	// ============================================================================

	createRoomAgentState(params: CreateRoomAgentStateParams): RoomAgentState {
		return this.roomAgentStateRepo.createState(params);
	}

	getRoomAgentState(roomId: string): RoomAgentState | null {
		return this.roomAgentStateRepo.getState(roomId);
	}

	getOrCreateRoomAgentState(roomId: string): RoomAgentState {
		return this.roomAgentStateRepo.getOrCreateState(roomId);
	}

	updateRoomAgentState(roomId: string, params: UpdateRoomAgentStateParams): RoomAgentState | null {
		return this.roomAgentStateRepo.updateState(roomId, params);
	}

	transitionRoomAgentState(
		roomId: string,
		newState: import('@neokai/shared').RoomAgentLifecycleState
	): RoomAgentState | null {
		return this.roomAgentStateRepo.transitionTo(roomId, newState);
	}

	recordRoomAgentError(roomId: string, error: string): RoomAgentState | null {
		return this.roomAgentStateRepo.recordError(roomId, error);
	}

	clearRoomAgentError(roomId: string): RoomAgentState | null {
		return this.roomAgentStateRepo.clearError(roomId);
	}

	addActiveSessionPair(roomId: string, pairId: string): RoomAgentState | null {
		return this.roomAgentStateRepo.addActiveSessionPair(roomId, pairId);
	}

	removeActiveSessionPair(roomId: string, pairId: string): RoomAgentState | null {
		return this.roomAgentStateRepo.removeActiveSessionPair(roomId, pairId);
	}

	deleteRoomAgentState(roomId: string): boolean {
		return this.roomAgentStateRepo.deleteState(roomId);
	}

	getAllRoomAgentStates(): RoomAgentState[] {
		return this.roomAgentStateRepo.getAllStates();
	}

	getRoomAgentStatesByLifecycle(
		lifecycleState: import('@neokai/shared').RoomAgentLifecycleState
	): RoomAgentState[] {
		return this.roomAgentStateRepo.getStatesByLifecycle(lifecycleState);
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
	 * Get the recurring job repository
	 * Used by RecurringJobScheduler for direct access to jobs
	 */
	getRecurringJobRepo(): RecurringJobRepository {
		return this.recurringJobRepo;
	}

	/**
	 * Get the room agent state repository
	 * Used by RoomAgentService for direct access to agent states
	 */
	getRoomAgentStateRepo(): RoomAgentStateRepository {
		return this.roomAgentStateRepo;
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
