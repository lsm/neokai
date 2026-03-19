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
	seedDefaultWorkflow,
} from './workflows/built-in-workflows';

// Types — re-exported from @neokai/shared for convenience
export type {
	SpaceWorkflow,
	WorkflowStep,
	WorkflowRule,
	WorkflowGate,
	WorkflowGateType,
	WorkflowStepInput,
	WorkflowRuleInput,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
} from '@neokai/shared';
