import { navSectionSignal } from '../lib/signals.ts';
import { navigateToSessions, navigateToSpaces } from '../lib/router.ts';
import { borderColors } from '../lib/design-tokens.ts';
import { cn } from '../lib/utils.ts';

interface SectionSwitcherProps {
	onClose?: () => void;
	variant?: 'default' | 'titlebar';
}

const SECTIONS = [
	{ id: 'chats', label: 'Chats', onClick: navigateToSessions },
	{ id: 'spaces', label: 'Spaces', onClick: navigateToSpaces },
] as const;

export function SectionSwitcher({ onClose, variant = 'default' }: SectionSwitcherProps) {
	const navSection = navSectionSignal.value;
	const isTitlebar = variant === 'titlebar';

	return (
		<div
			class={cn(
				'flex items-center gap-2',
				isTitlebar ? 'w-[136px] flex-none' : `px-2 py-2 border-b ${borderColors.ui.default}`
			)}
		>
			<div
				class={cn(
					'grid grid-cols-2 flex-1 rounded-full bg-dark-900/70 p-0.5',
					isTitlebar && 'h-6 bg-dark-950/70'
				)}
				role="tablist"
			>
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
								'rounded-full font-medium transition-colors',
								isTitlebar ? 'px-2 text-[12px] leading-5' : 'px-3 py-1.5 text-sm',
								isActive
									? 'bg-white/10 text-gray-100'
									: 'text-gray-500 hover:bg-white/5 hover:text-gray-200'
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
