/**
 * Unit tests for PendingCompletionActionBanner.
 *
 * Covers the Done criteria from the task:
 *   - renders name + description (type line) + required level vs space level
 *   - Approve opens a modal; confirming calls spaceStore.updateTask with status='done'
 *   - Reject opens a modal; confirming cancels the task
 *   - Script details collapsed by default (<details>) inside the approve modal
 *   - Hidden when pendingCheckpointType !== 'completion_action'
 *
 * Plus regressions:
 *   - Hidden when the resolved action is missing (workflow edited)
 *   - Reject clears pendingActionIndex / pendingCheckpointType so the
 *     awaiting-approval summary stays in sync
 */

// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type {
	ScriptCompletionAction,
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
} from '@neokai/shared';

// Mock space-store
const workflowsSignal = signal<SpaceWorkflow[]>([]);
const workflowRunsSignal = signal<SpaceWorkflowRun[]>([]);
const updateTaskMock: Mock = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	spaceStore: {
		get workflows() {
			return workflowsSignal;
		},
		get workflowRuns() {
			return workflowRunsSignal;
		},
		updateTask: (...args: unknown[]) => updateTaskMock(...args),
	},
}));

import { PendingCompletionActionBanner } from '../PendingCompletionActionBanner';

function makeScriptAction(overrides: Partial<ScriptCompletionAction> = {}): ScriptCompletionAction {
	return {
		id: 'a1',
		name: 'merge-pr',
		type: 'script',
		requiredLevel: 3,
		script: 'gh pr merge --squash $PR_NUMBER',
		...overrides,
	};
}

function makeWorkflow(action: ScriptCompletionAction): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'wf',
		description: '',
		nodes: [
			{
				id: 'end-node',
				name: 'end',
				agents: [{ agentId: 'agent-a', name: 'a' }],
				completionActions: [action],
			},
		],
		channels: [],
		gates: [],
		startNodeId: 'end-node',
		endNodeId: 'end-node',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} as unknown as SpaceWorkflow;
}

function makeRun(): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'wf-1',
		title: 'run',
		status: 'running',
		startedAt: Date.now(),
		completedAt: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	} as unknown as SpaceWorkflowRun;
}

let taskCounter = 0;
function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	return {
		id: 't1',
		spaceId: 'space-1',
		taskNumber: ++taskCounter,
		title: 'Task',
		description: '',
		status: 'review',
		priority: 'normal',
		labels: [],
		dependsOn: [],
		result: null,
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		blockReason: null,
		approvalSource: null,
		approvalReason: null,
		approvedAt: null,
		pendingActionIndex: 0,
		pendingCheckpointType: 'completion_action',
		reportedStatus: null,
		reportedSummary: null,
		workflowRunId: 'run-1',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as SpaceTask;
}

