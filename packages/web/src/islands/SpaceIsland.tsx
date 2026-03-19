/**
 * SpaceIsland — main content area for the Space view.
 * Rendered by MainContent when currentSpaceIdSignal is set.
 * Full implementation will follow in subsequent tasks.
 */

interface SpaceIslandProps {
	spaceId: string;
}

export default function SpaceIsland({ spaceId }: SpaceIslandProps) {
	return (
		<div class="flex-1 flex items-center justify-center bg-dark-900">
			<div class="text-center">
				<div class="text-4xl mb-3">🚀</div>
				<p class="text-sm text-gray-400">Space</p>
				<p class="text-xs text-gray-600 mt-1 font-mono">{spaceId}</p>
			</div>
		</div>
	);
}
