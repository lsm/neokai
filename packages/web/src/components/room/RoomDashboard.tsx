/**
 * RoomDashboard Component
 *
 * Dashboard showing room overview with:
 * - Runtime state indicator and pause/resume/stop/start controls
 * - Model indicator showing current leader/worker model
 * - Archive button to archive the room
 * - Confirmation dialogs for pause, stop, and archive actions
 * - Stats overview (sessions, pending, active, completed, failed tasks)
 * - Sessions list
 * - Tasks list grouped by status
 */

import { useState } from 'preact/hooks';
import type { RuntimeState } from '@neokai/shared';
import { roomStore } from '../../lib/room-store';
import { navigateToRooms, navigateToRoomTask } from '../../lib/router';
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
	const runtimeModels = roomStore.runtimeModels.value;
	const [actionLoading, setActionLoading] = useState(false);
	const [showPauseConfirm, setShowPauseConfirm] = useState(false);
	const [showStopConfirm, setShowStopConfirm] = useState(false);
	const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);

	// Get the resolved models (leader and worker)
	const { leaderModel, workerModel } = runtimeModels;

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

	const handleArchive = async () => {
		setActionLoading(true);
		try {
			await roomStore.archiveRoom();
			// Navigate back to rooms list after archiving
			navigateToRooms();
		} catch {
			// Error handled by store
		} finally {
			setActionLoading(false);
			setShowArchiveConfirm(false);
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

			{/* Model indicator and archive button */}
			<div class="flex items-center justify-between">
				{(leaderModel || workerModel) && (
					<div class="flex items-center gap-3 px-3 py-1.5 bg-dark-800 rounded-md">
						<svg
							class="w-4 h-4 text-gray-400"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
							/>
						</svg>
						<div class="flex items-center gap-3 text-xs">
							{leaderModel && (
								<span class="text-gray-400">
									Leader: <span class="text-gray-300 font-medium">{leaderModel}</span>
								</span>
							)}
							{workerModel && (
								<span class="text-gray-400">
									Worker: <span class="text-gray-300 font-medium">{workerModel}</span>
								</span>
							)}
						</div>
					</div>
				)}
				<button
					onClick={() => setShowArchiveConfirm(true)}
					class="px-3 py-1.5 text-xs font-medium text-gray-400 bg-dark-800 hover:bg-dark-700 border border-dark-600 rounded transition-colors"
				>
					Archive
				</button>
			</div>

			{/* Tasks list */}
			<div class="space-y-2">
				<h2 class="text-sm font-semibold text-gray-300 uppercase tracking-wide">Tasks</h2>
				<RoomTasks
					tasks={tasks}
					onTaskClick={roomId ? (taskId) => navigateToRoomTask(roomId, taskId) : undefined}
					onView={roomId ? (taskId) => navigateToRoomTask(roomId, taskId) : undefined}
					onReject={async (taskId, feedback) => {
						try {
							await roomStore.rejectTask(taskId, feedback);
						} catch {
							// Error handled by store
						}
					}}
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

			{/* Archive Confirmation */}
			<ConfirmModal
				isOpen={showArchiveConfirm}
				onClose={() => setShowArchiveConfirm(false)}
				onConfirm={handleArchive}
				title="Archive Room"
				message="Archiving will hide this room from the active list. You can still access it later by showing archived rooms."
				confirmText="Archive"
				confirmButtonVariant="primary"
				isLoading={actionLoading}
			/>
		</div>
	);
}
