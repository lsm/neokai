/**
 * ArtifactCard — renders a typed workflow run artifact.
 *
 * Dispatches on artifactType to render specialized cards:
 *   - pr: PR card with link, number, state badge
 *   - (default): generic JSON card with collapsible data
 */

import type { WorkflowRunArtifact } from '@neokai/shared';

interface ArtifactCardProps {
	artifact: WorkflowRunArtifact;
}

function PrArtifactCard({ artifact }: ArtifactCardProps) {
	const { data } = artifact;
	const url = typeof data.url === 'string' ? data.url : null;
	const number = typeof data.number === 'number' ? data.number : null;
	const title = typeof data.title === 'string' ? data.title : null;
	const state = typeof data.state === 'string' ? data.state : null;
	const headBranch = typeof data.headBranch === 'string' ? data.headBranch : null;

	const stateColor =
		state === 'open'
			? 'text-green-400'
			: state === 'merged'
				? 'text-purple-400'
				: state === 'closed'
					? 'text-red-400'
					: 'text-gray-400';

	return (
		<div
			class="flex items-center gap-2 px-3 py-2 rounded bg-dark-700/50 border border-dark-600"
			data-testid="artifact-card-pr"
		>
			<svg
				class="w-4 h-4 text-purple-400 flex-shrink-0"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width={2}
					d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
				/>
			</svg>
			<div class="flex-1 min-w-0">
				{url ? (
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						class="text-xs text-blue-400 hover:text-blue-300 truncate block"
					>
						{number != null ? `PR #${number}` : 'Pull Request'}
						{title && <span class="text-gray-400 ml-1.5">— {title}</span>}
					</a>
				) : (
					<span class="text-xs text-gray-300">
						{number != null ? `PR #${number}` : 'Pull Request'}
						{title && <span class="text-gray-400 ml-1.5">— {title}</span>}
					</span>
				)}
				{headBranch && <p class="text-xs text-gray-600 font-mono mt-0.5 truncate">{headBranch}</p>}
			</div>
			{state && <span class={`text-xs font-medium ${stateColor} flex-shrink-0`}>{state}</span>}
		</div>
	);
}

function GenericArtifactCard({ artifact }: ArtifactCardProps) {
	const keyCount = Object.keys(artifact.data).length;
	return (
		<div
			class="flex items-center gap-2 px-3 py-2 rounded bg-dark-700/50 border border-dark-600"
			data-testid="artifact-card-generic"
		>
			<span class="text-xs text-gray-500 font-mono flex-shrink-0">{artifact.artifactType}</span>
			{artifact.artifactKey && (
				<span class="text-xs text-gray-600 truncate">({artifact.artifactKey})</span>
			)}
			<span class="text-xs text-gray-500 ml-auto flex-shrink-0">
				{keyCount} field{keyCount === 1 ? '' : 's'}
			</span>
		</div>
	);
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
	switch (artifact.artifactType) {
		case 'pr':
			return <PrArtifactCard artifact={artifact} />;
		default:
			return <GenericArtifactCard artifact={artifact} />;
	}
}