describe('PendingCompletionActionBanner', () => {
	beforeEach(() => {
		cleanup();
		updateTaskMock.mockReset();
		updateTaskMock.mockResolvedValue({});
		workflowsSignal.value = [makeWorkflow(makeScriptAction())];
		workflowRunsSignal.value = [makeRun()];
	});

	afterEach(() => {
		cleanup();
	});

	it('renders with action name in the compact banner', () => {
		const task = makeTask();
		const { getByTestId } = render(
			<PendingCompletionActionBanner task={task} spaceId="space-1" spaceAutonomyLevel={1} />
		);
		const banner = getByTestId('pending-completion-action-banner');
		expect(banner.textContent).toContain('merge-pr');
	});

	it('approve modal shows action type, required level, and current space level', async () => {
		const task = makeTask();
		const { getByTestId } = render(
			<PendingCompletionActionBanner task={task} spaceId="space-1" spaceAutonomyLevel={1} />
		);
		// Open the approve modal
		fireEvent.click(getByTestId('pending-completion-action-approve-btn'));
		// Modal is now open — type/level info is visible
		const typeLine = await waitFor(
			() => getByTestId('pending-completion-action-type').textContent ?? ''
		);
		expect(typeLine).toContain('Bash script');
		expect(typeLine).toContain('Level 3');
		const current = getByTestId('pending-completion-action-current-level').textContent ?? '';
		expect(current).toContain('Level 1');
	});

	it('is hidden when pendingCheckpointType is not completion_action', () => {
		const task = makeTask({ pendingCheckpointType: 'gate' });
		const { queryByTestId } = render(
			<PendingCompletionActionBanner task={task} spaceId="space-1" />
		);
		expect(queryByTestId('pending-completion-action-banner')).toBeNull();
	});

	it('is hidden when pendingActionIndex is null', () => {
		const task = makeTask({ pendingActionIndex: null });
		const { queryByTestId } = render(
			<PendingCompletionActionBanner task={task} spaceId="space-1" />
		);
		expect(queryByTestId('pending-completion-action-banner')).toBeNull();
	});

	it('is hidden when the workflow run is not in the store (stale render)', () => {
		workflowRunsSignal.value = [];
		const task = makeTask();
		const { queryByTestId } = render(
			<PendingCompletionActionBanner task={task} spaceId="space-1" />
		);
		expect(queryByTestId('pending-completion-action-banner')).toBeNull();
	});

	it('is hidden when pendingActionIndex is out of range (workflow edited)', () => {
		const task = makeTask({ pendingActionIndex: 5 });
		const { queryByTestId } = render(
			<PendingCompletionActionBanner task={task} spaceId="space-1" />
		);
		expect(queryByTestId('pending-completion-action-banner')).toBeNull();
	});

	it('script details are collapsed by default inside the approve modal', async () => {
		const task = makeTask();
		const { getByTestId } = render(<PendingCompletionActionBanner task={task} spaceId="space-1" />);
		// Open approve modal to access action details
		fireEvent.click(getByTestId('pending-completion-action-approve-btn'));
		const details = await waitFor(
			() => getByTestId('pending-completion-action-details') as HTMLDetailsElement
		);
		expect(details.tagName.toLowerCase()).toBe('details');
		expect(details.open).toBe(false);
		// But the script source is in the DOM (ready to reveal).
		const source = getByTestId('pending-completion-action-script').textContent ?? '';
		expect(source).toContain('gh pr merge');
	});

	it('Approve opens modal; confirming calls spaceStore.updateTask with status="done"', async () => {
		const task = makeTask();
		const { getByTestId } = render(<PendingCompletionActionBanner task={task} spaceId="space-1" />);
		// Click the inline Approve button → opens modal
		fireEvent.click(getByTestId('pending-completion-action-approve-btn'));
		// Click the confirm button inside the modal
		const confirmBtn = await waitFor(() =>
			getByTestId('pending-completion-action-approve-confirm')
		);
		fireEvent.click(confirmBtn);
		await waitFor(() => expect(updateTaskMock).toHaveBeenCalledTimes(1));
		expect(updateTaskMock).toHaveBeenCalledWith(task.id, { status: 'done' });
	});

	it('Reject opens modal; confirm cancels task and clears pending fields', async () => {
		const task = makeTask();
		const { getByTestId, queryByTestId } = render(
			<PendingCompletionActionBanner task={task} spaceId="space-1" />
		);
		// Reject modal is not open by default
		expect(queryByTestId('pending-completion-action-reject-confirm')).toBeNull();

		fireEvent.click(getByTestId('pending-completion-action-reject-btn'));
		const confirmBtn = await waitFor(() => getByTestId('pending-completion-action-reject-confirm'));

		// Add an optional reason
		const textarea = getByTestId('pending-completion-action-reject-reason') as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: 'script is unsafe' } });

		fireEvent.click(confirmBtn);
		await waitFor(() => expect(updateTaskMock).toHaveBeenCalledTimes(1));
		expect(updateTaskMock).toHaveBeenCalledWith(task.id, {
			status: 'cancelled',
			pendingActionIndex: null,
			pendingCheckpointType: null,
			result: 'script is unsafe',
		});
	});

	it('Reject without reason still clears pending fields', async () => {
		const task = makeTask();
		const { getByTestId } = render(<PendingCompletionActionBanner task={task} spaceId="space-1" />);
		fireEvent.click(getByTestId('pending-completion-action-reject-btn'));
		const confirmBtn = await waitFor(() => getByTestId('pending-completion-action-reject-confirm'));
		fireEvent.click(confirmBtn);
		await waitFor(() => expect(updateTaskMock).toHaveBeenCalledTimes(1));
		const [, payload] = updateTaskMock.mock.calls[0];
		expect(payload.status).toBe('cancelled');
		expect(payload.pendingActionIndex).toBeNull();
		expect(payload.pendingCheckpointType).toBeNull();
		expect(payload.result).toBeUndefined();
	});

	it('surfaces approval errors inside the modal without throwing', async () => {
		updateTaskMock.mockRejectedValueOnce(new Error('network down'));
		const task = makeTask();
		const { getByTestId } = render(<PendingCompletionActionBanner task={task} spaceId="space-1" />);
		// Open approve modal and confirm
		fireEvent.click(getByTestId('pending-completion-action-approve-btn'));
		const confirmBtn = await waitFor(() =>
			getByTestId('pending-completion-action-approve-confirm')
		);
		fireEvent.click(confirmBtn);
		const err = await waitFor(() => getByTestId('pending-completion-action-error'));
		expect(err.textContent).toContain('network down');
	});

	it('renders instruction details for instruction actions inside the approve modal', async () => {
		workflowsSignal.value = [
			makeWorkflow({
				id: 'a2',
				name: 'notify-team',
				type: 'instruction',
				requiredLevel: 2,
				agentName: 'NotifyAgent',
				instruction: 'Post a summary to #eng',
			}),
		];
		const task = makeTask();
		const { getByTestId } = render(<PendingCompletionActionBanner task={task} spaceId="space-1" />);
		// Open approve modal to see action details
		fireEvent.click(getByTestId('pending-completion-action-approve-btn'));
		const details = await waitFor(() => getByTestId('pending-completion-action-details'));
		expect(details.getAttribute('data-action-type')).toBe('instruction');
		expect(getByTestId('pending-completion-action-instruction').textContent).toContain(
			'Post a summary'
		);
	});

	it('renders MCP details for mcp_call actions inside the approve modal', async () => {
		workflowsSignal.value = [
			makeWorkflow({
				id: 'a3',
				name: 'create-ticket',
				type: 'mcp_call',
				requiredLevel: 4,
				server: 'linear',
				tool: 'createIssue',
				args: { title: '{{artifact.title}}', team: 'eng' },
			}),
		];
		const task = makeTask();
		const { getByTestId } = render(<PendingCompletionActionBanner task={task} spaceId="space-1" />);
		// Open approve modal to see action details
		fireEvent.click(getByTestId('pending-completion-action-approve-btn'));
		const details = await waitFor(() => getByTestId('pending-completion-action-details'));
		expect(details.getAttribute('data-action-type')).toBe('mcp_call');
		const args = getByTestId('pending-completion-action-mcp-args').textContent ?? '';
		expect(args).toContain('title');
		expect(args).toContain('{{artifact.title}}');
	});
});
