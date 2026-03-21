/**
 * CollapsibleSection Component
 *
 * A reusable collapsible section with header, count badge, and expand/collapse toggle.
 * Used for Goals, Tasks, and Sessions sections in the RoomContextPanel sidebar.
 */

import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export interface CollapsibleSectionProps {
	title: string;
	count?: number;
	defaultExpanded?: boolean;
	headerRight?: ComponentChildren;
	children: ComponentChildren;
}

// @public - Library export
export function CollapsibleSection({
	title,
	count,
	defaultExpanded = true,
	headerRight,
	children,
}: CollapsibleSectionProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);

	return (
		<div class="collapsible-section">
			<button
				type="button"
				class="w-full flex items-center justify-between px-3 py-2 hover:bg-dark-800 transition-colors"
				onClick={() => setExpanded(!expanded)}
			>
				<div class="flex items-center gap-1.5">
					<span class="text-gray-500 text-[10px] leading-none">{expanded ? '▼' : '▶'}</span>
					<span class="text-xs font-semibold text-gray-500 uppercase tracking-wider">{title}</span>
					{count != null && <span class="text-xs text-gray-600 ml-0.5">({count})</span>}
				</div>
				{headerRight && (
					<div class="flex items-center" onClick={(e: MouseEvent) => e.stopPropagation()}>
						{headerRight}
					</div>
				)}
			</button>
			{expanded && <div class="collapsible-section-body">{children}</div>}
		</div>
	);
}
