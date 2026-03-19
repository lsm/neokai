/**
 * Space module — managers for the Space multi-agent workflow system.
 */

export { SpaceManager } from './managers/space-manager';
export {
	SpaceTaskManager,
	VALID_SPACE_TASK_TRANSITIONS,
	isValidSpaceTaskTransition,
} from './managers/space-task-manager';
