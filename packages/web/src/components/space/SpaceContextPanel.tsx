import { useState } from 'preact/hooks';
import type { Space } from '@neokai/shared';
import { navigateToSpace } from '../../lib/router.ts';
import { currentSpaceIdSignal } from '../../lib/signals.ts';
import { cn } from '../../lib/utils.ts';

type SpaceFilter = 'active' | 'archived';

interface SpaceContextPanelProps {
	spaces: Space[];
	onSpaceSelect?: () => void;
	onCreateSpace?: () => void;
}

export function SpaceContextPanel({
	spaces,
	onSpaceSelect,
	onCreateSpace,
}: SpaceContextPanelProps) {
	const [filter, setFilter] = useState<SpaceFilter>('active');
	const currentSpaceId = currentSpaceIdSignal.value;

	const filtered = spaces.filter((s) => s.status === filter);

	const handleSpaceClick = (spaceId: string) => {
		navigateToSpace(spaceId);
		onSpaceSelect?.();
	};

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			{/* Filter tabs */}
			<div class="flex border-b border-dark-700 px-2 pt-2 gap-1">
				{(['active', 'archived'] as const).map((f) => (
					<button
						key={f}
						onClick={() => setFilter(f)}
						class={cn(
							'px-3 py-1.5 text-xs font-medium rounded-t transition-colors capitalize',
							filter === f
								? 'text-gray-100 border-b-2 border-blue-400'
								: 'text-gray-400 hover:text-gray-200'
						)}
					>
						{f}
					</button>
				))}
			</div>

			{/* Space list */}
			<div class="flex-1 overflow-y-auto">
				{filtered.length === 0 ? (
					<div class="flex flex-col items-center justify-center p-6 text-center">
						<div class="text-3xl mb-2">🚀</div>
						<p class="text-sm text-gray-400">
							{filter === 'active' ? 'No active spaces' : 'No archived spaces'}
						</p>
						{filter === 'active' && (
							<p class="text-xs text-gray-500 mt-1">Create a space to get started</p>
						)}
					</div>
				) : (
					<nav class="py-1">
						{filtered.map((space) => {
							const isActive = currentSpaceId === space.id;
							return (
								<button
									key={space.id}
									onClick={() => handleSpaceClick(space.id)}
									class={cn(
										'w-full px-4 py-3 flex flex-col items-start gap-0.5 text-left',
										'transition-colors duration-150',
										isActive
											? 'bg-dark-800 text-gray-100'
											: 'text-gray-300 hover:text-gray-100 hover:bg-dark-800/50'
									)}
								>
									<span class="text-sm font-medium truncate w-full">{space.name}</span>
									{space.description && (
										<span class="text-xs text-gray-500 truncate w-full">{space.description}</span>
									)}
								</button>
							);
						})}
					</nav>
				)}
			</div>

			{/* Create button */}
			{onCreateSpace && (
				<div class="p-3 border-t border-dark-700">
					<button
						onClick={onCreateSpace}
						class="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-gray-100 hover:bg-dark-800 rounded-lg transition-colors"
					>
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 4v16m8-8H4"
							/>
						</svg>
						Create Space
					</button>
				</div>
			)}
		</div>
	);
}
