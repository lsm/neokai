/**
 * ProposalCard Component
 *
 * Displays a single proposal with approve/reject actions.
 * Shows proposal type icon, title, description, reasoning, and proposed changes.
 */

import { useState } from 'preact/hooks';
import type { RoomProposal, ProposalType } from '@neokai/shared';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface ProposalCardProps {
	proposal: RoomProposal;
	onApprove: (proposalId: string) => Promise<void>;
	onReject: (proposalId: string, reason: string) => Promise<void>;
	isLoading?: boolean;
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

function getProposalTypeInfo(type: ProposalType): { icon: string; label: string; color: string } {
	switch (type) {
		case 'file_change':
			return { icon: 'file', label: 'File Change', color: 'text-blue-400' };
		case 'context_update':
			return { icon: 'brain', label: 'Context Update', color: 'text-purple-400' };
		case 'goal_create':
			return { icon: 'flag', label: 'Create Goal', color: 'text-green-400' };
		case 'goal_modify':
			return { icon: 'edit', label: 'Modify Goal', color: 'text-yellow-400' };
		case 'task_create':
			return { icon: 'plus', label: 'Create Task', color: 'text-cyan-400' };
		case 'task_modify':
			return { icon: 'edit-3', label: 'Modify Task', color: 'text-orange-400' };
		case 'config_change':
			return { icon: 'settings', label: 'Config Change', color: 'text-pink-400' };
		case 'custom':
		default:
			return { icon: 'message-circle', label: 'Custom', color: 'text-gray-400' };
	}
}

function formatProposedChanges(changes: Record<string, unknown>): string {
	return JSON.stringify(changes, null, 2);
}

// ============================================================================
// Icon Components
// ============================================================================

function ProposalTypeIcon({ type }: { type: ProposalType }) {
	const info = getProposalTypeInfo(type);

	return (
		<div class={cn('w-8 h-8 rounded-lg flex items-center justify-center bg-dark-700', info.color)}>
			<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				{info.icon === 'file' && (
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
					/>
				)}
				{info.icon === 'brain' && (
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
					/>
				)}
				{info.icon === 'flag' && (
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9"
					/>
				)}
				{info.icon === 'edit' && (
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
					/>
				)}
				{info.icon === 'plus' && (
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M12 4v16m8-8H4"
					/>
				)}
				{info.icon === 'edit-3' && (
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"
					/>
				)}
				{info.icon === 'settings' && (
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
					/>
				)}
				{info.icon === 'message-circle' && (
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
					/>
				)}
			</svg>
		</div>
	);
}

// ============================================================================
// Rejection Modal
// ============================================================================

interface RejectionModalProps {
	isOpen: boolean;
	onClose: () => void;
	onConfirm: (reason: string) => Promise<void>;
	isLoading: boolean;
}

function RejectionModal({ isOpen, onClose, onConfirm, isLoading }: RejectionModalProps) {
	const [reason, setReason] = useState('');

	const handleSubmit = async () => {
		await onConfirm(reason.trim() || 'No reason provided');
		setReason('');
	};

	const handleClose = () => {
		setReason('');
		onClose();
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Reject Proposal">
			<div class="space-y-4">
				<p class="text-sm text-gray-300">
					Please provide a reason for rejecting this proposal. This helps the agent understand your
					decision.
				</p>
				<textarea
					value={reason}
					onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)}
					class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
					placeholder="Enter rejection reason..."
					rows={4}
				/>
				<div class="flex justify-end gap-3">
					<Button variant="ghost" onClick={handleClose} disabled={isLoading}>
						Cancel
					</Button>
					<Button variant="danger" onClick={handleSubmit} loading={isLoading}>
						Reject Proposal
					</Button>
				</div>
			</div>
		</Modal>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function ProposalCard({
	proposal,
	onApprove,
	onReject,
	isLoading = false,
}: ProposalCardProps) {
	const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [isApproving, setIsApproving] = useState(false);
	const [isRejecting, setIsRejecting] = useState(false);

	const typeInfo = getProposalTypeInfo(proposal.type);

	const handleApprove = async () => {
		setIsApproving(true);
		try {
			await onApprove(proposal.id);
		} finally {
			setIsApproving(false);
		}
	};

	const handleReject = async (reason: string) => {
		setIsRejecting(true);
		try {
			await onReject(proposal.id, reason);
			setIsRejectModalOpen(false);
		} finally {
			setIsRejecting(false);
		}
	};

	return (
		<>
			<div class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden">
				{/* Header */}
				<div class="p-4">
					<div class="flex items-start gap-3">
						<ProposalTypeIcon type={proposal.type} />
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 mb-1">
								<h4 class="text-sm font-medium text-gray-100 truncate">{proposal.title}</h4>
								<span
									class={cn('px-2 py-0.5 text-xs font-medium rounded capitalize', typeInfo.color)}
								>
									{typeInfo.label}
								</span>
							</div>
							<p class="text-sm text-gray-400 line-clamp-2">{proposal.description}</p>
							<div class="flex items-center gap-3 mt-2 text-xs text-gray-500">
								<span>{formatRelativeTime(proposal.createdAt)}</span>
								<span class="font-mono">ID: {proposal.id.slice(0, 8)}</span>
							</div>
						</div>
					</div>

					{/* Action Buttons */}
					<div class="flex items-center gap-2 mt-4">
						<Button
							variant="primary"
							size="sm"
							onClick={handleApprove}
							loading={isApproving}
							disabled={isLoading || isRejecting}
						>
							Approve
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setIsRejectModalOpen(true)}
							loading={isRejecting}
							disabled={isLoading || isApproving}
						>
							Reject
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsExpanded(!isExpanded)}
							class="ml-auto"
						>
							{isExpanded ? 'Hide Details' : 'Show Details'}
						</Button>
					</div>
				</div>

				{/* Expanded Content */}
				{isExpanded && (
					<div class="border-t border-dark-700 px-4 py-4 space-y-4 bg-dark-800/50">
						{/* Reasoning */}
						<div>
							<h5 class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
								Reasoning
							</h5>
							<p class="text-sm text-gray-300">{proposal.reasoning}</p>
						</div>

						{/* Proposed Changes */}
						<div>
							<h5 class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
								Proposed Changes
							</h5>
							<pre class="p-3 bg-dark-900 rounded-lg text-xs text-gray-300 overflow-x-auto font-mono">
								{formatProposedChanges(proposal.proposedChanges)}
							</pre>
						</div>
					</div>
				)}
			</div>

			{/* Rejection Modal */}
			<RejectionModal
				isOpen={isRejectModalOpen}
				onClose={() => setIsRejectModalOpen(false)}
				onConfirm={handleReject}
				isLoading={isRejecting}
			/>
		</>
	);
}
