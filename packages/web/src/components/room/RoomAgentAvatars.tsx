/**
 * RoomAgentAvatars - Compact agent avatar strip for the Room header bar
 *
 * Shows circular avatars for each configured agent role (Planner, Coder, General, Leader)
 * with overlapping layout similar to Feishu collaborator avatars.
 * Clicking an avatar opens a settings popover for that agent.
 */

import { useSignal } from '@preact/signals';
import type { Room } from '@neokai/shared';
import { t } from '../../lib/i18n';
import { BUILTIN_AGENTS, type AgentModels } from './agent-shared';
import { AgentSettingsPopover } from './AgentSettingsPopover';

interface AgentVisual {
	initial: string;
	bgClass: string;
	textClass: string;
}

const AGENT_VISUALS: Record<string, AgentVisual> = {
	planner: { initial: 'P', bgClass: 'bg-blue-600', textClass: 'text-blue-100' },
	coder: { initial: 'C', bgClass: 'bg-emerald-600', textClass: 'text-emerald-100' },
	general: { initial: 'G', bgClass: 'bg-amber-600', textClass: 'text-amber-100' },
	leader: { initial: 'L', bgClass: 'bg-purple-600', textClass: 'text-purple-100' },
};

export interface RoomAgentAvatarsProps {
	room: Room;
	onClickAdd?: () => void;
}

export function RoomAgentAvatars({ room, onClickAdd }: RoomAgentAvatarsProps) {
	const openPopoverKey = useSignal<string | null>(null);

	const config = room.config ?? {};
	const agentModels = (config.agentModels as AgentModels) ?? {};

	return (
		<div class="flex items-center relative">
			{/* Overlapping avatar stack */}
			<div class="flex items-center -space-x-1.5">
				{BUILTIN_AGENTS.map((agent) => {
					const visual = AGENT_VISUALS[agent.key];
					if (!visual) return null;
					const model = agentModels[agent.key as keyof AgentModels];
					const hasCustomModel = !!model;
					const isOpen = openPopoverKey.value === agent.key;

					return (
						<div key={agent.key} class="relative">
							<button
								type="button"
								class={`relative w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold
									${visual.bgClass} ${visual.textClass}
									ring-2 ${isOpen ? 'ring-blue-500' : 'ring-dark-850 hover:ring-blue-500/50'}
									transition-all cursor-pointer hover:z-10 hover:scale-110`}
								onClick={(e) => {
									e.stopPropagation();
									openPopoverKey.value = isOpen ? null : agent.key;
								}}
								title={agent.label}
							>
								{visual.initial}
								{hasCustomModel && (
									<span class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-400 ring-1 ring-dark-850" />
								)}
							</button>

							{/* Settings popover */}
							{isOpen && (
								<AgentSettingsPopover
									room={room}
									agent={agent}
									bgClass={visual.bgClass}
									textClass={visual.textClass}
									initial={visual.initial}
									onClose={() => {
										openPopoverKey.value = null;
									}}
								/>
							)}
						</div>
					);
				})}
			</div>

			{/* Add agent button */}
			{onClickAdd && (
				<button
					type="button"
					class="ml-1 w-7 h-7 rounded-full flex items-center justify-center
						bg-dark-700 text-gray-400 hover:text-gray-200 hover:bg-dark-600
						ring-2 ring-dark-850 transition-all cursor-pointer text-sm"
					onClick={onClickAdd}
					title={t('roomAgentAvatars.add')}
				>
					<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 6v12m-6-6h12" />
					</svg>
				</button>
			)}
		</div>
	);
}
