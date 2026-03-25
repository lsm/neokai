import { useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';
import type { ReferenceMention, ReferenceMetadata, ReferenceType } from '@neokai/shared';

export interface MentionTokenProps {
	mention: ReferenceMention;
	metadata?: ReferenceMetadata;
	onClick?: () => void;
}

const TYPE_STYLES: Record<ReferenceType, { container: string; icon: string; label: string }> = {
	task: {
		container: 'bg-blue-500/15 text-blue-300 hover:bg-blue-500/25',
		icon: 'text-blue-400',
		label: 'task',
	},
	goal: {
		container: 'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25',
		icon: 'text-purple-400',
		label: 'goal',
	},
	file: {
		container: 'bg-green-500/15 text-green-300 hover:bg-green-500/25',
		icon: 'text-green-400',
		label: 'file',
	},
	folder: {
		container: 'bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25',
		icon: 'text-yellow-400',
		label: 'folder',
	},
};

function TokenIcon({ type, className }: { type: ReferenceType; className?: string }) {
	if (type === 'task') {
		return (
			<svg
				class={cn('w-3 h-3 shrink-0', className)}
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				aria-hidden="true"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
				/>
			</svg>
		);
	}
	if (type === 'goal') {
		return (
			<svg
				class={cn('w-3 h-3 shrink-0', className)}
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				aria-hidden="true"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9"
				/>
			</svg>
		);
	}
	if (type === 'folder') {
		return (
			<svg
				class={cn('w-3 h-3 shrink-0', className)}
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				aria-hidden="true"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
				/>
			</svg>
		);
	}
	// file
	return (
		<svg
			class={cn('w-3 h-3 shrink-0', className)}
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			aria-hidden="true"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width={2}
				d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
			/>
		</svg>
	);
}

/**
 * Renders a single @ reference as a styled, interactive pill token.
 *
 * Display text is resolved from `metadata` first (by the @ref{type:id} key),
 * falling back to `mention.displayText`, then to `mention.id`.
 */
export default function MentionToken({ mention, metadata, onClick }: MentionTokenProps) {
	const [showTooltip, setShowTooltip] = useState(false);

	const tokenKey = `@ref{${mention.type}:${mention.id}}`;
	const metaEntry = metadata?.[tokenKey];
	const displayText = metaEntry?.displayText || mention.displayText || mention.id;
	const status = metaEntry?.status;

	const styles = TYPE_STYLES[mention.type];
	const ariaLabel = `${styles.label} reference: ${displayText}`;

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Enter' && onClick) {
			e.preventDefault();
			onClick();
		}
	};

	return (
		<span class="relative inline-flex">
			<span
				role={onClick ? 'button' : undefined}
				tabIndex={0}
				aria-label={ariaLabel}
				onClick={onClick}
				onKeyDown={handleKeyDown}
				onMouseEnter={() => setShowTooltip(true)}
				onMouseLeave={() => setShowTooltip(false)}
				onFocus={() => setShowTooltip(true)}
				onBlur={() => setShowTooltip(false)}
				class={cn(
					'rounded-full px-2 py-0.5 text-xs font-medium inline-flex items-center gap-1',
					'transition-colors duration-100',
					onClick ? 'cursor-pointer' : 'cursor-default',
					styles.container
				)}
			>
				<TokenIcon type={mention.type} className={styles.icon} />
				<span class="max-w-[160px] truncate">{displayText}</span>
			</span>

			{showTooltip && (
				<span
					role="tooltip"
					class={cn(
						'absolute z-50 bottom-full left-0 mb-1.5',
						'bg-dark-800 border border-gray-700 rounded-lg shadow-xl',
						'px-3 py-2 text-xs text-gray-200 whitespace-nowrap',
						'pointer-events-none'
					)}
				>
					<span class="flex flex-col gap-0.5 min-w-0">
						<span class="font-medium text-gray-100">{displayText}</span>
						{status && <span class="text-gray-400">{status}</span>}
						<span class="text-gray-500">
							{mention.type}: {mention.id}
						</span>
					</span>
				</span>
			)}
		</span>
	);
}
