import { useEffect, useMemo, useState } from 'preact/hooks';
import type { AutomationRun, AutomationRunEvent, AutomationTask, RoomGoal } from '@neokai/shared';
import { automationStore } from '../../lib/automation-store';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

interface AutomationPanelProps {
	roomId: string;
	goals: RoomGoal[];
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

export function AutomationPanel({ roomId, goals }: AutomationPanelProps) {
	const automations = automationStore.automations.value;
	const loading = automationStore.isLoading.value;
	const [selectedGoalId, setSelectedGoalId] = useState('');
	const [intervalMinutes, setIntervalMinutes] = useState(60);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [view, setView] = useState<'queue' | 'runs' | 'attention'>('queue');
	const [runsByAutomationId, setRunsByAutomationId] = useState<Record<string, AutomationRun[]>>({});
	const [eventsByRunId, setEventsByRunId] = useState<Record<string, AutomationRunEvent[]>>({});

	const recurringGoals = useMemo(
		() => goals.filter((goal) => goal.missionType === 'recurring' && goal.status === 'active'),
		[goals]
	);
	const attentionAutomations = automations.filter((automation) => {
		return automation.pausedReason || automation.consecutiveFailureCount > 0;
	});
	const visibleAutomations =
		view === 'attention'
			? attentionAutomations
			: view === 'queue'
				? automations.filter((automation) => automation.status === 'active')
				: automations;

	useEffect(() => {
		void automationStore.subscribeOwner({ ownerType: 'room', ownerId: roomId });
		return () => automationStore.unsubscribe();
	}, [roomId]);

	useEffect(() => {
		if (!selectedGoalId && recurringGoals[0]) {
			setSelectedGoalId(recurringGoals[0].id);
		}
	}, [recurringGoals, selectedGoalId]);

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

	const createMissionAutomation = async () => {
		const goal = recurringGoals.find((item) => item.id === selectedGoalId);
		if (!goal) return;
		setCreating(true);
		try {
			await automationStore.create({
				ownerType: 'room',
				ownerId: roomId,
				title: `${goal.title} monitor`,
				description: `Trigger recurring mission "${goal.title}" from room automation.`,
				triggerType: 'interval',
				triggerConfig: { intervalMs: Math.max(1, intervalMinutes) * 60_000 },
				targetType: 'room_mission',
				targetConfig: {
					roomId,
					goalId: goal.id,
					action: 'trigger',
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
			const eventEntries = await Promise.all(
				runs.map(async (run) => [
					run.id,
					await automationStore.listRunEvents({ automationRunId: run.id, limit: 8 }),
				])
			);
			setEventsByRunId((current) => ({
				...current,
				...Object.fromEntries(eventEntries),
			}));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to load automation runs');
		} finally {
			setBusyId(null);
		}
	};

	return (
		<section class="border-b border-dark-700 bg-dark-900/60 px-4 py-4">
			<div class="max-w-5xl mx-auto space-y-4">
				<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<div>
						<h3 class="text-sm font-semibold text-gray-100">Automations</h3>
						<p class="text-xs text-gray-400">{automations.length} configured</p>
					</div>
					{recurringGoals.length > 0 && (
						<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
							<select
								class="h-8 rounded border border-dark-600 bg-dark-800 px-2 text-xs text-gray-100"
								value={selectedGoalId}
								onChange={(event) => setSelectedGoalId(event.currentTarget.value)}
							>
								{recurringGoals.map((goal) => (
									<option key={goal.id} value={goal.id}>
										{goal.title}
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
							<Button size="xs" onClick={createMissionAutomation} loading={creating}>
								Create
							</Button>
						</div>
					)}
				</div>
				<div class="flex flex-wrap gap-2 border-b border-dark-700 pb-2">
					{[
						[
							'queue',
							`Work Queue (${automations.filter((item) => item.status === 'active').length})`,
						],
						['runs', 'Runs History'],
						['attention', `Attention (${attentionAutomations.length})`],
					].map(([id, label]) => (
						<button
							key={id}
							type="button"
							class={cn(
								'rounded border px-2 py-1 text-xs',
								view === id
									? 'border-blue-500 bg-blue-950/40 text-blue-200'
									: 'border-dark-600 bg-dark-850 text-gray-400 hover:text-gray-200'
							)}
							onClick={() => setView(id as 'queue' | 'runs' | 'attention')}
						>
							{label}
						</button>
					))}
				</div>

				{loading ? (
					<div class="text-xs text-gray-500">Loading automations...</div>
				) : visibleAutomations.length === 0 ? (
					<div class="rounded border border-dark-700 bg-dark-850 px-3 py-3 text-xs text-gray-500">
						{view === 'attention' ? 'No automations need attention.' : 'No automations yet.'}
					</div>
				) : (
					<div class="grid gap-2">
						{visibleAutomations.map((automation) => (
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
											<p class="mt-1 line-clamp-2 text-xs text-gray-500">
												{automation.description}
											</p>
										)}
										{automation.pausedReason && (
											<p class="mt-1 text-xs text-yellow-300">{automation.pausedReason}</p>
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
												runsByAutomationId[automation.id].map((run) => {
													const events = eventsByRunId[run.id] ?? [];
													return (
														<div
															key={run.id}
															class="rounded border border-dark-700 bg-dark-900/60 p-2"
														>
															<div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
																<span class="rounded border border-dark-600 px-1.5 py-0.5 text-[11px] text-gray-300">
																	{run.status}
																</span>
																<span>{run.triggerReason ?? run.triggerType}</span>
																{run.resultSummary && (
																	<span class="truncate text-gray-500">{run.resultSummary}</span>
																)}
																{run.error && <span class="text-red-300">{run.error}</span>}
															</div>
															{events.length > 0 && (
																<div class="mt-2 grid gap-1 border-l border-dark-600 pl-2">
																	{events.map((event) => (
																		<div key={event.id} class="text-[11px] text-gray-500">
																			<span class="text-gray-300">{event.eventType}</span>
																			{event.message ? ` · ${event.message}` : ''}
																		</div>
																	))}
																</div>
															)}
														</div>
													);
												})
											)}
										</div>
									</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>
		</section>
	);
}
