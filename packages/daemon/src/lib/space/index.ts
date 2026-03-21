/**
 * Space module — managers and repositories for the Space multi-agent workflow system.
 */

export { SpaceManager } from './managers/space-manager';
export {
	SpaceTaskManager,
	VALID_SPACE_TASK_TRANSITIONS,
	isValidSpaceTaskTransition,
} from './managers/space-task-manager';
export { SpaceWorkflowManager, WorkflowValidationError } from './managers/space-workflow-manager';
export type { SpaceAgentLookup } from './managers/space-workflow-manager';
export { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
export {
	CODING_WORKFLOW,
	RESEARCH_WORKFLOW,
	REVIEW_ONLY_WORKFLOW,
	getBuiltInWorkflows,
	seedBuiltInWorkflows,
} from './workflows/built-in-workflows';
export {
	WorkflowExecutor,
	WorkflowTransitionError,
	WorkflowGateError,
} from './runtime/workflow-executor';
export type {
	ConditionContext,
	ConditionResult,
	CommandRunner,
	TaskTypeResolver,
} from './runtime/workflow-executor';
export { SpaceRuntime } from './runtime/space-runtime';
export type { SpaceRuntimeConfig, ResolvedTaskType } from './runtime/space-runtime';
export { NullNotificationSink } from './runtime/notification-sink';
export type {
	NotificationSink,
	SpaceNotificationEvent,
	TaskNeedsAttentionEvent,
	WorkflowRunNeedsAttentionEvent,
	TaskTimeoutEvent,
	WorkflowRunCompletedEvent,
} from './runtime/notification-sink';
export { SpaceRuntimeService } from './runtime/space-runtime-service';
export type { SpaceRuntimeServiceConfig } from './runtime/space-runtime-service';

export { selectWorkflow } from './runtime/workflow-selector';
export type { WorkflowSelectionContext } from './runtime/workflow-selector';

export {
	buildCustomAgentSystemPrompt,
	buildCustomAgentTaskMessage,
	createCustomAgentInit,
	resolveAgentInit,
} from './agents/custom-agent';
export type { CustomAgentConfig, ResolveAgentInitConfig } from './agents/custom-agent';

export {
	buildTaskAgentSystemPrompt,
	buildTaskAgentInitialMessage,
	createTaskAgentInit,
} from './agents/task-agent';
export type {
	TaskAgentContext,
	PreviousTaskSummary,
	TaskAgentSessionConfig,
} from './agents/task-agent';

export { buildSpaceChatSystemPrompt } from './agents/space-chat-agent';
export type {
	SpaceChatAgentContext,
	WorkflowSummary,
	AgentSummary,
} from './agents/space-chat-agent';

export {
	createSpaceAgentToolHandlers,
	createSpaceAgentMcpServer,
} from './tools/space-agent-tools';
export type { SpaceAgentToolsConfig, SpaceAgentMcpServer } from './tools/space-agent-tools';

export {
	TASK_AGENT_TOOL_SCHEMAS,
	SpawnStepAgentSchema,
	CheckStepStatusSchema,
	AdvanceWorkflowSchema,
	ReportResultSchema,
	RequestHumanInputSchema,
	TaskResultStatusSchema,
} from './tools/task-agent-tool-schemas';
export type {
	SpawnStepAgentInput,
	CheckStepStatusInput,
	AdvanceWorkflowInput,
	ReportResultInput,
	RequestHumanInputInput,
	TaskResultStatus,
	TaskAgentToolName,
} from './tools/task-agent-tool-schemas';

export {
	exportAgent,
	exportWorkflow,
	exportBundle,
	validateExportedAgent,
	validateExportedWorkflow,
	validateExportBundle,
} from './export-format';
export type { ValidationResult } from './export-format';

// Types — re-exported from @neokai/shared for convenience
export type {
	SpaceWorkflow,
	WorkflowStep,
	WorkflowRule,
	WorkflowCondition,
	WorkflowConditionType,
	WorkflowTransition,
	WorkflowTransitionInput,
	WorkflowStepInput,
	WorkflowRuleInput,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
} from '@neokai/shared';
