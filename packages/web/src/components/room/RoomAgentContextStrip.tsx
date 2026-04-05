/**
 * RoomAgentContextStrip — Compact room status bar for the Chat tab.
 *
 * Shows runtime state, active/review task counts, and total tasks
 * in a single-line strip between the tab bar and ChatContainer.
 */

import type { RuntimeState } from '@neokai/shared';
import { roomStore } from '../../lib/room-store';
import { cn } from '../../lib/utils';

const RUNTIME_DOT: Record<RuntimeState, string> = {
	running: 'bg-green-400',
	paused: 'bg-yellow-400',
	stopped: 'bg-gray-500',
};

const RUNTIME_LABEL: Record<RuntimeState, string> = {
	running: 'Running',
	paused: 'Paused',
	stopped: 'Stopped',
};

export function RoomAgentContextStrip() {
	const room = roomStore.room.value;
	if (!room) return null;

	const runtimeState: RuntimeState = roomStore.runtimeState.value ?? 'stopped';
	const activeCount = roomStore.activeTasks.value.length;
	const reviewCount = roomStore.reviewTaskCount.value;
	const totalCount = roomStore.tasks.value.length;

	return (
		<div class="flex items-center gap-4 px-4 py-1.5 bg-dark-850/60 border-b border-dark-700 text-xs text-gray-400 flex-shrink-0">
			{/* Runtime state */}
			<div class="flex items-center gap-1.5">
				<span class={cn('w-2 h-2 rounded-full flex-shrink-0', RUNTIME_DOT[runtimeState])} />
				<span>{RUNTIME_LABEL[runtimeState]}</span>
			</div>

			<span class="text-dark-600">|</span>

			{/* Active tasks */}
			<div class="flex items-center gap-1">
				<span class="text-blue-400 font-medium tabular-nums">{activeCount}</span>
				<span>active</span>
			</div>

			{/* Review count */}
			{reviewCount > 0 && (
				<div class="flex items-center gap-1">
					<span class="text-purple-400 font-medium tabular-nums">{reviewCount}</span>
					<span>review</span>
				</div>
			)}

			{/* Total */}
			<div class="flex items-center gap-1">
				<span class="font-medium tabular-nums">{totalCount}</span>
				<span>total</span>
			</div>
		</div>
	);
}
