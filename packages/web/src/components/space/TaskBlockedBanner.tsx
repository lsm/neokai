/**
 * TaskBlockedBanner — reason-aware banner for blocked tasks.
 *
 * Replaces the generic amber blocked banner in SpaceTaskPane with
 * distinct UI per blockReason:
 *   - human_input_requested: tiny "reply via composer" hint — the question
 *     itself is surfaced as a "Question" message in the thread (see
 *     space-task-thread-events.ts), so we don't duplicate it here. The hint
 *     is a safety net: if the thread transformation ever fails to render the
 *     question, the user still sees that input is required.
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

const REASON_CONFIG: Partial<
	Record<
		SpaceBlockReason,
		{ label: string; border: string; bg: string; title: string; icon: string }
	>
> = {
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
		icon: '⚠️',
	},
	agent_crashed: {
		label: 'Agent Crashed',
		border: 'border-red-500/30',
		bg: 'bg-red-500/10',
		title: 'text-red-300',
		icon: '⚠️',
	},
	dependency_failed: {
		label: 'Blocked by Dependency',
		border: 'border-gray-500/30',
		bg: 'bg-gray-500/10',
		title: 'text-gray-300',
		icon: '⛓️',
	},
	workflow_invalid: {
		label: 'Invalid Workflow',
		border: 'border-red-500/30',
		bg: 'bg-red-500/10',
		title: 'text-red-300',
		icon: '⚠️',
	},
};

const FALLBACK_CONFIG = {
	label: 'Blocked',
	border: 'border-amber-500/30',
	bg: 'bg-amber-500/10',
	title: 'text-amber-300',
	icon: '⚠️',
};

export function TaskBlockedBanner({ task, spaceId, onStatusTransition }: TaskBlockedBannerProps) {
	const reason = task.blockReason;

	// Human-input requests render the question body as a "Question" message in
	// the thread (space-task-thread-events.ts). Here we show only a thin hint
	// pointing users to the composer — enough to be a safety net if the thread
	// transformation is ever absent, without duplicating the full question.
	if (reason === 'human_input_requested') {
		return (
			<div
				class="mx-4 mt-2 mb-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-1.5"
				data-testid="task-blocked-banner"
				data-reason="human_input_requested"
			>
				<p class="text-xs text-sky-300">💬 Awaiting your input — reply via the composer below.</p>
			</div>
		);
	}

	const config = (reason && REASON_CONFIG[reason]) || FALLBACK_CONFIG;

	const [showGateReview, setShowGateReview] = useState(false);
	const [pendingGate, setPendingGate] = useState<PendingGate | null>(null);
	const [gateLoading, setGateLoading] = useState(
		reason === 'gate_rejected' && !!task.workflowRunId
	);

	// For gate_rejected tasks, fetch the pending gate data on mount
	useEffect(() => {
		if (reason !== 'gate_rejected' || !task.workflowRunId) return;

		let cancelled = false;
		setGateLoading(true);
		spaceStore
			.listGateData(task.workflowRunId)
			.then((records) => {
				if (cancelled) return;
				// Pick the first rejected/waiting gate. Note: in multi-gate workflows
				// this may not be the gate that actually blocked the task. A future
				// improvement would store `blockingGateId` on SpaceTask to remove
				// ambiguity.
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
			.finally(() => {
				if (!cancelled) setGateLoading(false);
			});
		return () => {
			cancelled = true;
		};
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
			class={`mx-4 mt-2 mb-2 rounded-lg border ${config.border} ${config.bg} px-3 py-2`}
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
				</div>

				<div class="flex items-center gap-1.5 flex-shrink-0">
					{reason === 'gate_rejected' && pendingGate && (
						<button
							type="button"
							onClick={() => setShowGateReview(true)}
							class="px-2 py-1 text-xs font-medium text-purple-300 hover:text-purple-200 bg-purple-900/30 hover:bg-purple-900/50 rounded transition-colors"
							data-testid="gate-review-btn"
						>
							Review & Approve
						</button>
					)}
					{reason === 'gate_rejected' && !pendingGate && !gateLoading && (
						<button
							type="button"
							onClick={() => onStatusTransition?.('in_progress')}
							class="px-2 py-1 text-xs font-medium text-blue-300 hover:text-blue-200 bg-dark-700 hover:bg-dark-600 rounded transition-colors"
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
