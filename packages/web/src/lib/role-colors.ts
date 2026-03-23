/**
 * Shared role color definitions for agent role display.
 * Used by TaskConversationRenderer, SlideOutPanel, TurnSummaryBlock, etc.
 */

export interface RoleColors {
	border: string;
	label: string;
	labelColor: string;
}

export const ROLE_COLORS: Record<string, RoleColors> = {
	planner: { border: 'border-l-teal-500', label: 'Planner', labelColor: 'text-teal-400' },
	coder: { border: 'border-l-blue-500', label: 'Coder', labelColor: 'text-blue-400' },
	general: { border: 'border-l-slate-400', label: 'General', labelColor: 'text-slate-400' },
	leader: { border: 'border-l-purple-500', label: 'Leader', labelColor: 'text-purple-400' },
	human: { border: 'border-l-green-500', label: 'Human', labelColor: 'text-green-400' },
	system: { border: 'border-l-transparent', label: '', labelColor: 'text-gray-500' },
	craft: { border: 'border-l-blue-500', label: 'Craft', labelColor: 'text-blue-400' },
	lead: { border: 'border-l-purple-500', label: 'Lead', labelColor: 'text-purple-400' },
};
