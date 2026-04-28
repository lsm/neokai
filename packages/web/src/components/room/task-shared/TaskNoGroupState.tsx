import type { NeoTask, TaskRuntimeDiagnostic } from '@neokai/shared';

interface TaskNoGroupStateProps {
	task: NeoTask;
	diagnostic: TaskRuntimeDiagnostic | null;
	canReactivate: boolean;
	reactivating: boolean;
	onReactivate: () => void;
	canArchive: boolean;
	onArchive: () => void;
}

type StateTone = 'gray' | 'blue' | 'emerald' | 'amber' | 'red';

interface StateCopy {
	title: string;
	description: string;
	tone: StateTone;
	iconPath: string;
}

function getStateCopy(task: NeoTask): StateCopy {
	switch (task.status) {
		case 'pending':
			return {
				title: 'Waiting for the runtime to pick up this task',
				description: 'No agent group has started yet.',
				tone: 'gray',
				iconPath: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
			};
		case 'completed':
			return {
				title: 'Task completed',
				description: 'This task finished without an active conversation to show here.',
				tone: 'emerald',
				iconPath: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
			};
		case 'needs_attention':
			return {
				title: 'Task needs attention before it can run',
				description: 'No agent group is active for this task.',
				tone: 'red',
				iconPath:
					'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
			};
		case 'review':
			return {
				title: 'Loading conversation history',
				description: 'If this takes too long, reload the page.',
				tone: 'blue',
				iconPath:
					'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
			};
		case 'draft':
			return {
				title: 'This task is a draft',
				description: 'Draft tasks have not been scheduled yet.',
				tone: 'gray',
				iconPath:
					'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
			};
		case 'cancelled':
			return {
				title: 'This task was cancelled',
				description: 'No further action will be taken unless it is reactivated.',
				tone: 'gray',
				iconPath: 'M6 18L18 6M6 6l12 12',
			};
		case 'in_progress':
			return {
				title: 'Runtime attachment missing',
				description: 'This task is marked in progress, but no agent group is attached.',
				tone: 'red',
				iconPath:
					'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
			};
		default:
			return {
				title: 'No active agent group',
				description: 'No agent group has been spawned for this task.',
				tone: 'gray',
				iconPath: 'M9 5l7 7-7 7',
			};
	}
}

function toneClasses(tone: StateTone): { iconBg: string; iconText: string; title: string } {
	switch (tone) {
		case 'blue':
			return {
				iconBg: 'bg-blue-900/30',
				iconText: 'text-blue-400',
				title: 'text-blue-400',
			};
		case 'emerald':
			return {
				iconBg: 'bg-emerald-900/30',
				iconText: 'text-emerald-400',
				title: 'text-emerald-400',
			};
		case 'amber':
			return {
				iconBg: 'bg-amber-900/30',
				iconText: 'text-amber-400',
				title: 'text-amber-400',
			};
		case 'red':
			return {
				iconBg: 'bg-red-950/40',
				iconText: 'text-red-400',
				title: 'text-red-400',
			};
		case 'gray':
			return {
				iconBg: 'bg-dark-700',
				iconText: 'text-gray-500',
				title: 'text-gray-400',
			};
	}
}

export function TaskNoGroupState({
	task,
	canReactivate,
	reactivating,
	onReactivate,
	canArchive,
	onArchive,
	diagnostic,
}: TaskNoGroupStateProps) {
	const copy = getStateCopy(task);
	const tone = toneClasses(copy.tone);
	const requiresGit = diagnostic?.requiresGitWorkspace ?? false;
	const taskType = diagnostic?.taskType ?? task.taskType ?? 'coding';
	const rawAssignedAgent = diagnostic?.assignedAgent ?? task.assignedAgent;
	const agentLabel =
		(taskType === 'planning' || taskType === 'goal_review') && rawAssignedAgent === 'coder'
			? 'planner'
			: (rawAssignedAgent ?? 'general');
	const workspaceLabel =
		diagnostic?.workspaceMode === 'temporary_workspace'
			? 'Temporary workspace'
			: requiresGit
				? 'Git worktree required'
				: 'Temporary workspace supported';
	const errorMessage = diagnostic?.message ?? task.error;
	const shouldShowGitGuidance =
		diagnostic?.failureCode === 'git_worktree_unavailable' &&
		diagnostic.recommendedActions.includes('convert_to_research_task');

	return (
		<div class="flex-1 flex items-center justify-center p-6 sm:p-8">
			<div
				class="w-full max-w-2xl rounded-lg border border-dark-700 bg-dark-850/70 p-5 sm:p-6 text-left shadow-xl"
				data-testid="task-no-group-state"
			>
				<div class="flex items-start gap-4">
					<div class={`rounded-full p-3 flex-shrink-0 ${tone.iconBg}`}>
						<svg
							class={`w-6 h-6 ${tone.iconText}`}
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d={copy.iconPath}
							/>
						</svg>
					</div>
					<div class="min-w-0 flex-1">
						<p class={`text-base font-semibold ${tone.title}`}>{copy.title}</p>
						<p class="mt-1 text-sm text-gray-500">{copy.description}</p>

						<div class="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
							<div class="rounded border border-dark-700 bg-dark-900/70 px-3 py-2">
								<div class="text-[11px] uppercase tracking-wide text-gray-600">Task type</div>
								<div class="mt-1 text-gray-300">{taskType}</div>
							</div>
							<div class="rounded border border-dark-700 bg-dark-900/70 px-3 py-2">
								<div class="text-[11px] uppercase tracking-wide text-gray-600">Agent</div>
								<div class="mt-1 text-gray-300">{agentLabel}</div>
							</div>
							<div class="rounded border border-dark-700 bg-dark-900/70 px-3 py-2">
								<div class="text-[11px] uppercase tracking-wide text-gray-600">Workspace</div>
								<div class="mt-1 text-gray-300">{workspaceLabel}</div>
							</div>
						</div>

						{errorMessage && (
							<div
								class="mt-4 rounded border border-red-900/50 bg-red-950/20 px-3 py-2"
								data-testid="task-no-group-error"
							>
								<div class="text-[11px] uppercase tracking-wide text-red-500/80">Error</div>
								<p class="mt-1 break-words text-sm text-red-300">{errorMessage}</p>
							</div>
						)}

						{shouldShowGitGuidance && (
							<p class="mt-3 text-sm text-gray-500">
								This task type runs in a Git worktree. For web, API, or data collection work, use a
								research task with a general agent.
							</p>
						)}

						{(canReactivate || canArchive) && (
							<div class="mt-5 flex flex-wrap gap-2">
								{canReactivate && (
									<button
										type="button"
										data-testid="task-no-group-retry"
										onClick={onReactivate}
										disabled={reactivating}
										class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
									>
										{reactivating ? 'Retrying...' : 'Retry task'}
									</button>
								)}
								{canArchive && (
									<button
										type="button"
										data-testid="task-no-group-archive"
										onClick={onArchive}
										class="rounded border border-dark-600 px-3 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-dark-500 hover:bg-dark-700"
									>
										Archive
									</button>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
