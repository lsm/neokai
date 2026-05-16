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
		<div class={`flex items-center gap-2 px-2 py-2.5 border-b ${borderColors.ui.default}`}>
			<div
				class={cn(
					'relative grid grid-cols-2 flex-1 overflow-hidden rounded-full p-1',
					'border border-white/10 bg-white/[0.07] backdrop-blur-xl',
					'shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_12px_32px_rgba(0,0,0,0.24)]'
				)}
				role="tablist"
			>
				<div class="pointer-events-none absolute inset-x-3 top-1 h-px bg-white/35" />
				<div class="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.08] to-transparent" />
				{SECTIONS.map((section) => {
					const isActive = navSection === section.id;
					return (
						<button
							key={section.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							onClick={() => section.onClick()}
							class={cn(
								'relative z-10 rounded-full px-3 py-1.5 text-sm font-medium',
								'transition-all duration-200 ease-out active:scale-[0.98]',
								isActive
									? cn(
											'bg-white/[0.18] text-white backdrop-blur-xl',
											'shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-10px_18px_rgba(255,255,255,0.05),0_6px_18px_rgba(0,0,0,0.22)]'
										)
									: 'text-gray-300/80 hover:bg-white/[0.08] hover:text-white'
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
						'md:hidden flex p-1.5 rounded-full text-gray-300/80 transition-all duration-200',
						'border border-white/10 bg-white/[0.07] backdrop-blur-xl hover:bg-white/[0.12]',
						'hover:text-white active:scale-95'
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
