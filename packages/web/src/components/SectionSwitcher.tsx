import { navSectionSignal } from '../lib/signals.ts';
import { navigateToSessions, navigateToSpaces } from '../lib/router.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { cn } from '../lib/utils.ts';

interface SectionSwitcherProps {
	onClose?: () => void;
}

const SECTIONS = [
	{ id: 'chats', label: 'Chats', onClick: navigateToSessions },
	{ id: 'spaces', label: 'Spaces', onClick: navigateToSpaces },
] as const;

export function SectionSwitcher({ onClose }: SectionSwitcherProps) {
	const navSection = navSectionSignal.value;

	return (
		<div class={`flex items-center gap-2 px-2 py-2 border-b ${borderColors.ui.default}`}>
			<div class="grid grid-cols-2 flex-1 rounded-full bg-dark-900/70 p-0.5" role="tablist">
				{SECTIONS.map((section) => {
					const isActive = navSection === section.id;
					return (
						<button
							key={section.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							onClick={() => {
								section.onClick();
								onClose?.();
							}}
							class={cn(
								'rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
								isActive
									? 'bg-white/10 text-gray-100 shadow-sm'
									: 'text-gray-400 hover:bg-white/5 hover:text-gray-100'
							)}
						>
							{section.label}
						</button>
					);
				})}
			</div>
			{onClose && (
				<button
					type="button"
					onClick={onClose}
					class={cn(
						'md:hidden flex p-1.5 rounded-full text-gray-400 transition-colors',
						'hover:bg-white/5 hover:text-gray-100'
					)}
					title="Close panel"
					aria-label="Close panel"
				>
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			)}
		</div>
	);
}
