import type { SpaceTaskThreadRenderStyle } from '../../../lib/space-task-thread-config';
import { cn } from '../../../lib/utils';

interface SpaceTaskThreadModeToggleProps {
	value: SpaceTaskThreadRenderStyle;
	onChange: (style: SpaceTaskThreadRenderStyle) => void;
}

const OPTIONS: Array<{ value: SpaceTaskThreadRenderStyle; label: string }> = [
	{ value: 'compact', label: 'Compact' },
	{ value: 'minimal', label: 'Minimal' },
];

/**
 * Two-position toggle for switching between the bracket-rail compact feed
 * and the Slack-style minimal feed. Stateless — caller owns the value and
 * is responsible for persisting it via setSpaceTaskThreadRenderStyle.
 */
export function SpaceTaskThreadModeToggle({ value, onChange }: SpaceTaskThreadModeToggleProps) {
	return (
		<div
			class="inline-flex items-center gap-1 rounded-md border border-dark-700 bg-dark-900 p-1"
			role="tablist"
			aria-label="Task thread view mode"
		>
			{OPTIONS.map((option) => (
				<button
					key={option.value}
					type="button"
					role="tab"
					aria-selected={value === option.value}
					onClick={() => onChange(option.value)}
					class={cn(
						'rounded px-2 py-1 text-xs transition-colors',
						value === option.value
							? 'bg-dark-700 text-gray-100'
							: 'text-gray-500 hover:text-gray-200'
					)}
					data-testid={`space-task-thread-mode-${option.value}`}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
