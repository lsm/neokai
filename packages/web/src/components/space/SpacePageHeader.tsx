import { borderColors } from '../../lib/design-tokens';
import { contextPanelOpenSignal } from '../../lib/signals';

interface SpacePageHeaderProps {
	spaceName: string;
	pageTitle: string;
}

export function SpacePageHeader({ spaceName, pageTitle }: SpacePageHeaderProps) {
	return (
		<div
			class={`flex-shrink-0 bg-dark-850 border-b ${borderColors.ui.default} px-4 h-[65px] flex items-center relative z-10`}
		>
			<div class="flex-1 flex items-center gap-3">
				<button
					onClick={() => (contextPanelOpenSignal.value = true)}
					class="md:hidden p-1.5 bg-dark-850 border border-dark-700 rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0"
					title="Open menu"
					aria-label="Open navigation menu"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M4 6h16M4 12h16M4 18h16"
						/>
					</svg>
				</button>
				<div class="flex-1 min-w-0">
					<div class="text-xs text-gray-500 truncate">{spaceName}</div>
					<h2 class="text-sm font-semibold text-gray-100 truncate">{pageTitle}</h2>
				</div>
			</div>
		</div>
	);
}
