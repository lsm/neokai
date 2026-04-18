/**
 * Unit tests for TaskBlockedBanner
 *
 * Tests:
 * - Renders fallback amber banner when blockReason is null
 * - Returns null for human_input_requested (question renders in the thread instead)
 * - Renders gate_rejected banner with "Review & Approve" button
 * - Renders execution_failed banner with Resume button
 * - Renders agent_crashed banner with Resume button
 * - Renders dependency_failed banner (informational, no action)
 * - Renders workflow_invalid banner (informational, no action)
 * - Resume button calls onStatusTransition with 'in_progress'
 * - Gate "Review & Approve" opens GateArtifactsView
 * - Shows result text when present
 * - Banner always shows even without result text
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import type { SpaceTask } from '@neokai/shared';

// ---- Mock space-store ----
const mockListGateData: Mock = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	spaceStore: {
		listGateData: (...args: unknown[]) => mockListGateData(...args),
	},
}));

// Mock GateArtifactsView to avoid pulling in connection-manager and its deps
vi.mock('../GateArtifactsView', () => ({
	GateArtifactsView: (props: Record<string, unknown>) => (
		<div data-testid="gate-artifacts-view" data-run-id={props.runId} data-gate-id={props.gateId}>
			GateArtifactsView
			<button data-testid="gate-close" onClick={props.onClose as () => void}>
				Close
			</button>
			<button data-testid="gate-decide" onClick={props.onDecision as () => void}>
				Decide
			</button>
		</div>
	),
}));

import { TaskBlockedBanner } from '../TaskBlockedBanner';

// ============================================================================
// Helpers
// ============================================================================

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'space-1',
		taskNumber: 1,
		title: 'Test Task',
		description: '',
		status: 'blocked',
		priority: 'normal',
		labels: [],
		dependsOn: [],
		result: null,
		blockReason: null,
		approvalSource: null,
		approvalReason: null,
		approvedAt: null,
		createdAt: 0,
		updatedAt: 0,
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		...overrides,
	} as SpaceTask;
}

// ============================================================================
// Tests
// ============================================================================

describe('TaskBlockedBanner', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		mockListGateData.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
	});

	it('renders fallback amber banner when blockReason is null', () => {
		const { getByTestId } = render(<TaskBlockedBanner task={makeTask()} spaceId="space-1" />);
		const banner = getByTestId('task-blocked-banner');
		expect(banner.className).toContain('border-amber-500');
		expect(banner.textContent).toContain('Blocked');
	});

	it('renders nothing for human_input_requested (question surfaces in thread)', () => {
		const task = makeTask({
			blockReason: 'human_input_requested',
			result: 'What color scheme do you prefer?',
		});
		const { queryByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
		expect(queryByTestId('task-blocked-banner')).toBeNull();
	});

	it('renders gate_rejected banner with Review & Approve button', async () => {
		mockListGateData.mockResolvedValue([
			{ runId: 'run-1', gateId: 'gate-1', data: { approved: false, waiting: true }, updatedAt: 0 },
		]);
		const task = makeTask({
			blockReason: 'gate_rejected',
			workflowRunId: 'run-1',
		});
		const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);

		await waitFor(() => {
			expect(getByTestId('gate-review-btn')).toBeTruthy();
		});
		const banner = getByTestId('task-blocked-banner');
		expect(banner.className).toContain('border-purple-500');
		expect(banner.textContent).toContain('Gate Pending Approval');
	});

	it('renders execution_failed banner with Resume button', () => {
		const task = makeTask({
			blockReason: 'execution_failed',
			result: 'Process exited with code 1',
		});
		const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
		const banner = getByTestId('task-blocked-banner');
		expect(banner.className).toContain('border-red-500');
		expect(banner.textContent).toContain('Execution Failed');
		expect(getByTestId('task-resume-btn')).toBeTruthy();
	});

	it('renders agent_crashed banner with Resume button', () => {
		const task = makeTask({ blockReason: 'agent_crashed' });
		const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
		const banner = getByTestId('task-blocked-banner');
		expect(banner.textContent).toContain('Agent Crashed');
		expect(getByTestId('task-resume-btn')).toBeTruthy();
	});

	it('renders dependency_failed banner without action buttons', () => {
		const task = makeTask({ blockReason: 'dependency_failed' });
		const { getByTestId, queryByTestId } = render(
			<TaskBlockedBanner task={task} spaceId="space-1" />
		);
		const banner = getByTestId('task-blocked-banner');
		expect(banner.className).toContain('border-gray-500');
		expect(banner.textContent).toContain('Blocked by Dependency');
		expect(queryByTestId('task-resume-btn')).toBeNull();
		expect(queryByTestId('gate-review-btn')).toBeNull();
	});

	it('renders workflow_invalid banner without action buttons', () => {
		const task = makeTask({ blockReason: 'workflow_invalid' });
		const { getByTestId, queryByTestId } = render(
			<TaskBlockedBanner task={task} spaceId="space-1" />
		);
		expect(getByTestId('task-blocked-banner').textContent).toContain('Invalid Workflow');
		expect(queryByTestId('task-resume-btn')).toBeNull();
	});

	it('Resume button calls onStatusTransition with in_progress', () => {
		const onTransition = vi.fn();
		const task = makeTask({ blockReason: 'execution_failed' });
		const { getByTestId } = render(
			<TaskBlockedBanner task={task} spaceId="space-1" onStatusTransition={onTransition} />
		);
		fireEvent.click(getByTestId('task-resume-btn'));
		expect(onTransition).toHaveBeenCalledWith('in_progress');
	});

	it('gate Review & Approve opens GateArtifactsView', async () => {
		mockListGateData.mockResolvedValue([
			{ runId: 'run-1', gateId: 'gate-1', data: { approved: false }, updatedAt: 0 },
		]);
		const task = makeTask({
			blockReason: 'gate_rejected',
			workflowRunId: 'run-1',
		});
		const { getByTestId, queryByTestId } = render(
			<TaskBlockedBanner task={task} spaceId="space-1" />
		);

		await waitFor(() => {
			expect(getByTestId('gate-review-btn')).toBeTruthy();
		});

		fireEvent.click(getByTestId('gate-review-btn'));

		expect(getByTestId('gate-artifacts-view')).toBeTruthy();
		expect(queryByTestId('task-blocked-banner')).toBeNull();
	});

	it('closing GateArtifactsView returns to banner', async () => {
		mockListGateData.mockResolvedValue([
			{ runId: 'run-1', gateId: 'gate-1', data: { approved: false }, updatedAt: 0 },
		]);
		const task = makeTask({
			blockReason: 'gate_rejected',
			workflowRunId: 'run-1',
		});
		const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);

		await waitFor(() => {
			expect(getByTestId('gate-review-btn')).toBeTruthy();
		});

		fireEvent.click(getByTestId('gate-review-btn'));
		expect(getByTestId('gate-artifacts-view')).toBeTruthy();

		fireEvent.click(getByTestId('gate-close'));
		expect(getByTestId('task-blocked-banner')).toBeTruthy();
	});

	it('shows result text when present', () => {
		const task = makeTask({ result: 'Something went wrong' });
		const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
		expect(getByTestId('task-blocked-message').textContent).toBe('Something went wrong');
	});

	it('banner renders even without result text', () => {
		const task = makeTask({ blockReason: 'execution_failed', result: null });
		const { getByTestId, queryByTestId } = render(
			<TaskBlockedBanner task={task} spaceId="space-1" />
		);
		expect(getByTestId('task-blocked-banner')).toBeTruthy();
		expect(queryByTestId('task-blocked-message')).toBeNull();
	});

	it('shows Resume fallback when gate_rejected but no pending gate found', async () => {
		mockListGateData.mockResolvedValue([]);
		const task = makeTask({
			blockReason: 'gate_rejected',
			workflowRunId: 'run-1',
		});
		const { getByTestId, queryByTestId } = render(
			<TaskBlockedBanner task={task} spaceId="space-1" />
		);

		await waitFor(() => {
			expect(queryByTestId('gate-review-btn')).toBeNull();
		});
		expect(getByTestId('gate-resume-btn')).toBeTruthy();
	});

	it('shows Resume immediately when gate_rejected with no workflowRunId', () => {
		const task = makeTask({
			blockReason: 'gate_rejected',
			workflowRunId: null,
		});
		const { getByTestId, queryByTestId } = render(
			<TaskBlockedBanner task={task} spaceId="space-1" />
		);
		// No fetch attempted, no loading, so Resume fallback renders immediately
		expect(getByTestId('gate-resume-btn')).toBeTruthy();
		expect(queryByTestId('gate-review-btn')).toBeNull();
		expect(mockListGateData).not.toHaveBeenCalled();
	});

	it('does not flash Resume button while gate data is loading', () => {
		// Never resolve — simulates in-flight fetch
		mockListGateData.mockReturnValue(new Promise(() => {}));
		const task = makeTask({
			blockReason: 'gate_rejected',
			workflowRunId: 'run-1',
		});
		const { queryByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);
		// Neither button should show while loading
		expect(queryByTestId('gate-resume-btn')).toBeNull();
		expect(queryByTestId('gate-review-btn')).toBeNull();
	});

	it('GateArtifactsView onDecision callback closes the review', async () => {
		mockListGateData.mockResolvedValue([
			{ runId: 'run-1', gateId: 'gate-1', data: { approved: false }, updatedAt: 0 },
		]);
		const task = makeTask({
			blockReason: 'gate_rejected',
			workflowRunId: 'run-1',
		});
		const { getByTestId } = render(<TaskBlockedBanner task={task} spaceId="space-1" />);

		await waitFor(() => {
			expect(getByTestId('gate-review-btn')).toBeTruthy();
		});

		fireEvent.click(getByTestId('gate-review-btn'));
		expect(getByTestId('gate-artifacts-view')).toBeTruthy();

		// onDecision should also close the review view
		fireEvent.click(getByTestId('gate-decide'));
		expect(getByTestId('task-blocked-banner')).toBeTruthy();
	});
});
