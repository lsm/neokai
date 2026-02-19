/**
 * TaskSessionView Component
 *
 * Visualizes the sessions involved in a task execution.
 * Supports different execution modes (single, parallel, serial, parallel_then_merge)
 * with visual flow indicators and status tracking.
 */

import type { TaskSession, TaskExecutionMode } from '@neokai/shared';

interface TaskSessionViewProps {
	taskId: string;
	sessions: TaskSession[];
	executionMode: TaskExecutionMode;
}

/**
 * Truncates a session ID for display
 */
function truncateSessionId(sessionId: string): string {
	return sessionId.length > 12 ? `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}` : sessionId;
}

/**
 * Get styling for role badge
 */
function getRoleBadgeStyle(role: TaskSession['role']): string {
	switch (role) {
		case 'primary':
			return 'bg-blue-600 text-blue-100';
		case 'secondary':
			return 'bg-gray-600 text-gray-100';
		case 'reviewer':
			return 'bg-purple-600 text-purple-100';
		default:
			return 'bg-gray-600 text-gray-100';
	}
}

/**
 * Get icon and label for execution mode
 */
function getExecutionModeInfo(mode: TaskExecutionMode): {
	label: string;
	icon: string;
	description: string;
} {
	switch (mode) {
		case 'single':
			return {
				label: 'Single Worker',
				icon: '1',
				description: 'One session handles the entire task',
			};
		case 'parallel':
			return {
				label: 'Parallel Workers',
				icon: '||',
				description: 'Multiple sessions work simultaneously',
			};
		case 'serial':
			return {
				label: 'Serial Workers',
				icon: '->',
				description: 'Sessions work one after another',
			};
		case 'parallel_then_merge':
			return {
				label: 'Parallel + Review',
				icon: 'Y',
				description: 'Parallel work followed by review',
			};
		default:
			return {
				label: 'Unknown',
				icon: '?',
				description: 'Unknown execution mode',
			};
	}
}

/**
 * Status indicator component for a session
 */
function StatusIndicator({ status }: { status: TaskSession['status'] }) {
	switch (status) {
		case 'pending':
			return <span class="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-gray-500" title="Pending" />;
		case 'active':
			return (
				<div class="relative flex-shrink-0 w-2.5 h-2.5">
					<span class="absolute inset-0 rounded-full bg-green-500 animate-pulse" />
					<span class="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-50" />
				</div>
			);
		case 'completed':
			return (
				<span class="flex-shrink-0 w-2.5 h-2.5 text-green-500" title="Completed">
					<svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
						<path
							fill-rule="evenodd"
							d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
							clip-rule="evenodd"
						/>
					</svg>
				</span>
			);
		case 'failed':
			return (
				<span class="flex-shrink-0 w-2.5 h-2.5 text-red-500" title="Failed">
					<svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
						<path
							fill-rule="evenodd"
							d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
							clip-rule="evenodd"
						/>
					</svg>
				</span>
			);
		default:
			return null;
	}
}

/**
 * Session card component
 */
function SessionCard({ session, showLink }: { session: TaskSession; showLink: boolean }) {
	const canLink = showLink && (session.status === 'active' || session.status === 'completed');

	const content = (
		<div class="bg-dark-800 border border-dark-700 rounded-lg p-3 min-w-0 flex-1">
			<div class="flex items-center gap-2 mb-2">
				<StatusIndicator status={session.status} />
				<span class={`text-xs font-medium px-2 py-0.5 rounded ${getRoleBadgeStyle(session.role)}`}>
					{session.role}
				</span>
			</div>
			<div class="font-mono text-xs text-gray-400 truncate" title={session.sessionId}>
				{truncateSessionId(session.sessionId)}
			</div>
		</div>
	);

	if (canLink) {
		return (
			<a
				href={`/sessions/${session.sessionId}`}
				class="block hover:opacity-80 transition-opacity cursor-pointer"
				data-session-id={session.sessionId}
			>
				{content}
			</a>
		);
	}

	return <div data-session-id={session.sessionId}>{content}</div>;
}

/**
 * Flow connector component for visual representation
 */
function FlowConnector({ type }: { type: 'parallel' | 'serial' | 'merge' }) {
	if (type === 'parallel') {
		return (
			<div class="flex items-center justify-center px-2 text-gray-500 text-sm font-bold">||</div>
		);
	}

	if (type === 'serial') {
		return (
			<div class="flex items-center justify-center px-2 text-gray-500">
				<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
					<path
						fill-rule="evenodd"
						d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
						clip-rule="evenodd"
					/>
				</svg>
			</div>
		);
	}

	// merge (for parallel_then_merge)
	return (
		<div class="flex items-center justify-center px-2 text-gray-500">
			<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
				<path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
			</svg>
		</div>
	);
}

/**
 * Summary stats component
 */
