/**
 * TaskBlockedBanner — reason-aware banner for blocked tasks.
 *
 * Replaces the generic amber blocked banner in SpaceTaskPane with
 * distinct UI per blockReason:
 *   - human_input_requested: blue/info — shows question, prompts "Reply below"
 *   - gate_rejected: purple — shows gate info + "Review & Approve" expanding to GateArtifactsView
 *   - execution_failed / agent_crashed: red — shows error + Resume button
 *   - dependency_failed: gray — informational
 *   - workflow_invalid: red — informational
 *   - (null / unknown): amber fallback — matches previous behavior
 */

import { useState, useEffect } from 'preact/hooks';
import type { SpaceBlockReason, SpaceTask, SpaceTaskStatus } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { GateArtifactsView } from './GateArtifactsView';

interface TaskBlockedBannerProps {
	task: SpaceTask;
	spaceId: string;
	/** Called when the user triggers a status transition (e.g. Resume → in_progress) */
	onStatusTransition?: (newStatus: SpaceTaskStatus) => void;
}

interface PendingGate {
	gateId: string;
	data: Record<string, unknown>;
}

const REASON_CONFIG: Record<
	string,
	{ label: string; border: string; bg: string; title: string; icon: string }
> = {
	human_input_requested: {
		label: 'Waiting for Input',
		border: 'border-blue-500/30',
		bg: 'bg-blue-500/10',
		title: 'text-blue-300',
		icon: '💬',
	},
	gate_rejected: {
		label: 'Gate Pending Approval',
		border: 'border-purple-500/30',
		bg: 'bg-purple-500/10',
		title: 'text-purple-300',
		icon: '🔒',
	},
	execution_failed: {
		label: 'Execution Failed',
		border: 'border-red-500/30',
		bg: 'bg-red-500/10',
		title: 'text-red-300',
		icon: '⚠',
	},
	agent_crashed: {
		label: 'Agent Crashed',
		border: 'border-red-500/30',
		bg: 'bg-red-500/10',
		title: 'text-red-300',
		icon: '⚠',
	},
	dependency_failed: {
		label: 'Blocked by Dependency',
		border: 'border-gray-500/30',
		bg: 'bg-gray-500/10',
		title: 'text-gray-300',
		icon: '⛓',
	},
	workflow_invalid: {
		label: 'Invalid Workflow',
		border: 'border-red-500/30',
		bg: 'bg-red-500/10',
		title: 'text-red-300',
		icon: '⚠',
	},
};

const FALLBACK_CONFIG = {
	label: 'Blocked',
	border: 'border-amber-500/30',
	bg: 'bg-amber-500/10',
	title: 'text-amber-300',
	icon: '⚠',
};

export function TaskBlockedBanner({ task, spaceId, onStatusTransition }: TaskBlockedBannerProps) {
	const reason = task.blockReason as SpaceBlockReason | null;
	const config = (reason && REASON_CONFIG[reason]) || FALLBACK_CONFIG;

	const [showGateReview, setShowGateReview] = useState(false);
	const [pendingGate, setPendingGate] = useState<PendingGate | null>(null);
	const [gateLoading, setGateLoading] = useState(false);

	// For gate_rejected tasks, fetch the pending gate data on mount
	useEffect(() => {
		if (reason !== 'gate_rejected' || !task.workflowRunId) return;

		setGateLoading(true);
		spaceStore
			.listGateData(task.workflowRunId)
			.then((records) => {
				// Find the rejected/unapproved gate
				const rejected = records.find(
					(r) => r.data?.approved === false || r.data?.waiting === true
				);
				if (rejected) {
					setPendingGate({ gateId: rejected.gateId, data: rejected.data });
				}
			})
			.catch(() => {
				// Gate data fetch is best-effort
			})
			.finally(() => setGateLoading(false));
	}, [reason, task.workflowRunId]);

	// If showing full gate review, render GateArtifactsView
	if (showGateReview && pendingGate && task.workflowRunId) {
		return (
			<GateArtifactsView
				runId={task.workflowRunId}
				gateId={pendingGate.gateId}
				spaceId={spaceId}
				gateData={pendingGate.data}
				onClose={() => setShowGateReview(false)}
				onDecision={() => setShowGateReview(false)}
			/>
		);
	}

	return (
		<div
			class={`mx-4 mt-2 rounded-lg border ${config.border} ${config.bg} px-3 py-2`}
			data-testid="task-blocked-banner"
		>
			<div class="flex items-start justify-between gap-2">
				<div class="flex-1 min-w-0">
					<p class={`text-xs font-medium ${config.title}`}>
						{config.icon} {config.label}
					</p>
					{task.result && (
						<p class="mt-0.5 text-sm text-gray-200/90" data-testid="task-blocked-message">
							{task.result}
						</p>
					)}
					{reason === 'human_input_requested' && (
						<p class="mt-1 text-xs text-blue-400/70">Reply below to continue</p>
					)}
				</div>

				<div class="flex items-center gap-1.5 flex-shrink-0">
					{reason === 'gate_rejected' && pendingGate && (
						<button
							type="button"
							onClick={() => setShowGateReview(true)}
							disabled={gateLoading}
							class="px-2 py-1 text-xs font-medium text-purple-300 hover:text-purple-200 bg-purple-900/30 hover:bg-purple-900/50 rounded transition-colors disabled:opacity-50"
							data-testid="gate-review-btn"
						>
							Review & Approve
						</button>
					)}
					{reason === 'gate_rejected' && !pendingGate && !gateLoading && (
						<button
							type="button"
							onClick={() => onStatusTransition?.('in_progress')}
							class="px-2 py-1 text-xs font-medium text-blue-300 hover:text-blue-200 transition-colors"
							data-testid="gate-resume-btn"
						>
							Resume
						</button>
					)}
					{(reason === 'execution_failed' || reason === 'agent_crashed') && (
						<button
							type="button"
							onClick={() => onStatusTransition?.('in_progress')}
							class="px-2 py-1 text-xs font-medium text-blue-300 hover:text-blue-200 bg-dark-700 hover:bg-dark-600 rounded transition-colors"
							data-testid="task-resume-btn"
						>
							Resume
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
