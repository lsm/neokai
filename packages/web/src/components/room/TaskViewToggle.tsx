/**
 * TaskViewToggle Component
 *
 * Wrapper that renders a V1/V2 toggle header bar above the active task view.
 * Reads and persists the user's preference via localStorage.
 *
 * Default: 'v1' for backward compatibility.
 */

import { useState } from 'preact/hooks';
import { TaskView } from './TaskView';
import { TaskViewV2 } from './TaskViewV2';

const STORAGE_KEY = 'neokai:taskViewVersion';

interface TaskViewToggleProps {
	roomId: string;
	taskId: string;
}

export function TaskViewToggle({ roomId, taskId }: TaskViewToggleProps) {
	// Synchronous lazy initializer prevents visible flicker on load
	const [version, setVersion] = useState<'v1' | 'v2'>(
		() => (localStorage.getItem(STORAGE_KEY) as 'v1' | 'v2') || 'v1'
	);

	const handleToggle = () => {
		const next = version === 'v1' ? 'v2' : 'v1';
		setVersion(next);
		localStorage.setItem(STORAGE_KEY, next);
	};

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			{/* Toggle header bar */}
			<div class="flex items-center justify-end gap-2 px-3 py-1 bg-dark-850 border-b border-dark-700">
				<span class="text-xs text-gray-500 select-none">View:</span>
				<button
					data-testid="task-view-toggle"
					onClick={handleToggle}
					class="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-gray-100"
					aria-label={`Switch to ${version === 'v1' ? 'V2 turn-based' : 'V1 timeline'} view`}
				>
					{version === 'v1' ? (
						<>
							<span>V1</span>
							<span class="text-gray-500">→ V2</span>
						</>
					) : (
						<>
							<span class="text-gray-500">V1 ←</span>
							<span>V2</span>
						</>
					)}
				</button>
			</div>

			{/* Active view */}
			{version === 'v1' ? (
				<TaskView roomId={roomId} taskId={taskId} />
			) : (
				<TaskViewV2 roomId={roomId} taskId={taskId} />
			)}
		</div>
	);
}