function SummaryStats({ sessions }: { sessions: TaskSession[] }) {
	const active = sessions.filter((s) => s.status === 'active').length;
	const completed = sessions.filter((s) => s.status === 'completed').length;
	const failed = sessions.filter((s) => s.status === 'failed').length;

	return (
		<div class="flex items-center gap-4 text-xs">
			{active > 0 && (
				<span class="flex items-center gap-1.5">
					<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
					<span class="text-gray-400">Active: {active}</span>
				</span>
			)}
			{completed > 0 && (
				<span class="flex items-center gap-1.5">
					<svg class="w-3 h-3 text-green-500" fill="currentColor" viewBox="0 0 20 20">
						<path
							fill-rule="evenodd"
							d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
							clip-rule="evenodd"
						/>
					</svg>
					<span class="text-gray-400">Completed: {completed}</span>
				</span>
			)}
			{failed > 0 && (
				<span class="flex items-center gap-1.5">
					<svg class="w-3 h-3 text-red-500" fill="currentColor" viewBox="0 0 20 20">
						<path
							fill-rule="evenodd"
							d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
							clip-rule="evenodd"
						/>
					</svg>
					<span class="text-gray-400">Failed: {failed}</span>
				</span>
			)}
			{active === 0 && completed === 0 && failed === 0 && (
				<span class="text-gray-500">All sessions pending</span>
			)}
		</div>
	);
}

/**
 * Renders sessions based on execution mode with visual flow
 */
function SessionFlow({
	sessions,
	executionMode,
	showLinks,
}: {
	sessions: TaskSession[];
	executionMode: TaskExecutionMode;
	showLinks: boolean;
}) {
	if (sessions.length === 0) {
		return <div class="text-center text-gray-500 text-sm py-4">No sessions assigned</div>;
	}

	// For single mode, just show the single session
	if (executionMode === 'single' || sessions.length === 1) {
		return (
			<div class="flex">
				<SessionCard session={sessions[0]} showLink={showLinks} />
			</div>
		);
	}

	// For parallel_then_merge, separate reviewers from workers
	if (executionMode === 'parallel_then_merge') {
		const workers = sessions.filter((s) => s.role !== 'reviewer');
		const reviewers = sessions.filter((s) => s.role === 'reviewer');

		return (
			<div class="flex flex-col gap-4">
				{/* Worker sessions in parallel */}
				<div class="flex items-center gap-2 flex-wrap">
					{workers.map((session, index) => (
						<>
							{index > 0 && <FlowConnector type="parallel" />}
							<SessionCard key={session.sessionId} session={session} showLink={showLinks} />
						</>
					))}
				</div>

				{/* Merge connector */}
				{reviewers.length > 0 && (
					<>
						<div class="flex items-center justify-center">
							<svg class="w-5 h-5 text-purple-400" fill="currentColor" viewBox="0 0 20 20">
								<path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
							</svg>
						</div>
						{/* Reviewer sessions */}
						<div class="flex items-center gap-2">
							{reviewers.map((session) => (
								<SessionCard key={session.sessionId} session={session} showLink={showLinks} />
							))}
						</div>
					</>
				)}
			</div>
		);
	}

	// For parallel mode, show all sessions with || separator
	if (executionMode === 'parallel') {
		return (
			<div class="flex items-center gap-2 flex-wrap">
				{sessions.map((session, index) => (
					<>
						{index > 0 && <FlowConnector type="parallel" />}
						<SessionCard key={session.sessionId} session={session} showLink={showLinks} />
					</>
				))}
			</div>
		);
	}

	// For serial mode, show all sessions with arrow separator
	return (
		<div class="flex items-center gap-2 flex-wrap">
			{sessions.map((session, index) => (
				<>
					{index > 0 && <FlowConnector type="serial" />}
					<SessionCard key={session.sessionId} session={session} showLink={showLinks} />
				</>
			))}
		</div>
	);
}

/**
 * Main TaskSessionView component
 */
export function TaskSessionView({ taskId, sessions, executionMode }: TaskSessionViewProps) {
	const modeInfo = getExecutionModeInfo(executionMode);

	return (
		<div
			class="bg-dark-850 border border-dark-700 rounded-lg overflow-hidden"
			data-task-id={taskId}
		>
			{/* Header with execution mode */}
			<div class="px-4 py-3 border-b border-dark-700 flex items-center justify-between">
				<div class="flex items-center gap-3">
					<span class="text-sm font-bold text-gray-300 bg-dark-700 px-2 py-1 rounded">
						{modeInfo.icon}
					</span>
					<div>
						<h3 class="font-semibold text-gray-100">{modeInfo.label}</h3>
						<p class="text-xs text-gray-500">{modeInfo.description}</p>
					</div>
				</div>
				<span class="text-xs text-gray-500">
					{sessions.length} session{sessions.length !== 1 ? 's' : ''}
				</span>
			</div>

			{/* Session flow visualization */}
			<div class="p-4">
				<SessionFlow sessions={sessions} executionMode={executionMode} showLinks={true} />
			</div>

			{/* Summary stats footer */}
			<div class="px-4 py-2 border-t border-dark-700 bg-dark-900/50">
				<SummaryStats sessions={sessions} />
			</div>
		</div>
	);
}
