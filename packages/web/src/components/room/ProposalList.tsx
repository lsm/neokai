/**
 * ProposalList Component
 *
 * Displays pending proposals requiring human approval.
 * Shows proposals from the room agent that need approval/rejection.
 * Updates in real-time via WebSocket events.
 */

import { useMemo } from 'preact/hooks';
import { Signal, useSignal } from '@preact/signals';
import type { RoomProposal } from '@neokai/shared';
import { ProposalCard } from './ProposalCard';
import { Skeleton } from '../ui/Skeleton';

// ============================================================================
// Types
// ============================================================================

export interface ProposalListProps {
	roomId: string;
	proposals: Signal<RoomProposal[]>;
	onApprove: (proposalId: string) => Promise<void>;
	onReject: (proposalId: string, reason: string) => Promise<void>;
	isLoading?: boolean;
}

// ============================================================================
// Skeleton Loader
// ============================================================================

function ProposalSkeleton() {
	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-4">
			<div class="flex items-start gap-3">
				<Skeleton variant="rectangle" width={32} height={32} class="rounded-lg" />
				<div class="flex-1 space-y-2">
					<div class="flex items-center gap-2">
						<Skeleton width="40%" height={16} />
						<Skeleton width="80px" height={20} class="rounded" />
					</div>
					<Skeleton width="100%" height={14} />
					<Skeleton width="60%" height={14} />
				</div>
			</div>
			<div class="flex items-center gap-2 mt-4">
				<Skeleton width="80px" height={32} class="rounded" />
				<Skeleton width="80px" height={32} class="rounded" />
			</div>
		</div>
	);
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState() {
	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-8 text-center">
			<div class="w-12 h-12 rounded-full bg-dark-700 flex items-center justify-center mx-auto mb-4">
				<svg class="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
			</div>
			<h3 class="text-lg font-medium text-gray-200 mb-2">No pending proposals</h3>
			<p class="text-sm text-gray-400">
				Proposals from the room agent will appear here for your approval.
			</p>
		</div>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function ProposalList({
	roomId: _roomId,
	proposals,
	onApprove,
	onReject,
	isLoading = false,
}: ProposalListProps) {
	const actionInProgress = useSignal<string | null>(null);

	// Filter to show only pending proposals and sort by creation date (newest first)
	const pendingProposals = useMemo(() => {
		const proposalList = proposals.value;
		return proposalList
			.filter((p) => p.status === 'pending')
			.sort((a, b) => b.createdAt - a.createdAt);
	}, [proposals.value]);

	const handleApprove = async (proposalId: string) => {
		actionInProgress.value = proposalId;
		try {
			await onApprove(proposalId);
		} finally {
			actionInProgress.value = null;
		}
	};

	const handleReject = async (proposalId: string, reason: string) => {
		actionInProgress.value = proposalId;
		try {
			await onReject(proposalId, reason);
		} finally {
			actionInProgress.value = null;
		}
	};

	return (
		<div class="space-y-4">
			{/* Header */}
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<h3 class="text-lg font-semibold text-gray-100">Proposals</h3>
					{pendingProposals.length > 0 && (
						<span class="px-2 py-0.5 text-xs font-medium bg-blue-900/50 text-blue-300 rounded-full">
							{pendingProposals.length} pending
						</span>
					)}
				</div>
			</div>

			{/* Content */}
			{isLoading ? (
				<div class="space-y-3">
					<ProposalSkeleton />
					<ProposalSkeleton />
				</div>
			) : pendingProposals.length === 0 ? (
				<EmptyState />
			) : (
				<div class="space-y-3">
					{pendingProposals.map((proposal) => (
						<ProposalCard
							key={proposal.id}
							proposal={proposal}
							onApprove={handleApprove}
							onReject={handleReject}
							isLoading={actionInProgress.value !== null && actionInProgress.value !== proposal.id}
						/>
					))}
				</div>
			)}
		</div>
	);
}
