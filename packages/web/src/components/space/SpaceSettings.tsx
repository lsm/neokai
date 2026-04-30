/**
 * SpaceSettings — settings panel for a Space.
 *
 * Provides:
 * - Inline editing of name and description
 * - Export Bundle action
 * - Archive / Delete space (danger zone)
 */

import { useState, useEffect } from 'preact/hooks';
import type { Space, SpaceExportBundle, SpaceAutonomyLevel } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager.ts';
import { spaceStore } from '../../lib/space-store.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import { downloadBundle } from './export-import-utils.ts';
import { navigateToSpaces } from '../../lib/router.ts';
import { Button } from '../ui/Button.tsx';
import { AUTONOMY_LEVELS } from '../../lib/space-constants.ts';
import { AutonomyWorkflowSummary } from './AutonomyWorkflowSummary.tsx';
import { SpaceMcpSettings } from './SpaceMcpSettings.tsx';

interface SpaceSettingsProps {
	space: Space;
}

export function SpaceSettings({ space }: SpaceSettingsProps) {
	// Edit state
	const [name, setName] = useState(space.name);
	const [description, setDescription] = useState(space.description ?? '');
	const [instructions, setInstructions] = useState(space.instructions ?? '');
	const [backgroundContext, setBackgroundContext] = useState(space.backgroundContext ?? '');
	const [autonomyLevel, setAutonomyLevel] = useState<SpaceAutonomyLevel>(space.autonomyLevel ?? 1);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [isArchiving, setIsArchiving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	// Keep local state in sync when space prop changes (e.g. after save)
	useEffect(() => {
		setName(space.name);
		setDescription(space.description ?? '');
		setInstructions(space.instructions ?? '');
		setBackgroundContext(space.backgroundContext ?? '');
		setAutonomyLevel(space.autonomyLevel ?? 1);
		setSaveError(null);
	}, [
		space.id,
		space.name,
		space.description,
		space.instructions,
		space.backgroundContext,
		space.autonomyLevel,
	]);

	const isDirty =
		name !== space.name ||
		description !== (space.description ?? '') ||
		instructions !== (space.instructions ?? '') ||
		backgroundContext !== (space.backgroundContext ?? '') ||
		autonomyLevel !== (space.autonomyLevel ?? 1);

	async function handleSave(e: Event) {
		e.preventDefault();
		if (!name.trim()) {
			setSaveError('Space name is required');
			return;
		}
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			setSaveError('Not connected to server');
			return;
		}
		try {
			setSaving(true);
			setSaveError(null);
			await hub.request('space.update', {
				id: space.id,
				name: name.trim(),
				description: description.trim() || undefined,
				instructions: instructions.trim() || undefined,
				backgroundContext: backgroundContext.trim() || undefined,
				autonomyLevel,
			});
			toast.success('Space updated');
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
		} finally {
			setSaving(false);
		}
	}

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

	async function handleArchive() {
		if (
			!confirm(
				`Archive "${space.name}"? The space will be hidden from the main list but can be restored later.`
			)
		) {
			return;
		}
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setIsArchiving(true);
			await hub.request('space.archive', { id: space.id });
			toast.success(`Space "${space.name}" archived`);
			navigateToSpaces();
		} catch (err) {
			toast.error(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setIsArchiving(false);
		}
	}

	async function handleDelete() {
		if (
			!confirm(
				`Permanently delete "${space.name}"? This will remove all agents, workflows, tasks, and runs. This cannot be undone.`
			)
		) {
			return;
		}
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			toast.error('Not connected to server');
			return;
		}
		try {
			setIsDeleting(true);
			await hub.request('space.delete', { id: space.id });
			toast.success(`Space "${space.name}" deleted`);
			navigateToSpaces();
		} catch (err) {
			toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setIsDeleting(false);
		}
	}

	return (
		<div class="flex flex-col h-full overflow-y-auto p-6">
			<div class="min-h-[calc(100%+1px)] space-y-6">
				{/* Edit name & description */}
				<section class="space-y-4">
					<h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">General</h3>

					<form onSubmit={handleSave} class="space-y-3">
						{saveError && (
							<div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-2 text-red-400 text-sm">
								{saveError}
							</div>
						)}

						<div>
							<label class="block text-xs font-medium text-gray-400 mb-1">Name</label>
							<input
								type="text"
								value={name}
								onInput={(e) => setName((e.target as HTMLInputElement).value)}
								class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100
								placeholder-gray-600 focus:outline-none focus:border-blue-500 text-sm"
							/>
						</div>

						<div>
							<label class="block text-xs font-medium text-gray-400 mb-1">
								Description
								<span class="text-gray-600 ml-1">(optional)</span>
							</label>
							<textarea
								value={description}
								onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
								placeholder="Brief description of this space..."
								rows={3}
								class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100
								placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none text-sm"
							/>
						</div>

						<div>
							<label class="block text-xs font-medium text-gray-400 mb-1">
								Instructions
								<span class="text-gray-600 ml-1">(optional)</span>
							</label>
							<p class="text-xs text-gray-500 mb-1">
								Operator instructions for all agents in this space. Injected as{' '}
								<code class="text-gray-400">## Space Instructions</code> in every agent's system
								prompt.
							</p>
							<textarea
								value={instructions}
								onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
								placeholder="e.g. Always use TypeScript strict mode. Prefer functional components..."
								rows={5}
								class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100
								placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y text-sm"
							/>
							<div class="text-xs text-gray-600 mt-0.5 text-right">
								{instructions.length} characters
							</div>
						</div>

						<div>
							<label class="block text-xs font-medium text-gray-400 mb-1">
								Background Context
								<span class="text-gray-600 ml-1">(optional)</span>
							</label>
							<p class="text-xs text-gray-500 mb-1">
								Project or codebase context. Injected as{' '}
								<code class="text-gray-400">## Space Background</code> or{' '}
								<code class="text-gray-400">## Project Context</code> in agent prompts.
							</p>
							<textarea
								value={backgroundContext}
								onInput={(e) => setBackgroundContext((e.target as HTMLTextAreaElement).value)}
								placeholder="e.g. This project uses Bun + Hono backend, Preact frontend with Tailwind CSS..."
								rows={5}
								class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100
								placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y text-sm"
							/>
							<div class="text-xs text-gray-600 mt-0.5 text-right">
								{backgroundContext.length} characters
							</div>
						</div>

						<div>
							<label class="block text-xs font-medium text-gray-400 mb-1">Autonomy Level</label>
							<p class="text-xs text-gray-500 mb-2">
								Controls how much authority agents have. Higher levels auto-approve more actions;
								lower levels require human sign-off.
							</p>
							<div class="space-y-1">
								{AUTONOMY_LEVELS.map(({ level, label, description }) => (
									<button
										key={level}
										type="button"
										onClick={() => setAutonomyLevel(level)}
										data-testid={`autonomy-level-${level}`}
										class={cn(
											'w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors',
											autonomyLevel === level
												? 'border-blue-500/60 bg-blue-500/10 text-gray-100'
												: 'border-dark-700 bg-dark-800 text-gray-400 hover:border-dark-600 hover:text-gray-300'
										)}
									>
										<span
											class={cn(
												'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold',
												autonomyLevel === level
													? 'bg-blue-500/20 text-blue-400'
													: 'bg-dark-700 text-gray-500'
											)}
										>
											{level}
										</span>
										<div class="min-w-0">
											<div class="text-sm font-medium">{label}</div>
											<div class="text-xs text-gray-500">{description}</div>
										</div>
									</button>
								))}
							</div>
							<AutonomyWorkflowSummary
								level={autonomyLevel}
								workflows={spaceStore.workflows.value}
								class="mt-2"
							/>
						</div>

						{isDirty && (
							<div class="flex gap-2 justify-end">
								<Button
									type="button"
									variant="secondary"
									size="sm"
									onClick={() => {
										setName(space.name);
										setDescription(space.description ?? '');
										setInstructions(space.instructions ?? '');
										setBackgroundContext(space.backgroundContext ?? '');
										setAutonomyLevel(space.autonomyLevel ?? 1);
										setSaveError(null);
									}}
								>
									Discard
								</Button>
								<Button type="submit" size="sm" loading={saving}>
									Save Changes
								</Button>
							</div>
						)}
					</form>

					{/* Workspace path — read-only */}
					<div>
						<label class="block text-xs font-medium text-gray-400 mb-1">Workspace Path</label>
						<p class="text-xs text-gray-500 font-mono break-all">{space.workspacePath}</p>
					</div>
				</section>

				{/* MCP Servers — per-space overrides for the application MCP registry. */}
				<SpaceMcpSettings spaceId={space.id} disabled={saving} />

				<section class="space-y-3 border border-dark-700 rounded-lg p-4 bg-dark-900/40">
					<h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">
						GitHub watched repositories
					</h3>
					<p class="text-xs text-gray-500">
						Configure owner/repo watches for this Space via the{' '}
						<span class="font-mono">space.github.*</span> RPCs. Webhooks should point to{' '}
						<span class="font-mono">/webhook/github/space</span> and include events:{' '}
						<span class="font-mono">
							issue_comment, pull_request_review, pull_request_review_comment, pull_request
						</span>
						. For local iMac development, expose the daemon with Tailscale Funnel or an equivalent
						public HTTPS tunnel; GitHub cannot deliver webhooks to private Tailnet-only 100.x
						addresses.
					</p>
					<div class="rounded bg-dark-800 border border-dark-700 p-3 text-xs text-gray-400 space-y-1">
						<div>
							Webhook URL:{' '}
							<span class="font-mono text-gray-300">
								https://&lt;public-host&gt;/webhook/github/space
							</span>
						</div>
						<div>
							Local example: <span class="font-mono text-gray-300">tailscale funnel 8383</span>{' '}
							forwarding to the daemon webhook endpoint.
						</div>
						<div>
							Security: signatures use per-repo webhook secrets and unwatched repos are rejected
							before routing.
						</div>
					</div>
				</section>

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
							<dd class="text-xs text-gray-300">
								{new Date(space.createdAt).toLocaleDateString()}
							</dd>
						</div>
					</dl>
				</section>

				{/* Danger zone */}
				<section class="space-y-3 border border-red-900/40 rounded-lg p-4">
					<h3 class="text-xs font-semibold text-red-400 uppercase tracking-wider">Danger Zone</h3>

					<div class="flex items-center justify-between gap-4">
						<div>
							<p class="text-sm text-gray-300">Archive space</p>
							<p class="text-xs text-gray-500 mt-0.5">
								Hide from the main list. Can be restored later.
							</p>
						</div>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={handleArchive}
							disabled={space.status === 'archived' || isArchiving}
							loading={isArchiving}
						>
							Archive
						</Button>
					</div>

					<div class="border-t border-red-900/30 pt-3 flex items-center justify-between gap-4">
						<div>
							<p class="text-sm text-gray-300">Delete space</p>
							<p class="text-xs text-gray-500 mt-0.5">
								Permanently remove this space and all its data.
							</p>
						</div>
						<Button
							type="button"
							variant="danger"
							size="sm"
							onClick={handleDelete}
							disabled={isDeleting}
							loading={isDeleting}
						>
							Delete
						</Button>
					</div>
				</section>
			</div>
		</div>
	);
}
