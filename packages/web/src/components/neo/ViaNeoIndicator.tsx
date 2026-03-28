/**
 * ViaNeoIndicator
 *
 * A small, always-visible badge indicating that an action was taken by Neo.
 * Subtle sparkle icon + "via Neo" muted text — non-intrusive but visible.
 */

import { cn } from '../../lib/utils.ts';

interface Props {
	/** Optional extra CSS class */
	class?: string;
	/** Size variant — 'sm' (default) or 'xs' for tighter contexts */
	size?: 'xs' | 'sm';
}

export function ViaNeoIndicator({ class: className, size = 'sm' }: Props) {
	const isXs = size === 'xs';
	return (
		<span
			class={cn(
				'inline-flex items-center gap-0.5 select-none shrink-0',
				isXs ? 'text-[10px]' : 'text-xs',
				'text-violet-400/70',
				className
			)}
			data-testid="via-neo-indicator"
			title="This action was taken by Neo"
		>
			{/* Sparkle icon */}
			<svg
				class={cn(isXs ? 'w-2.5 h-2.5' : 'w-3 h-3', 'flex-shrink-0')}
				viewBox="0 0 24 24"
				fill="currentColor"
				aria-hidden="true"
			>
				<path d="M12 2l2.09 6.41L20.5 10l-6.41 2.09L12 18.5l-2.09-6.41L4 10l6.41-2.09L12 2z" />
				<path d="M5 3l.75 2.25L8 6l-2.25.75L5 9l-.75-2.25L2 6l2.25-.75L5 3z" opacity={0.5} />
				<path
					d="M19 15l.6 1.8L21.4 17l-1.8.6L19 19.4l-.6-1.8L16.6 17l1.8-.6L19 15z"
					opacity={0.5}
				/>
			</svg>
			<span>via Neo</span>
		</span>
	);
}
