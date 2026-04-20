/**
 * NeoConfirmationCard
 *
 * Inline card rendered in the Neo chat when Neo needs user confirmation
 * for a pending action. Confirm/Cancel call the RPC directly (bypasses LLM
 * for reliability). Remains interactive until the action's TTL expires.
 */

import { useState } from 'preact/hooks';
import { neoStore } from '../../lib/neo-store.ts';

export interface NeoConfirmationCardProps {
	actionId: string;
	description: string;
	/** Risk level of the action: low | medium | high */
	riskLevel?: 'low' | 'medium' | 'high';
	/** Whether the action has already been resolved (TTL expired or acted on) */
	resolved?: boolean;
	/** 'confirmed' | 'cancelled' — only set once resolved */
	resolution?: 'confirmed' | 'cancelled';
}

const riskColors = {
	low: {
		badge: 'bg-green-500/10 text-green-400 border border-green-500/20',
		label: 'Low risk',
	},
	medium: {
		badge: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
		label: 'Requires confirmation',
	},
	high: {
		badge: 'bg-red-500/10 text-red-400 border border-red-500/20',
		label: 'High risk — irreversible',
	},
} as const;

export function NeoConfirmationCard({
	actionId,
	description,
	riskLevel = 'medium',
	resolved = false,
	resolution,
}: NeoConfirmationCardProps) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const risk = riskColors[riskLevel];

	const handleConfirm = async () => {
		if (loading || resolved) return;
		setLoading(true);
		setError(null);
		const result = await neoStore.confirmAction(actionId);
		if (!result.success) {
			setError(result.error ?? 'Failed to confirm action');
		}
		setLoading(false);
	};

	const handleCancel = async () => {
		if (loading || resolved) return;
		setLoading(true);
		setError(null);
		const result = await neoStore.cancelAction(actionId);
		if (!result.success) {
			setError(result.error ?? 'Failed to cancel action');
		}
		setLoading(false);
	};

	return (
		<div
			data-testid="neo-confirmation-card"
			class="my-2 rounded-xl border border-gray-700 bg-gray-800/60 overflow-hidden"
		>
			{/* Header */}
			<div class="flex items-center gap-2 px-3 py-2 border-b border-gray-700/50">
				{/* Shield icon */}
				<svg
					class="w-4 h-4 text-violet-400 flex-shrink-0"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					aria-hidden="true"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
					/>
				</svg>
				<span class="text-xs font-semibold text-violet-300 flex-1">Neo needs your approval</span>
				<span class={`text-xs px-1.5 py-0.5 rounded-md font-medium ${risk.badge}`}>
					{risk.label}
				</span>
			</div>

			{/* Description */}
			<div class="px-3 py-2.5">
				<p class="text-sm text-gray-200 leading-relaxed">{description}</p>
			</div>

			{/* Error */}
			{error && (
				<div class="px-3 pb-2 text-xs text-red-400" data-testid="neo-confirmation-error">
					{error}
				</div>
			)}

			{/* Actions */}
			<div class="flex items-center gap-2 px-3 py-2 border-t border-gray-700/50 bg-gray-900/30">
				{resolved ? (
					<span
						class={`text-xs font-medium ${
							resolution === 'confirmed' ? 'text-green-400' : 'text-gray-500'
						}`}
					>
						{resolution === 'confirmed' ? '✓ Confirmed' : '✕ Cancelled'}
					</span>
				) : (
					<>
						<button
							data-testid="neo-confirm-button"
							onClick={handleConfirm}
							disabled={loading}
							class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{loading ? 'Working…' : 'Confirm'}
						</button>
						<button
							data-testid="neo-cancel-button"
							onClick={handleCancel}
							disabled={loading}
							class="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-600 hover:border-gray-500 text-gray-300 hover:text-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							Cancel
						</button>
						<span class="ml-auto text-xs text-gray-600">You can also type "yes" or "no"</span>
					</>
				)}
			</div>
		</div>
	);
}
