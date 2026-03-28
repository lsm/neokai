/**
 * WorkflowRunStartDialog — modal form to start a workflow run from the dashboard.
 * Reads available workflows from spaceStore and delegates to spaceStore.startWorkflowRun().
 */

import { useState, useEffect } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import type { SpaceWorkflowRun } from '@neokai/shared';

interface WorkflowRunStartDialogProps {
	isOpen: boolean;
	onClose: () => void;
	onSwitchToWorkflows?: () => void;
	onStarted?: (run: SpaceWorkflowRun) => void;
}

function buildAutoTitle(workflowName: string): string {
	const now = new Date();
	const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
	return `${workflowName} — ${stamp}`;
}

export function WorkflowRunStartDialog({
	isOpen,
	onClose,
	onSwitchToWorkflows,
	onStarted,
}: WorkflowRunStartDialogProps) {
	const workflows = spaceStore.workflows.value;
	const [workflowId, setWorkflowId] = useState<string>(workflows[0]?.id ?? '');
	const [title, setTitle] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Keep workflowId in sync when workflows load asynchronously
	useEffect(() => {
		if (!workflowId && workflows.length > 0) {
			setWorkflowId(workflows[0].id);
		}
	}, [workflows, workflowId]);

	const handleClose = () => {
		setTitle('');
		setWorkflowId(workflows[0]?.id ?? '');
		setError(null);
		onClose();
	};

	const handleSubmit = async (e: Event) => {
		e.preventDefault();

		if (!workflowId) {
			setError('Please select a workflow');
			return;
		}

		const selectedWorkflow = workflows.find((w) => w.id === workflowId);
		const resolvedTitle = title.trim() || buildAutoTitle(selectedWorkflow?.name ?? 'Run');

		try {
			setSubmitting(true);
			setError(null);

			const run = await spaceStore.startWorkflowRun({
				workflowId,
				title: resolvedTitle,
			});

			toast.success(`Workflow run "${run.title}" started`);
			onStarted?.(run);
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
					<div class="bg-amber-900/20 border border-amber-800 rounded-lg px-4 py-3 text-amber-300 text-sm space-y-2">
						<p>No workflows available. Create one in the Workflows tab.</p>
						{onSwitchToWorkflows && (
							<button
								type="button"
								onClick={() => {
									handleClose();
									onSwitchToWorkflows();
								}}
								class="text-blue-400 hover:text-blue-300 underline text-xs"
							>
								Go to Workflows tab
							</button>
						)}
					</div>
				)}

				{/* Workflow selector — shown only when multiple workflows exist */}
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

				{/* Run title — optional; auto-suggested from workflow name + timestamp */}
				<div>
					<label class="block text-sm font-medium text-gray-200 mb-1.5">
						Run Title
						<span class="text-gray-500 text-xs ml-2">(optional)</span>
					</label>
					<input
						type="text"
						value={title}
						onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
						placeholder={
							hasWorkflows
								? buildAutoTitle(workflows.find((w) => w.id === workflowId)?.name ?? 'Run')
								: 'Select a workflow first'
						}
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100
							placeholder-gray-600 focus:outline-none focus:border-blue-500 text-sm"
						autoFocus
						disabled={!hasWorkflows}
					/>
					<p class="text-xs text-gray-500 mt-1">Leave blank to use an auto-generated title.</p>
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
