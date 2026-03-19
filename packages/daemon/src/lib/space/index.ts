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
} from './runtime/workflow-executor';
export type { ConditionContext, ConditionResult, CommandRunner } from './runtime/workflow-executor';

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
