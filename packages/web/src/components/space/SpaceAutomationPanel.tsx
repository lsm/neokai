import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AutomationRun, AutomationTask, SpaceWorkflow } from '@neokai/shared';
import { automationStore } from '../../lib/automation-store';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

interface SpaceAutomationPanelProps {
	spaceId: string;
	workflows: SpaceWorkflow[];
}

function formatSchedule(automation: AutomationTask): string {
	if (automation.triggerType === 'interval') {
		const intervalMs = (automation.triggerConfig as { intervalMs?: number }).intervalMs;
		if (!intervalMs) return 'Interval';
		const minutes = Math.round(intervalMs / 60_000);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.round(minutes / 60);
		return `${hours}h`;
	}
	if (automation.triggerType === 'cron') return 'Cron';
	if (automation.triggerType === 'at') return 'Scheduled';
	if (automation.triggerType === 'event') return 'Event';
	if (automation.triggerType === 'manual') return 'Manual';
	return automation.triggerType;
}

function statusClass(status: AutomationTask['status']): string {
	switch (status) {
		case 'active':
			return 'bg-green-900/40 text-green-300 border-green-800/60';
		case 'paused':
			return 'bg-yellow-900/40 text-yellow-300 border-yellow-800/60';
		case 'archived':
			return 'bg-gray-800 text-gray-400 border-gray-700';
	}
}

