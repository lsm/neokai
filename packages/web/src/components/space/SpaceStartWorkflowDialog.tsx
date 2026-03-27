/**
 * SpaceStartWorkflowDialog — modal form to start a new workflow run in a Space.
 */

import { useState } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { connectionManager } from '../../lib/connection-manager';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import type { SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';

interface SpaceStartWorkflowDialogProps {
	isOpen: boolean;
	spaceId: string;
	workflows: SpaceWorkflow[];
	onClose: () => void;
	onStarted?: (run: SpaceWorkflowRun) => void;
}

export function SpaceStartWorkflowDialog({
	isOpen,
	spaceId,
	workflows,
	onClose,
	onStarted,
}: SpaceStartWorkflowDialogProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [workflowId, setWorkflowId] = useState<string>(workflows[0]?.id ?? '');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleClose = () => {
		setTitle('');
		setDescription('');
		setWorkflowId(workflows[0]?.id ?? '');
		setError(null);
		onClose();
	};

	const handleSubmit = async (e: Event) => {
		e.preventDefault();

		if (!title.trim()) {
			setError('Run title is required');
			return;
		}

		if (workflows.length > 0 && !workflowId) {
			setError('Please select a workflow');
			return;
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			setError('Not connected to server');
			return;
		}

		try {
			setSubmitting(true);
			setError(null);

			const { run } = await hub.request<{ run: SpaceWorkflowRun }>('spaceWorkflowRun.start', {
				spaceId,
				workflowId: workflowId || undefined,
				title: title.trim(),
				description: description.trim() || undefined,
			});

			if (!run) {
				throw new Error('Server returned no data');
			}

			toast.success(`Workflow run "${run.title}" started`);
			onStarted?.(run);
			// Refresh space data so the dashboard reflects the new run
			await spaceStore.selectSpace(spaceId).catch(() => {});
			handleClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to start workflow run');
		} finally {
			setSubmitting(false);
		}
	};

	const hasWorkflows = workflows.length > 0;

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title="Start Workflow Run" size="md">
			<form onSubmit={handleSubmit} class="space-y-4">
				{error && (
					<div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
						{error}
					</div>
				)}

				{!hasWorkflows && (
					<div class="bg-amber-900/20 border border-amber-800 rounded-lg px-4 py-3 text-amber-300 text-sm">
						No workflows configured for this space. Create a workflow in the Workflows tab first.
					</div>
				)}

				{/* Workflow selector — only shown when multiple workflows exist */}
				{workflows.length > 1 && (
					<div>
						<label class="block text-sm font-medium text-gray-200 mb-1.5">Workflow</label>
						<select
							value={workflowId}
							onChange={(e) => setWorkflowId((e.target as HTMLSelectElement).value)}
							class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100
								focus:outline-none focus:border-blue-500 text-sm"
						>
							{workflows.map((wf) => (
								<option key={wf.id} value={wf.id}>
									{wf.name}
								</option>
							))}
						</select>
					</div>
				)}

				{/* Single workflow indicator */}
				{workflows.length === 1 && (
					<div class="flex items-center gap-2 text-sm text-gray-400">
						<span class="text-gray-500">Workflow:</span>
						<span class="text-gray-200">{workflows[0].name}</span>
					</div>
				)}

				{/* Run title */}
				<div>
					<label class="block text-sm font-medium text-gray-200 mb-1.5">
						Run Title
						<span class="text-red-400 ml-1">*</span>
					</label>
					<input
						type="text"
						value={title}
						onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
						placeholder="e.g., Sprint 12 feature implementation"
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
							placeholder-gray-600 focus:outline-none focus:border-blue-500 text-sm"
						autoFocus
						disabled={!hasWorkflows}
					/>
				</div>

				{/* Description */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Description
						<span class="text-gray-500 text-xs ml-2">(optional)</span>
					</label>
					<textarea
						value={description}
						onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
						placeholder="Describe the goal of this workflow run..."
						rows={3}
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
							placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none text-sm"
						disabled={!hasWorkflows}
					/>
				</div>

				<div class="flex gap-3 pt-1">
					<Button type="button" variant="secondary" onClick={handleClose} fullWidth>
						Cancel
					</Button>
					<Button type="submit" loading={submitting} disabled={!hasWorkflows} fullWidth>
						Start Run
					</Button>
				</div>
			</form>
		</Modal>
	);
}
