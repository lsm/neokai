/**
 * SpaceSettings — settings panel for a Space with "Export Bundle" action.
 */

import type { Space, SpaceExportBundle } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { downloadBundle } from './export-import-utils.ts';

interface SpaceSettingsProps {
	space: Space;
}

export function SpaceSettings({ space }: SpaceSettingsProps) {
	async function exportBundle() {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Connection lost.');
			return;
		}
		try {
			const { bundle } = await hub.request<{ bundle: SpaceExportBundle }>('spaceExport.bundle', {
				spaceId: space.id,
			});
			downloadBundle(bundle, space.name, 'bundle');
			toast.success(`Bundle exported for "${space.name}"`);
		} catch (err) {
			toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return (
		<div class="flex flex-col h-full p-6 space-y-6">
			<div>
				<h2 class="text-base font-semibold text-gray-100 mb-1">{space.name}</h2>
				{space.description && <p class="text-sm text-gray-400">{space.description}</p>}
				<p class="text-xs text-gray-600 font-mono mt-1">{space.workspacePath}</p>
			</div>

			{/* Export section */}
			<section class="space-y-3">
				<h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Export</h3>
				<p class="text-xs text-gray-500">
					Download all agents and workflows as a portable{' '}
					<span class="font-mono">.neokai.json</span> bundle.
				</p>
				<button
					type="button"
					onClick={exportBundle}
					class="flex items-center gap-2 px-3 py-2 text-sm text-gray-200 bg-dark-800 hover:bg-dark-700 border border-dark-600 rounded-lg transition-colors"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
						/>
					</svg>
					Export Bundle
				</button>
			</section>

			{/* Space metadata */}
			<section class="space-y-2">
				<h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Details</h3>
				<dl class="space-y-1">
					<div class="flex gap-2">
						<dt class="text-xs text-gray-500 w-20 flex-shrink-0">Status</dt>
						<dd class="text-xs text-gray-300 capitalize">{space.status}</dd>
					</div>
					<div class="flex gap-2">
						<dt class="text-xs text-gray-500 w-20 flex-shrink-0">ID</dt>
						<dd class="text-xs text-gray-500 font-mono truncate">{space.id}</dd>
					</div>
					<div class="flex gap-2">
						<dt class="text-xs text-gray-500 w-20 flex-shrink-0">Created</dt>
						<dd class="text-xs text-gray-300">{new Date(space.createdAt).toLocaleDateString()}</dd>
					</div>
				</dl>
			</section>
		</div>
	);
}