export function SpaceAutomationPanel({ spaceId, workflows }: SpaceAutomationPanelProps) {
	const automations = automationStore.automations.value;
	const loading = automationStore.isLoading.value;
	const runnableWorkflows = useMemo(() => workflows, [workflows]);
	const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
	const [intervalMinutes, setIntervalMinutes] = useState(60);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [runsByAutomationId, setRunsByAutomationId] = useState<Record<string, AutomationRun[]>>({});

	useEffect(() => {
		void automationStore.subscribeOwner({ ownerType: 'space', ownerId: spaceId });
		return () => automationStore.unsubscribe();
	}, [spaceId]);

	useEffect(() => {
		if (!selectedWorkflowId && runnableWorkflows[0]) {
			setSelectedWorkflowId(runnableWorkflows[0].id);
		}
	}, [runnableWorkflows, selectedWorkflowId]);

	const runAction = async (id: string, action: () => Promise<unknown>, success: string) => {
		setBusyId(id);
		try {
			await action();
			toast.success(success);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Automation action failed');
		} finally {
			setBusyId(null);
		}
	};

	const createWorkflowAutomation = async () => {
		const workflow = runnableWorkflows.find((item) => item.id === selectedWorkflowId);
		if (!workflow) return;
		setCreating(true);
		try {
			await automationStore.create({
				ownerType: 'space',
				ownerId: spaceId,
				title: `${workflow.name} monitor`,
				description: `Create a Space workflow task for "${workflow.name}" from automation.`,
				triggerType: 'interval',
				triggerConfig: { intervalMs: Math.max(1, intervalMinutes) * 60_000 },
				targetType: 'space_workflow',
				targetConfig: {
					spaceId,
					preferredWorkflowId: workflow.id,
					titleTemplate: `${workflow.name} automated run`,
					descriptionTemplate:
						'Run this workflow from the automation scheduler and report completion back to the task ledger.',
					priority: 'normal',
					labels: ['automation'],
				},
				concurrencyPolicy: 'skip',
				notifyPolicy: 'state_changes',
			});
			toast.success('Automation created');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to create automation');
		} finally {
			setCreating(false);
		}
	};

	const loadRuns = async (automationId: string) => {
		setBusyId(automationId);
		try {
			const runs = await automationStore.listRuns({ automationTaskId: automationId, limit: 5 });
			setRunsByAutomationId((current) => ({ ...current, [automationId]: runs }));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to load automation runs');
		} finally {
			setBusyId(null);
		}
	};

	return (
		<section class="space-y-3">
			<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div>
					<h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Automations</h3>
					<p class="mt-1 text-xs text-gray-500">{automations.length} configured for this space.</p>
				</div>
				{runnableWorkflows.length > 0 && (
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
						<select
							class="h-8 rounded border border-dark-600 bg-dark-800 px-2 text-xs text-gray-100"
							value={selectedWorkflowId}
							onChange={(event) => setSelectedWorkflowId(event.currentTarget.value)}
						>
							{runnableWorkflows.map((workflow) => (
								<option key={workflow.id} value={workflow.id}>
									{workflow.name}
								</option>
							))}
						</select>
						<input
							class="h-8 w-24 rounded border border-dark-600 bg-dark-800 px-2 text-xs text-gray-100"
							type="number"
							min={1}
							value={intervalMinutes}
							onInput={(event) => setIntervalMinutes(Number(event.currentTarget.value) || 1)}
						/>
						<Button size="xs" onClick={createWorkflowAutomation} loading={creating}>
							Create
						</Button>
					</div>
				)}
			</div>

			{loading ? (
				<div class="text-xs text-gray-500">Loading automations...</div>
			) : automations.length === 0 ? (
				<div class="rounded border border-dark-700 bg-dark-850 px-3 py-3 text-xs text-gray-500">
					No automations yet.
				</div>
			) : (
				<div class="grid gap-2">
					{automations.map((automation) => (
						<div key={automation.id} class="rounded border border-dark-700 bg-dark-850 px-3 py-3">
							<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
								<div class="min-w-0">
									<div class="flex flex-wrap items-center gap-2">
										<span class="truncate text-sm font-medium text-gray-100">
											{automation.title}
										</span>
										<span
											class={cn(
												'rounded border px-1.5 py-0.5 text-[11px]',
												statusClass(automation.status)
											)}
										>
											{automation.status}
										</span>
										<span class="rounded border border-dark-600 px-1.5 py-0.5 text-[11px] text-gray-400">
											{formatSchedule(automation)}
										</span>
										<span class="rounded border border-dark-600 px-1.5 py-0.5 text-[11px] text-gray-400">
											{automation.targetType}
										</span>
									</div>
									{automation.description && (
										<p class="mt-1 line-clamp-2 text-xs text-gray-500">{automation.description}</p>
									)}
								</div>
								<div class="flex flex-wrap gap-2">
									<Button
										size="xs"
										variant="secondary"
										loading={busyId === automation.id}
										onClick={() =>
											runAction(
												automation.id,
												() => automationStore.triggerNow(automation.id),
												'Automation triggered'
											)
										}
									>
										Run
									</Button>
									<Button
										size="xs"
										variant="secondary"
										loading={busyId === automation.id}
										onClick={() => loadRuns(automation.id)}
									>
										History
									</Button>
									{automation.status === 'active' ? (
										<Button
											size="xs"
											variant="ghost"
											loading={busyId === automation.id}
											onClick={() =>
												runAction(
													automation.id,
													() => automationStore.pause(automation.id),
													'Automation paused'
												)
											}
										>
											Pause
										</Button>
									) : (
										<Button
											size="xs"
											variant="ghost"
											loading={busyId === automation.id}
											onClick={() =>
												runAction(
													automation.id,
													() => automationStore.resume(automation.id),
													'Automation resumed'
												)
											}
										>
											Resume
										</Button>
									)}
									<Button
										size="xs"
										variant="danger"
										loading={busyId === automation.id}
										onClick={() =>
											runAction(
												automation.id,
												() => automationStore.archive(automation.id),
												'Automation archived'
											)
										}
									>
										Archive
									</Button>
								</div>
							</div>
							{runsByAutomationId[automation.id] && (
								<div class="mt-3 border-t border-dark-700 pt-3">
									<div class="grid gap-1.5">
										{runsByAutomationId[automation.id].length === 0 ? (
											<div class="text-xs text-gray-500">No runs yet.</div>
										) : (
											runsByAutomationId[automation.id].map((run) => (
												<div
													key={run.id}
													class="flex flex-wrap items-center gap-2 text-xs text-gray-400"
												>
													<span class="rounded border border-dark-600 px-1.5 py-0.5 text-[11px] text-gray-300">
														{run.status}
													</span>
													<span>{run.triggerReason ?? run.triggerType}</span>
													{run.resultSummary && (
														<span class="truncate text-gray-500">{run.resultSummary}</span>
													)}
													{run.error && <span class="text-red-300">{run.error}</span>}
												</div>
											))
										)}
									</div>
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</section>
	);
}
