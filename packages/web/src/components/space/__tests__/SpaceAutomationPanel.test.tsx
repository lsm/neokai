// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type { AutomationRun, AutomationTask, SpaceWorkflow } from '@neokai/shared';

const mocks = vi.hoisted(() => ({
	subscribeOwner: vi.fn(),
	unsubscribe: vi.fn(),
	create: vi.fn(),
	triggerNow: vi.fn(),
	listRuns: vi.fn(),
	pause: vi.fn(),
	resume: vi.fn(),
	archive: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	automationsSignal: { value: [] as AutomationTask[] },
	loadingSignal: { value: false },
}));

vi.mock('../../../lib/automation-store', () => ({
	automationStore: {
		automations: mocks.automationsSignal,
		isLoading: mocks.loadingSignal,
		subscribeOwner: mocks.subscribeOwner,
		unsubscribe: mocks.unsubscribe,
		create: mocks.create,
		triggerNow: mocks.triggerNow,
		listRuns: mocks.listRuns,
		pause: mocks.pause,
		resume: mocks.resume,
		archive: mocks.archive,
	},
}));

vi.mock('../../../lib/toast', () => ({
	toast: {
		success: mocks.toastSuccess,
		error: mocks.toastError,
	},
}));

vi.mock('../../ui/Button', () => ({
	Button: ({ children, onClick, type, loading, disabled, variant }) => (
		<button
			type={type ?? 'button'}
			onClick={onClick}
			disabled={disabled || loading}
			data-variant={variant}
		>
			{loading ? 'Loading...' : children}
		</button>
	),
}));

import { SpaceAutomationPanel } from '../SpaceAutomationPanel';

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'workflow-1',
		spaceId: 'space-1',
		name: 'ORK Runner',
		description: '',
		status: 'active',
		nodes: [],
		channels: [],
		gates: [],
		startNodeId: '',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeAutomation(overrides: Partial<AutomationTask> = {}): AutomationTask {
	return {
		id: 'auto-1',
		ownerType: 'space',
		ownerId: 'space-1',
		title: 'ORK Runner monitor',
		description: '',
		status: 'active',
		triggerType: 'interval',
		triggerConfig: { intervalMs: 3_600_000 },
		targetType: 'space_workflow',
		targetConfig: {
			spaceId: 'space-1',
			titleTemplate: 'ORK Runner automated run',
			descriptionTemplate: 'Run workflow',
			preferredWorkflowId: 'workflow-1',
		},
		conditionConfig: null,
		concurrencyPolicy: 'skip',
		notifyPolicy: 'state_changes',
		maxRetries: 3,
		timeoutMs: null,
		nextRunAt: null,
		lastRunAt: null,
		lastCheckedAt: null,
		lastConditionResult: null,
		conditionFailureCount: 0,
		consecutiveFailureCount: 0,
		lastFailureFingerprint: null,
		pausedReason: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		archivedAt: null,
		...overrides,
	};
}

describe('SpaceAutomationPanel', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		mocks.automationsSignal.value = [];
		mocks.loadingSignal.value = false;
		mocks.subscribeOwner.mockResolvedValue(undefined);
		mocks.create.mockResolvedValue(makeAutomation());
		mocks.triggerNow.mockResolvedValue({ id: 'run-1' });
		mocks.pause.mockResolvedValue(makeAutomation({ status: 'paused' }));
		mocks.resume.mockResolvedValue(makeAutomation());
		mocks.archive.mockResolvedValue(makeAutomation({ status: 'archived' }));
		mocks.listRuns.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
	});

	it('subscribes to the space automation owner', () => {
		render(<SpaceAutomationPanel spaceId="space-1" workflows={[makeWorkflow()]} />);

		expect(mocks.subscribeOwner).toHaveBeenCalledWith({ ownerType: 'space', ownerId: 'space-1' });
	});

	it('creates interval space workflow automations', async () => {
		const { getByText } = render(
			<SpaceAutomationPanel spaceId="space-1" workflows={[makeWorkflow()]} />
		);

		fireEvent.click(getByText('Create'));

		await waitFor(() => {
			expect(mocks.create).toHaveBeenCalledWith(
				expect.objectContaining({
					ownerType: 'space',
					ownerId: 'space-1',
					triggerType: 'interval',
					targetType: 'space_workflow',
					targetConfig: expect.objectContaining({
						spaceId: 'space-1',
						preferredWorkflowId: 'workflow-1',
					}),
				})
			);
		});
		expect(mocks.toastSuccess).toHaveBeenCalledWith('Automation created');
	});

	it('runs controls and displays run history', async () => {
		const run: AutomationRun = {
			id: 'run-1',
			automationTaskId: 'auto-1',
			ownerType: 'space',
			ownerId: 'space-1',
			status: 'succeeded',
			triggerType: 'manual',
			triggerReason: 'manual',
			attempt: 1,
			jobId: null,
			sessionId: null,
			roomTaskId: null,
			spaceTaskId: null,
			missionExecutionId: null,
			resultSummary: 'done',
			error: null,
			metadata: null,
			startedAt: Date.now(),
			completedAt: Date.now(),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		mocks.automationsSignal.value = [makeAutomation()];
		mocks.listRuns.mockResolvedValue([run]);
		const { getByText, findByText } = render(
			<SpaceAutomationPanel spaceId="space-1" workflows={[makeWorkflow()]} />
		);

		fireEvent.click(getByText('Run'));
		await waitFor(() => expect(mocks.triggerNow).toHaveBeenCalledWith('auto-1'));

		fireEvent.click(getByText('History'));
		expect(await findByText('done')).toBeTruthy();
	});
});
