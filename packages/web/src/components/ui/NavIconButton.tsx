import { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils.ts';

export interface NavIconButtonProps {
	children: ComponentChildren;
	onClick?: () => void;
	active?: boolean;
	disabled?: boolean;
	label: string; // Required for accessibility and tooltip
	class?: string;
}

export function NavIconButton({
	children,
	onClick,
	active = false,
	disabled = false,
	label,
	class: className,
}: NavIconButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			aria-pressed={active}
			class={cn(
				'w-12 h-12 flex items-center justify-center rounded-xl transition-all duration-150',
				'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
				'disabled:opacity-40 disabled:cursor-not-allowed',
				active
					? 'bg-dark-800 text-gray-100'
					: 'text-gray-400 hover:text-gray-200 hover:bg-dark-850',
				className
			)}
		>
			{children}
		</button>
	);
}
