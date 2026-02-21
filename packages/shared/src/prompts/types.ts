/**
 * Prompt Template Types
 *
 * Defines the structure for centralized prompt templates that can be:
 * - Stored centrally in packages/shared for easy management
 * - Rendered per-room at creation time
 * - Self-updated by room agents when patterns are discovered
 */

import type { TaskPriority } from '../types/neo.ts';

/**
 * Available prompt template categories
 */
export type PromptTemplateCategory =
	| 'room_agent' // Room-level orchestration prompts
	| 'manager_agent' // Manager agent prompts
	| 'worker_agent' // Worker agent prompts
	| 'lobby_agent' // External message processing prompts
	| 'security_agent' // Security checking prompts
	| 'router_agent'; // Routing decision prompts

/**
 * Template variable that can be substituted
 */
export interface TemplateVariable {
	name: string;
	description: string;
	defaultValue?: string;
	required?: boolean;
}

/**
 * A prompt template definition
 */
export interface PromptTemplate {
	/** Unique identifier for this template */
	id: string;
	/** Category for organization */
	category: PromptTemplateCategory;
	/** Human-readable name */
	name: string;
	/** Description of when to use this prompt */
	description: string;
	/** The template content with {{variable}} placeholders */
	template: string;
	/** Variables that can be substituted */
	variables: TemplateVariable[];
	/** Version for tracking updates */
	version: number;
	/** When this template was created */
	createdAt: number;
	/** When this template was last updated */
	updatedAt: number;
}

/**
 * Rendered prompt for a specific room
 */
export interface RenderedPrompt {
	/** ID of the template this was rendered from */
	templateId: string;
	/** Room ID this prompt belongs to */
	roomId: string;
	/** The rendered content */
	content: string;
	/** Variables used for rendering */
	renderedWith: Record<string, string>;
	/** Version of template at render time */
	templateVersion: number;
	/** When this was rendered */
	renderedAt: number;
	/** Customizations made by room agent */
	customizations?: string;
}

/**
 * Room prompt context — variables available for template rendering
 */
export interface RoomPromptContext {
	/** Room ID */
	roomId: string;
	/** Room name */
	roomName: string;
	/** Room description */
	roomDescription?: string;
	/** Background context for the room */
	backgroundContext?: string;
	/** Allowed paths for file operations */
	allowedPaths: string[];
	/** Default workspace path */
	defaultPath?: string;
	/** Repository mappings (owner/repo format) */
	repositories: string[];
	/** Active goals for the room */
	activeGoals: Array<{ title: string; progress: number; status: string }>;
	/** Current date/time */
	currentDate: string;
	/** Any custom variables */
	customVariables?: Record<string, string>;
}

/**
 * Built-in template IDs
 */
export const BUILTIN_TEMPLATE_IDS = {
	// Room Agent prompts
	ROOM_AGENT_SYSTEM: 'room_agent_system',
	ROOM_AGENT_IDLE_CHECK: 'room_agent_idle_check',
	ROOM_AGENT_GOAL_REVIEW: 'room_agent_goal_review',

	// Manager Agent prompts
	MANAGER_AGENT_SYSTEM: 'manager_agent_system',
	MANAGER_AGENT_PLANNING: 'manager_agent_planning',
	MANAGER_AGENT_REVIEW: 'manager_agent_review',

	// Worker Agent prompts
	WORKER_AGENT_SYSTEM: 'worker_agent_system',

	// Lobby Agent prompts
	LOBBY_AGENT_ROUTER: 'lobby_agent_router',
	LOBBY_AGENT_SECURITY: 'lobby_agent_security',

	// Built-in job prompts
	JOB_SESSION_REVIEW: 'job_session_review',
} as const;

/**
 * Built-in recurring job definitions
 */
export interface BuiltinJobDefinition {
	id: string;
	name: string;
	description: string;
	schedule: {
		type: 'interval';
		minutes: number;
	};
	taskTemplate: {
		title: string;
		description: string;
		priority: TaskPriority;
	};
	enabled: boolean;
}

/**
 * Available built-in jobs for all rooms
 */
export const BUILTIN_JOBS: BuiltinJobDefinition[] = [
	{
		id: 'builtin_session_review',
		name: 'Review Recent Sessions',
		description:
			'Review recent manager and worker sessions to identify patterns and improve room system prompts',
		schedule: {
			type: 'interval',
			minutes: 60,
		},
		taskTemplate: {
			title: 'Session Review & Prompt Optimization',
			description: `Review the last hour of manager and worker sessions in this room.

Tasks:
1. Identify successful patterns that should be captured in room prompts
2. Note any repeated errors or inefficiencies
3. Suggest prompt improvements if patterns are found
4. Update room system prompts if improvements are identified

Context: {{roomName}}
Goals: {{activeGoals}}`,
			priority: 'low',
		},
		enabled: true,
	},
	{
		id: 'builtin_goal_progress_check',
		name: 'Goal Progress Check',
		description: 'Check progress on active goals and create tasks if behind schedule',
		schedule: {
			type: 'interval',
			minutes: 30,
		},
		taskTemplate: {
			title: 'Goal Progress Review',
			description: `Review active goals and their progress.

Tasks:
1. Check each active goal's progress
2. If progress is stalled, analyze why
3. Create new tasks if needed to unblock goals
4. Update goal priorities if needed

Goals: {{activeGoals}}`,
			priority: 'normal',
		},
		enabled: true,
	},
	{
		id: 'builtin_cleanup_completed',
		name: 'Cleanup Completed Tasks',
		description: 'Archive or cleanup completed tasks and sessions',
		schedule: {
			type: 'interval',
			minutes: 120,
		},
		taskTemplate: {
			title: 'Cleanup Completed Items',
			description: `Clean up completed tasks and sessions.

Tasks:
1. Archive completed tasks older than 24 hours
2. Update room statistics
3. Clear any stale state

Room: {{roomName}}`,
			priority: 'low',
		},
		enabled: true,
	},
];
