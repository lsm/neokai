/**
 * AutonomyWorkflowSummary — "X of Y workflows run without approval" hint.
 *
 * Rendered below the autonomy selector in Space settings and next to the
 * slim autonomy bar on the Space Overview. Updates live as the user changes
 * `level`.
 *
 * The component is purely derived from the `workflows` + `level` props — no
 * RPC, no signals, no side effects. It's safe to render inside any parent
 * that already has the workflow list in scope.
 */

import { useMemo, useState } from 'preact/hooks';
import type { SpaceAutonomyLevel, SpaceWorkflow } from '@neokai/shared';
import { EMPTY_ACTIONS_AUTONOMY_THRESHOLD, countAutonomousWorkflows } from '@neokai/shared';
import { cn } from '../../lib/utils.ts';

interface AutonomyWorkflowSummaryProps {
	level: SpaceAutonomyLevel;
	workflows: SpaceWorkflow[];
	/** Optional extra tailwind classes applied to the wrapper. */
	class?: string;
	/**
	 * When `true`, render in "compact" mode — smaller text and inline
	 * chevron. Used on the Space Overview where space is tight.
	 */
	compact?: boolean;
}

export function AutonomyWorkflowSummary({
	level,
	workflows,
	class: className,
	compact = false,
}: AutonomyWorkflowSummaryProps) {
	const [expanded, setExpanded] = useState(false);

	const count = useMemo(() => countAutonomousWorkflows(workflows, level), [workflows, level]);

	// Nothing to say before workflows have loaded (or when the space has none).
	if (count.total === 0) {
		return null;
	}

	const hasDetails = count.blocking.length > 0;
	const textSize = compact ? 'text-[11px]' : 'text-xs';

	return (
		<div class={cn('space-y-1', className)} data-testid="autonomy-workflow-summary">
			<div class={cn('flex items-center gap-2', textSize, 'text-gray-400')}>
				<span data-testid="autonomy-workflow-summary-count">
					Level {level}:{' '}
					<span class="text-gray-200 font-medium tabular-nums">
						{count.autonomous} of {count.total}
					</span>{' '}
					{count.total === 1 ? 'workflow runs' : 'workflows run'} without approval
				</span>
				{hasDetails && (
					<button
						type="button"
						onClick={() => setExpanded((prev) => !prev)}
						data-testid="autonomy-workflow-summary-toggle"
						class="text-gray-500 hover:text-gray-300 transition-colors"
						aria-expanded={expanded}
					>
						{expanded ? 'Hide details' : 'Show details'}
					</button>
				)}
			</div>

			{expanded && hasDetails && (
				<ul
					class={cn('space-y-1 pl-2 border-l border-dark-700', textSize, 'text-gray-500')}
					data-testid="autonomy-workflow-summary-details"
				>
					{count.blocking.map((wf) => (
						<li key={wf.workflowId} class="leading-snug">
							<span class="text-gray-300">{wf.workflowName}</span>
							{wf.blockedBy.length === 0 ? (
								<> — requires level {EMPTY_ACTIONS_AUTONOMY_THRESHOLD} or higher</>
							) : (
								<>
									{' '}
									— blocked by:{' '}
									{wf.blockedBy.map((b, idx) => (
										<span key={b.actionId}>
											{idx > 0 && ', '}
											<span class="text-gray-400">{b.actionName}</span> (requires level{' '}
											{b.requiredLevel})
										</span>
									))}
								</>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
