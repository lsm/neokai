/**
 * CommandOutputBlock Component - Displays command/system output in a consistent style
 *
 * Used for:
 * - Compaction boundaries
 * - System status messages
 * - Other command outputs
 */

import { cn } from '../../lib/utils.ts';

interface CommandOutputBlockProps {
	/** Icon to display (SVG element) */
	icon?: preact.JSX.Element;
	/** Title/label for the output */
	title: string;
	/** Main message content */
	message: string;
	/** Optional metadata to display */
	metadata?: string;
	/** Color variant */
	variant?: 'default' | 'info' | 'success' | 'warning';
	/** Whether to show a loading spinner */
	loading?: boolean;
	/** Additional CSS classes */
	className?: string;
}

/**
 * Get color scheme for variant
 */
function getVariantColors(variant: CommandOutputBlockProps['variant']) {
	switch (variant) {
		case 'info':
			return {
				bg: 'bg-blue-50 dark:bg-blue-900/20',
				border: 'border-blue-200 dark:border-blue-800',
				text: 'text-blue-700 dark:text-blue-300',
				icon: 'text-blue-600 dark:text-blue-400',
			};
		case 'success':
			return {
				bg: 'bg-green-50 dark:bg-green-900/20',
				border: 'border-green-200 dark:border-green-800',
				text: 'text-green-700 dark:text-green-300',
				icon: 'text-green-600 dark:text-green-400',
			};
		case 'warning':
			return {
				bg: 'bg-amber-50 dark:bg-amber-900/20',
				border: 'border-amber-200 dark:border-amber-800',
				text: 'text-amber-700 dark:text-amber-300',
				icon: 'text-amber-600 dark:text-amber-400',
			};
		default:
			return {
				bg: 'bg-gray-50 dark:bg-gray-800',
				border: 'border-gray-200 dark:border-gray-700',
				text: 'text-gray-700 dark:text-gray-300',
				icon: 'text-gray-600 dark:text-gray-400',
			};
	}
}

/**
 * Default icon for command output
 */
function DefaultIcon({ className }: { className?: string }) {
	return (
		<svg class={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
			/>
		</svg>
	);
}

/**
 * Loading spinner
 */
function LoadingSpinner({ className }: { className?: string }) {
	return (
		<svg
			class={cn('animate-spin', className)}
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2}
				d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
			/>
		</svg>
	);
}

export function CommandOutputBlock({
	icon,
	title,
	message,
	metadata,
	variant = 'default',
	loading = false,
	className,
}: CommandOutputBlockProps) {
	const colors = getVariantColors(variant);

	return (
		<div
			class={cn(
				'py-3 px-4 rounded-lg border text-sm flex items-center gap-3',
				colors.bg,
				colors.border,
				className
			)}
		>
			{/* Icon */}
			<div class={cn('flex-shrink-0', colors.icon)}>
				{loading ? (
					<LoadingSpinner className="w-4 h-4" />
				) : icon ? (
					<div class="w-4 h-4">{icon}</div>
				) : (
					<DefaultIcon className="w-4 h-4" />
				)}
			</div>

			{/* Content */}
			<div class="flex-1 min-w-0">
				<div class={cn('font-medium', colors.text)}>{title}</div>
				<div class={cn('text-sm', colors.text)}>{message}</div>
				{metadata && <div class={cn('text-xs mt-1 opacity-75', colors.text)}>{metadata}</div>}
			</div>
		</div>
	);
}
