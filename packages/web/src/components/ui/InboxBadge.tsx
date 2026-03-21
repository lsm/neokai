/**
 * InboxBadge — animated inbox review-count badge.
 *
 * Behaviour (plan 8.3):
 *  - When count increases: badge scales from 0.5 → 1 via CSS keyframe (animate-badge-pop).
 *    Implemented by changing `key` on the inner div so Preact unmounts/remounts it,
 *    replaying the CSS animation without any JS animation library.
 *  - When count reaches 0: badge fades out with transition-opacity duration-200 before
 *    being removed from the DOM.
 */
import { useState, useEffect, useRef } from 'preact/hooks';

interface InboxBadgeProps {
	count: number;
	/** Additional Tailwind classes for absolute positioning, e.g. "absolute top-1 right-1" */
	class?: string;
}

export function InboxBadge({ count, class: className = '' }: InboxBadgeProps) {
	const prevCountRef = useRef(count);
	// Increment to remount the inner div and replay the CSS keyframe animation
	const [popKey, setPopKey] = useState(0);
	const [visible, setVisible] = useState(count > 0);
	const [fading, setFading] = useState(false);

	useEffect(() => {
		const prev = prevCountRef.current;
		prevCountRef.current = count;

		if (count > 0) {
			setVisible(true);
			setFading(false);
			if (count > prev) {
				// Trigger scale-in animation by remounting the inner element
				setPopKey((k) => k + 1);
			}
		} else if (prev > 0) {
			// Count reached zero — fade out then hide
			setFading(true);
			const t = setTimeout(() => {
				setVisible(false);
				setFading(false);
			}, 200);
			return () => clearTimeout(t);
		}
	}, [count]);

	if (!visible) return null;

	return (
		<div
			key={String(popKey)}
			class={`w-2 h-2 rounded-full bg-red-500 flex items-center justify-center animate-badge-pop transition-opacity duration-200 ${fading ? 'opacity-0' : 'opacity-100'} ${className}`}
		>
			{count <= 9 ? (
				<span class="text-white text-[8px] font-bold leading-none">{count}</span>
			) : (
				<span class="text-white text-[8px] font-bold leading-none">9+</span>
			)}
		</div>
	);
}
