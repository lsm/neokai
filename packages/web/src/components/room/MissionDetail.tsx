/**
 * MissionDetail Component
 *
 * Placeholder for the dedicated mission (goal) detail page.
 * Rendered as an absolute overlay inside Room, following the same
 * pattern as TaskViewToggle.
 *
 * Full implementation is tracked in the "Add dedicated Mission detail page" goal.
 */

import { navigateToRoom } from '../../lib/router';
import { Button } from '../ui/Button';
import { MobileMenuButton } from '../ui/MobileMenuButton';

interface MissionDetailProps {
	roomId: string;
	goalId: string;
}

export function MissionDetail({ roomId, goalId: _goalId }: MissionDetailProps) {
	function handleBack() {
		navigateToRoom(roomId);
	}

	return (
		<div class="flex flex-col h-full bg-dark-900">
			{/* Header */}
			<div class="flex items-center gap-3 px-4 py-3 border-b border-dark-700 shrink-0">
				<MobileMenuButton />
				<Button variant="ghost" size="sm" onClick={handleBack} class="gap-1.5">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
					Back to Room
				</Button>
			</div>

			{/* Body */}
			<div class="flex-1 flex items-center justify-center text-gray-500">
				<p>Mission detail view — coming soon</p>
			</div>
		</div>
	);
}
