/**
 * RoomDashboard Component
 *
 * Dashboard showing room overview with:
 * - Runtime state indicator and pause/resume/stop/start controls
 * - Confirmation dialogs for pause and stop actions
 * - Stats overview (sessions, pending, active, completed, failed tasks)
 * - Sessions list
 * - Tasks list grouped by status
 */

import { useState } from 'preact/hooks';
import type { RuntimeState } from '@neokai/shared';
import { roomStore } from '../../lib/room-store';
import { navigateToRoomTask } from '../../lib/router';
import { RoomSessions } from './RoomSessions';
import { RoomTasks } from './RoomTasks';
import { ConfirmModal } from '../ui/ConfirmModal';
import { cn } from '../../lib/utils';

function RuntimeStateIndicator({ state }: { state: RuntimeState }) {
	const colors: Record<RuntimeState, string> = {
		running: 'bg-green-500',
		paused: 'bg-yellow-500',
		stopped: 'bg-red-500',
	};
	return (
		<div
			class={cn('w-2.5 h-2.5 rounded-full', colors[state], state === 'running' && 'animate-pulse')}
		/>
	);
}

export function RoomDashboard() {
	const tasks = roomStore.tasks.value;
	const sessions = roomStore.sessions.value;
	const roomId = roomStore.roomId.value;
	const runtimeState = roomStore.runtimeState.value;
	const [actionLoading, setActionLoading] = useState(false);
	const [showPauseConfirm, setShowPauseConfirm] = useState(false);
	const [showStopConfirm, setShowStopConfirm] = useState(false);
	const [showApproveConfirm, setShowApproveConfirm] = useState<string | null>(null);
	const [approvalLoading, setApprovalLoading] = useState(false);

	const handlePause = async () => {
		setActionLoading(true);
		try {
			await roomStore.pauseRuntime();
		} catch {
			// Error handled by store
		} finally {
			setActionLoading(false);
			setShowPauseConfirm(false);
		}
	};

	const handleResume = async () => {
		setActionLoading(true);
		try {
			await roomStore.resumeRuntime();
		} catch {
			// Error handled by store
		} finally {
			setActionLoading(false);
		}
	};

	const handleStop = async () => {
		setActionLoading(true);
		try {
			await roomStore.stopRuntime();
		} catch {
			// Error handled by store
		} finally {
			setActionLoading(false);
			setShowStopConfirm(false);
		}
	};

	const handleApprove = async () => {
		const taskId = showApproveConfirm;
		if (!taskId) return;
		setApprovalLoading(true);
		try {
			await roomStore.approveTask(taskId);
		} catch {
			// Error handled by store
		} finally {
			setApprovalLoading(false);
			setShowApproveConfirm(null);
		}
	};

	const handleStart = async () => {
		setActionLoading(true);
		try {
			await roomStore.startRuntime();
		} catch {
			// Error handled by store
		} finally {
			setActionLoading(false);
		}
	};

	return (
		<div class="p-4 space-y-6">
			{/* Runtime state + controls */}
			{runtimeState && (
				<div class="flex items-center justify-between bg-dark-850 border border-dark-700 rounded-lg px-4 py-3">
					<div class="flex items-center gap-2.5">
						<RuntimeStateIndicator state={runtimeState} />
						<span class="text-sm text-gray-300 capitalize">{runtimeState}</span>
						{actionLoading && <span class="text-xs text-gray-500 italic">Processing...</span>}
					</div>
					<div class="flex items-center gap-2">
						{runtimeState === 'running' && (
							<button
								onClick={() => setShowPauseConfirm(true)}
								disabled={actionLoading}
								class="px-3 py-1.5 text-xs font-medium text-yellow-400 bg-yellow-900/20 hover:bg-yellow-900/30 border border-yellow-700/50 rounded transition-colors disabled:opacity-50"
							>
								Pause
							</button>
						)}
						{runtimeState === 'paused' && (
							<button
								onClick={handleResume}
								disabled={actionLoading}
								class="px-3 py-1.5 text-xs font-medium text-green-400 bg-green-900/20 hover:bg-green-900/30 border border-green-700/50 rounded transition-colors disabled:opacity-50"
							>
								Resume
							</button>
						)}
						{runtimeState !== 'stopped' && (
							<button
								onClick={() => setShowStopConfirm(true)}
								disabled={actionLoading}
								class="px-3 py-1.5 text-xs font-medium text-red-400 bg-red-900/20 hover:bg-red-900/30 border border-red-700/50 rounded transition-colors disabled:opacity-50"
							>
								Stop
							</button>
						)}
						{runtimeState === 'stopped' && (
							<button
								onClick={handleStart}
								disabled={actionLoading}
								class="px-3 py-1.5 text-xs font-medium text-green-400 bg-green-900/20 hover:bg-green-900/30 border border-green-700/50 rounded transition-colors disabled:opacity-50"
							>
								Start
							</button>
						)}
					</div>
				</div>
			)}

			{/* Tasks list */}
			<div class="space-y-2">
				<h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wide">Tasks</h2>
				<RoomTasks
					tasks={tasks}
					onTaskClick={roomId ? (taskId) => navigateToRoomTask(roomId, taskId) : undefined}
					onApprove={roomId ? (taskId) => setShowApproveConfirm(taskId) : undefined}
				/>
			</div>

			{/* Sessions list */}
			<div class="space-y-2">
				<h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wide">Sessions</h2>
				<RoomSessions sessions={sessions} />
			</div>

			{/* Pause Confirmation */}
			<ConfirmModal
				isOpen={showPauseConfirm}
				onClose={() => setShowPauseConfirm(false)}
				onConfirm={handlePause}
				title="Pause Room"
				message="Pausing will prevent the room from starting new tasks. Currently running sessions will continue until they finish their current work."
				confirmText="Pause"
				confirmButtonVariant="primary"
				isLoading={actionLoading}
			/>

			{/* Stop Confirmation */}
			<ConfirmModal
				isOpen={showStopConfirm}
				onClose={() => setShowStopConfirm(false)}
				onConfirm={handleStop}
				title="Stop Room"
				message="Stopping will completely shut down the room runtime. All active sessions will be terminated and no new tasks will be processed. You can start the room again later."
				confirmText="Stop Room"
				isLoading={actionLoading}
			/>

			{/* Approve Task Confirmation */}
			<ConfirmModal
				isOpen={showApproveConfirm !== null}
				onClose={() => setShowApproveConfirm(null)}
				onConfirm={handleApprove}
				title="Approve Task"
				message="Are you sure you want to approve this task? It will proceed to the next phase."
				confirmText="Approve"
				confirmButtonVariant="primary"
				isLoading={approvalLoading}
			/>
		</div>
	);
}
