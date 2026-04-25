/**
 * Automation System Types
 *
 * Automations are long-lived definitions for scheduled or continuous work.
 * Automation runs are the append-only ledger entries created when a definition fires.
 */

export type AutomationOwnerType = 'room' | 'space' | 'global';

export type AutomationStatus = 'active' | 'paused' | 'archived';

export type AutomationTriggerType = 'cron' | 'at' | 'interval' | 'heartbeat' | 'event' | 'manual';

export type AutomationTargetType =
	| 'room_task'
	| 'room_mission'
	| 'space_task'
	| 'space_workflow'
	| 'neo_agent'
	| 'job_handler';

export type AutomationConcurrencyPolicy = 'skip' | 'queue' | 'cancel_previous' | 'allow_parallel';

export type AutomationNotifyPolicy = 'silent' | 'done_only' | 'state_changes';

export type AutomationRunStatus =
	| 'queued'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'timed_out'
	| 'cancelled'
	| 'lost';

export interface CronAutomationTriggerConfig {
	expression: string;
	timezone: string;
}

export interface AtAutomationTriggerConfig {
	runAt: number;
	deleteAfterRun?: boolean;
}

export interface IntervalAutomationTriggerConfig {
	intervalMs: number;
}

export interface HeartbeatAutomationTriggerConfig {
	intervalMs?: number;
	scope?: 'owner' | 'global';
}

export interface EventAutomationTriggerConfig {
	eventName: string;
	filters?: Record<string, unknown>;
}

export type ManualAutomationTriggerConfig = Record<string, never>;

export type AutomationTriggerConfig =
	| CronAutomationTriggerConfig
	| AtAutomationTriggerConfig
	| IntervalAutomationTriggerConfig
	| HeartbeatAutomationTriggerConfig
	| EventAutomationTriggerConfig
	| ManualAutomationTriggerConfig;

export interface AlwaysAutomationConditionConfig {
	type: 'always';
}

export interface GitHubPrStatusAutomationConditionConfig {
	type: 'github_pr_status';
	repository: string;
	prNumber: number;
	states?: string[];
}

export interface RoomGoalHealthAutomationConditionConfig {
	type: 'room_goal_health';
	roomId: string;
	goalId: string;
	staleAfterMs?: number;
}

export interface SpaceTaskHealthAutomationConditionConfig {
	type: 'space_task_health';
	spaceId: string;
	staleAfterMs?: number;
}

export type AutomationConditionConfig =
	| AlwaysAutomationConditionConfig
	| GitHubPrStatusAutomationConditionConfig
	| RoomGoalHealthAutomationConditionConfig
	| SpaceTaskHealthAutomationConditionConfig;

export interface RoomTaskAutomationTargetConfig {
	roomId: string;
	titleTemplate: string;
	descriptionTemplate: string;
	priority?: 'low' | 'normal' | 'high' | 'urgent';
	taskType?: 'coding' | 'research' | 'design';
	assignedAgent?: 'coder' | 'general';
	goalId?: string;
}

export interface RoomMissionAutomationTargetConfig {
	roomId: string;
	goalId: string;
	action: 'trigger' | 'check';
}

export interface SpaceTaskAutomationTargetConfig {
	spaceId: string;
	titleTemplate: string;
	descriptionTemplate: string;
	priority?: 'low' | 'normal' | 'high' | 'urgent';
	labels?: string[];
}

export interface SpaceWorkflowAutomationTargetConfig {
	spaceId: string;
	titleTemplate: string;
	descriptionTemplate: string;
	preferredWorkflowId?: string;
	priority?: 'low' | 'normal' | 'high' | 'urgent';
	labels?: string[];
}

export interface NeoAgentAutomationTargetConfig {
	promptTemplate: string;
}

export interface JobHandlerAutomationTargetConfig {
	queue: string;
	payload?: Record<string, unknown>;
}

export type AutomationTargetConfig =
	| RoomTaskAutomationTargetConfig
	| RoomMissionAutomationTargetConfig
	| SpaceTaskAutomationTargetConfig
	| SpaceWorkflowAutomationTargetConfig
	| NeoAgentAutomationTargetConfig
	| JobHandlerAutomationTargetConfig;

