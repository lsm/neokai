import { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils.ts';
import { tokens } from '../../lib/design-tokens.ts';

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
				'w-10 h-10 flex items-center justify-center rounded-xl',
				tokens.transition.quick,
				'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
				'disabled:opacity-40 disabled:cursor-not-allowed',
				active
					? 'bg-indigo-500/20 text-indigo-400'
					: 'text-gray-500 hover:text-gray-300 hover:bg-white/5',
				className
			)}
		>
			{children}
		</button>
	);
}
