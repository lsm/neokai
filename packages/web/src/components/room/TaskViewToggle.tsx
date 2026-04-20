/**
 * TaskViewToggle Component
 *
 * Wrapper that renders a V1/V2 toggle header bar above the active task view.
 * Reads and persists the user's preference via localStorage.
 *
 * Default: 'v1' for backward compatibility.
 *
 * The toggle UI is shown inside the TaskInfoPanel (gear menu) rather than
 * as a persistent header bar, to reduce mobile header crowding.
 */

import { useState } from 'preact/hooks';
import { TaskView } from './TaskView';
import { TaskViewV2 } from './TaskViewV2';

const STORAGE_KEY = 'neokai:taskViewVersion';

export interface TaskViewVersionContext {
	/** Current view version */
	version: 'v1' | 'v2';
	/** Toggle between V1 and V2 */
	onToggleVersion: () => void;
}

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

	const versionContext: TaskViewVersionContext = {
		version,
		onToggleVersion: handleToggle,
	};

	return (
		<div class="flex-1 flex flex-col overflow-hidden">
			{/* Active view — toggle is now inside TaskInfoPanel (gear menu) */}
			{version === 'v1' ? (
				<TaskView roomId={roomId} taskId={taskId} viewVersion={versionContext} />
			) : (
				<TaskViewV2 roomId={roomId} taskId={taskId} viewVersion={versionContext} />
			)}
		</div>
	);
}