export interface AutomationTask {
	id: string;
	ownerType: AutomationOwnerType;
	ownerId: string | null;
	title: string;
	description: string;
	status: AutomationStatus;
	triggerType: AutomationTriggerType;
	triggerConfig: AutomationTriggerConfig;
	targetType: AutomationTargetType;
	targetConfig: AutomationTargetConfig;
	conditionConfig: AutomationConditionConfig | null;
	concurrencyPolicy: AutomationConcurrencyPolicy;
	notifyPolicy: AutomationNotifyPolicy;
	maxRetries: number;
	timeoutMs: number | null;
	nextRunAt: number | null;
	lastRunAt: number | null;
	lastCheckedAt: number | null;
	lastConditionResult: Record<string, unknown> | null;
	conditionFailureCount: number;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
}

export interface CreateAutomationTaskParams {
	ownerType: AutomationOwnerType;
	ownerId?: string | null;
	title: string;
	description?: string;
	status?: AutomationStatus;
	triggerType: AutomationTriggerType;
	triggerConfig?: AutomationTriggerConfig;
	targetType: AutomationTargetType;
	targetConfig?: AutomationTargetConfig;
	conditionConfig?: AutomationConditionConfig | null;
	concurrencyPolicy?: AutomationConcurrencyPolicy;
	notifyPolicy?: AutomationNotifyPolicy;
	maxRetries?: number;
	timeoutMs?: number | null;
	nextRunAt?: number | null;
}

export interface UpdateAutomationTaskParams {
	title?: string;
	description?: string;
	status?: AutomationStatus;
	triggerType?: AutomationTriggerType;
	triggerConfig?: AutomationTriggerConfig;
	targetType?: AutomationTargetType;
	targetConfig?: AutomationTargetConfig;
	conditionConfig?: AutomationConditionConfig | null;
	concurrencyPolicy?: AutomationConcurrencyPolicy;
	notifyPolicy?: AutomationNotifyPolicy;
	maxRetries?: number;
	timeoutMs?: number | null;
	nextRunAt?: number | null;
	lastRunAt?: number | null;
	lastCheckedAt?: number | null;
	lastConditionResult?: Record<string, unknown> | null;
	conditionFailureCount?: number;
	archivedAt?: number | null;
}

export interface AutomationRun {
	id: string;
	automationTaskId: string;
	ownerType: AutomationOwnerType;
	ownerId: string | null;
	status: AutomationRunStatus;
	triggerType: AutomationTriggerType;
	triggerReason: string | null;
	jobId: string | null;
	roomTaskId: string | null;
	roomGoalId: string | null;
	missionExecutionId: string | null;
	spaceTaskId: string | null;
	spaceWorkflowRunId: string | null;
	sessionId: string | null;
	attempt: number;
	startedAt: number | null;
	completedAt: number | null;
	resultSummary: string | null;
	error: string | null;
	metadata: Record<string, unknown> | null;
	createdAt: number;
	updatedAt: number;
}

export interface CreateAutomationRunParams {
	automationTaskId: string;
	ownerType: AutomationOwnerType;
	ownerId?: string | null;
	status?: AutomationRunStatus;
	triggerType: AutomationTriggerType;
	triggerReason?: string | null;
	jobId?: string | null;
	attempt?: number;
	metadata?: Record<string, unknown> | null;
}

export interface UpdateAutomationRunParams {
	status?: AutomationRunStatus;
	jobId?: string | null;
	roomTaskId?: string | null;
	roomGoalId?: string | null;
	missionExecutionId?: string | null;
	spaceTaskId?: string | null;
	spaceWorkflowRunId?: string | null;
	sessionId?: string | null;
	startedAt?: number | null;
	completedAt?: number | null;
	resultSummary?: string | null;
	error?: string | null;
	metadata?: Record<string, unknown> | null;
}

export interface AutomationTaskFilter {
	ownerType?: AutomationOwnerType;
	ownerId?: string | null;
	status?: AutomationStatus | AutomationStatus[];
	triggerType?: AutomationTriggerType;
	targetType?: AutomationTargetType;
	limit?: number;
}

export interface AutomationRunFilter {
	automationTaskId?: string;
	ownerType?: AutomationOwnerType;
	ownerId?: string | null;
	status?: AutomationRunStatus | AutomationRunStatus[];
	limit?: number;
}
