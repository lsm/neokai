/**
 * Shared types and constants for agent configuration components.
 * Used by RoomAgents (shared sub-components) and AgentSettingsPopover (header popover).
 */

export interface ModelInfo {
	id: string;
	name: string;
	family: string;
	provider: string;
}

export interface CliAgentInfo {
	id: string;
	name: string;
	command: string;
	provider: string;
	installed: boolean;
	authenticated: boolean;
	version?: string;
	models?: string[];
}

export interface AgentRole {
	key: string;
	label: string;
	description: string;
}

export const BUILTIN_AGENTS: AgentRole[] = [
	{ key: 'planner', label: 'Planner', description: 'Breaks goals into tasks' },
	{ key: 'coder', label: 'Coder', description: 'Implements code changes' },
	{ key: 'general', label: 'General', description: 'Non-coding tasks' },
	{ key: 'leader', label: 'Leader', description: 'Reviews and routes' },
];

export interface SubagentConfig {
	model: string;
	provider?: string;
	type?: 'cli';
	driver_model?: string;
	cliModel?: string;
}

export interface AgentModels {
	planner?: string;
	coder?: string;
	general?: string;
	leader?: string;
}

export interface AgentSubagents {
	planner?: SubagentConfig[];
	coder?: SubagentConfig[];
	general?: SubagentConfig[];
	leader?: SubagentConfig[];
}

export const MODEL_FAMILY_ICONS: Record<string, string> = {
	opus: '🧠',
	sonnet: '💎',
	haiku: '⚡',
	glm: '🌐',
	minimax: '🔥',
	__default__: '💎',
};

export const ANTHROPIC_COMPAT_SUBAGENT_PROVIDERS = new Set(['anthropic', 'glm', 'minimax']);

export function detectFamily(id: string, provider?: string): string {
	if (id.includes('opus')) return 'opus';
	if (id.includes('haiku')) return 'haiku';
	if (provider === 'glm' || id.toLowerCase().startsWith('glm-')) return 'glm';
	if (provider === 'minimax' || id.toLowerCase().startsWith('minimax-')) return 'minimax';
	return 'sonnet';
}
