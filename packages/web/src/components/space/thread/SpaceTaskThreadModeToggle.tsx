import { cn } from '../../../lib/utils';
import type { SpaceTaskThreadRenderMode } from './space-task-thread-events';

interface SpaceTaskThreadModeToggleProps {
	value: SpaceTaskThreadRenderMode;
	onChange: (mode: SpaceTaskThreadRenderMode) => void;
}

const OPTIONS: Array<{ value: SpaceTaskThreadRenderMode; label: string }> = [
	{ value: 'compact', label: 'Compact' },
	{ value: 'verbose', label: 'Verbose' },
];

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
