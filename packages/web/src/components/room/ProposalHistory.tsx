/**
 * ProposalHistory Component
 *
 * Shows resolved proposals (approved/rejected/withdrawn).
 * Displays status badges and who acted on each proposal.
 */

import { useMemo } from 'preact/hooks';
import type { RoomProposal, ProposalStatus } from '@neokai/shared';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface ProposalHistoryProps {
	proposals: RoomProposal[];
	limit?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) {
		return 'Just now';
	} else if (minutes < 60) {
		return `${minutes}m ago`;
	} else if (hours < 24) {
		return `${hours}h ago`;
	} else if (days === 1) {
		return 'Yesterday';
	} else if (days < 7) {
		return `${days}d ago`;
	} else {
		return new Date(timestamp).toLocaleDateString();
	}
}

function getStatusInfo(status: ProposalStatus): {
	label: string;
	bgColor: string;
	textColor: string;
	icon: string;
} {
	switch (status) {
		case 'approved':
			return {
				label: 'Approved',
				bgColor: 'bg-green-900/50',
				textColor: 'text-green-300',
				icon: 'check',
			};
		case 'rejected':
			return {
				label: 'Rejected',
				bgColor: 'bg-red-900/50',
				textColor: 'text-red-300',
				icon: 'x',
			};
		case 'withdrawn':
			return {
				label: 'Withdrawn',
				bgColor: 'bg-gray-700',
				textColor: 'text-gray-300',
				icon: 'minus',
			};
		case 'applied':
			return {
				label: 'Applied',
				bgColor: 'bg-blue-900/50',
				textColor: 'text-blue-300',
				icon: 'check-circle',
			};
		default:
			return {
				label: status,
				bgColor: 'bg-gray-700',
				textColor: 'text-gray-300',
				icon: 'circle',
			};
	}
}

// ============================================================================
// Status Badge Component
// ============================================================================

function StatusBadge({ status }: { status: ProposalStatus }) {
	const info = getStatusInfo(status);

	return (
		<span
			class={cn(
				'px-2 py-0.5 text-xs font-medium rounded capitalize flex items-center gap-1',
				info.bgColor,
				info.textColor
			)}
		>
			{info.icon === 'check' && (
				<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M5 13l4 4L19 7"
					/>
				</svg>
			)}
			{info.icon === 'x' && (
				<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			)}
			{info.icon === 'minus' && (
				<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M20 12H4" />
				</svg>
			)}
			{info.icon === 'check-circle' && (
				<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
			)}
			{info.icon === 'circle' && (
				<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<circle cx="12" cy="12" r="10" stroke-width="2" />
				</svg>
			)}
			{info.label}
		</span>
	);
}

// ============================================================================
// History Item Component
// ============================================================================

interface HistoryItemProps {
	proposal: RoomProposal;
}

function HistoryItem({ proposal }: HistoryItemProps) {
	const statusInfo = getStatusInfo(proposal.status);

	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-3 opacity-75 hover:opacity-100 transition-opacity">
			<div class="flex items-center gap-3">
				{/* Status indicator */}
				<div class={cn('w-2 h-2 rounded-full', statusInfo.bgColor.replace('/50', ''))} />

				{/* Content */}
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<span class="text-sm text-gray-300 truncate">{proposal.title}</span>
						<StatusBadge status={proposal.status} />
					</div>
					<div class="flex items-center gap-3 mt-1 text-xs text-gray-500">
						<span>{formatRelativeTime(proposal.actedAt || proposal.createdAt)}</span>
						{proposal.actedBy && <span>by {proposal.actedBy}</span>}
						{proposal.actionResponse && (
							<span class="text-gray-400 truncate max-w-48">
								&quot;{proposal.actionResponse}&quot;
							</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState() {
	return (
		<div class="bg-dark-850 border border-dark-700 rounded-lg p-6 text-center">
			<svg
				class="w-8 h-8 mx-auto text-gray-500 mb-2"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={1.5}
					d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
				/>
			</svg>
			<p class="text-sm text-gray-500">No proposal history yet</p>
		</div>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function ProposalHistory({ proposals, limit }: ProposalHistoryProps) {
	// Filter to resolved proposals and sort by action date (newest first)
	const resolvedProposals = useMemo(() => {
		const resolved = proposals.filter(
			(p) =>
				p.status === 'approved' ||
				p.status === 'rejected' ||
				p.status === 'withdrawn' ||
				p.status === 'applied'
		);
		const sorted = resolved.sort((a, b) => (b.actedAt || b.createdAt) - (a.actedAt || a.createdAt));
		return limit ? sorted.slice(0, limit) : sorted;
	}, [proposals, limit]);

	if (resolvedProposals.length === 0) {
		return <EmptyState />;
	}

	return (
		<div class="space-y-4">
			{/* Header */}
			<div class="flex items-center justify-between">
				<h4 class="text-sm font-medium text-gray-400">History</h4>
				{limit && proposals.length > limit && (
					<span class="text-xs text-gray-500">Showing last {limit} proposals</span>
				)}
			</div>

			{/* List */}
			<div class="space-y-2">
				{resolvedProposals.map((proposal) => (
					<HistoryItem key={proposal.id} proposal={proposal} />
				))}
			</div>
		</div>
	);
}
