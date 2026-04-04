// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

// ---- Mock connectionManager ----
const mockRequest = vi.fn();
const mockHub = { request: mockRequest };

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: vi.fn(() => mockHub),
	},
}));

// ---- Mock FileDiffView ----
vi.mock('../FileDiffView', () => ({
	FileDiffView: ({ filePath, onBack }: { filePath: string; onBack: () => void }) => (
		<div data-testid="file-diff-view" data-file={filePath}>
			<button data-testid="diff-back" onClick={onBack}>
				Back
			</button>
		</div>
	),
}));

// ---- Mock cn ----
vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { TaskArtifactsPanel } from '../TaskArtifactsPanel';

const ARTIFACTS_RESULT = {
	files: [
		{ path: 'src/foo.ts', additions: 10, deletions: 2 },
		{ path: 'src/bar.ts', additions: 5, deletions: 0 },
	],
	totalAdditions: 15,
	totalDeletions: 2,
};

describe('TaskArtifactsPanel', () => {
	beforeEach(() => {
		cleanup();
		mockRequest.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows loading spinner initially', () => {
		mockRequest.mockReturnValue(new Promise(() => {})); // never resolves
		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
		expect(getByTestId('artifacts-loading')).toBeTruthy();
	});

	it('renders file list after successful fetch', async () => {
		mockRequest.mockResolvedValue(ARTIFACTS_RESULT);
		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
		await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());

		const fileList = getByTestId('artifacts-file-list');
		expect(fileList.textContent).toContain('src/foo.ts');
		expect(fileList.textContent).toContain('src/bar.ts');
	});

	it('shows +/- line counts for each file', async () => {
		mockRequest.mockResolvedValue(ARTIFACTS_RESULT);
		const { container, getByTestId } = render(
			<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />
		);
		await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());

		const fooRow = container.querySelector('[data-file-path="src/foo.ts"]');
		expect(fooRow).toBeTruthy();
		expect(fooRow?.textContent).toContain('+10');
		expect(fooRow?.textContent).toContain('-2');

		const barRow = container.querySelector('[data-file-path="src/bar.ts"]');
		expect(barRow).toBeTruthy();
		expect(barRow?.textContent).toContain('+5');
		expect(barRow?.textContent).toContain('-0');
	});

	it('shows summary totals', async () => {
		mockRequest.mockResolvedValue(ARTIFACTS_RESULT);
		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
		await waitFor(() => expect(getByTestId('artifacts-summary')).toBeTruthy());

		const summary = getByTestId('artifacts-summary');
		expect(summary.textContent).toContain('2 files changed');
		expect(summary.textContent).toContain('+15');
		expect(summary.textContent).toContain('-2');
	});

	it('shows "1 file" singular when only one file changed', async () => {
		mockRequest.mockResolvedValue({
			files: [{ path: 'src/only.ts', additions: 3, deletions: 1 }],
			totalAdditions: 3,
			totalDeletions: 1,
		});
		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
		await waitFor(() => expect(getByTestId('artifacts-summary')).toBeTruthy());
		expect(getByTestId('artifacts-summary').textContent).toContain('1 file changed');
	});

	it('shows no-files message when files array is empty', async () => {
		mockRequest.mockResolvedValue({ files: [], totalAdditions: 0, totalDeletions: 0 });
		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
		await waitFor(() => expect(getByTestId('artifacts-no-files')).toBeTruthy());
	});

	it('clicking a file opens FileDiffView for that file', async () => {
		mockRequest.mockResolvedValue(ARTIFACTS_RESULT);
		const { container, getByTestId, queryByTestId } = render(
			<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />
		);
		await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());

		expect(queryByTestId('file-diff-view')).toBeNull();
		const fooRow = container.querySelector('[data-file-path="src/foo.ts"]') as HTMLElement;
		expect(fooRow).toBeTruthy();
		fireEvent.click(fooRow);
		const diffView = getByTestId('file-diff-view');
		expect(diffView).toBeTruthy();
		expect(diffView.getAttribute('data-file')).toBe('src/foo.ts');
	});

	it('back button in FileDiffView returns to file list', async () => {
		mockRequest.mockResolvedValue(ARTIFACTS_RESULT);
		const { container, getByTestId, queryByTestId } = render(
			<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />
		);
		await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());

		const fooRow = container.querySelector('[data-file-path="src/foo.ts"]') as HTMLElement;
		fireEvent.click(fooRow);
		expect(getByTestId('file-diff-view')).toBeTruthy();

		fireEvent.click(getByTestId('diff-back'));
		expect(queryByTestId('file-diff-view')).toBeNull();
		expect(getByTestId('artifacts-file-list')).toBeTruthy();
	});

	it('calls onClose when close button is clicked', async () => {
		mockRequest.mockResolvedValue(ARTIFACTS_RESULT);
		const onClose = vi.fn();
		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={onClose} />);
		await waitFor(() => expect(getByTestId('artifacts-panel')).toBeTruthy());

		fireEvent.click(getByTestId('artifacts-panel-close'));
		expect(onClose).toHaveBeenCalled();
	});

	it('shows error when not connected', async () => {
		const { connectionManager } = await import('../../../lib/connection-manager');
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValueOnce(null);

		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
		await waitFor(() => expect(getByTestId('artifacts-error')).toBeTruthy());
		expect(getByTestId('artifacts-error').textContent).toContain('Not connected');
	});

	it('shows fetch error when request fails', async () => {
		mockRequest.mockRejectedValue(new Error('Server error'));
		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
		await waitFor(() => expect(getByTestId('artifacts-error')).toBeTruthy());
		expect(getByTestId('artifacts-error').textContent).toContain('Server error');
	});

	it('fetches with the correct runId', async () => {
		mockRequest.mockResolvedValue(ARTIFACTS_RESULT);
		render(<TaskArtifactsPanel runId="run-abc-123" onClose={vi.fn()} />);
		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.getGateArtifacts', {
				runId: 'run-abc-123',
			})
		);
	});

	it('has data-testid="artifacts-panel" on root element', async () => {
		mockRequest.mockResolvedValue(ARTIFACTS_RESULT);
		const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
		expect(getByTestId('artifacts-panel')).toBeTruthy();
	});
});

describe('SpaceTaskPane — artifacts toggle', () => {
	// Import SpaceTaskPane with signal mocks to test the toggle button
	let mockTasks: ReturnType<typeof import('@preact/signals').signal>;

	beforeEach(async () => {
		cleanup();
		vi.resetModules();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders artifacts-toggle button when task has workflowRunId', async () => {
		const { signal } = await import('@preact/signals');
		mockTasks = signal([
			{
				id: 'task-1',
				spaceId: 'space-1',
				title: 'Test Task',
				description: '',
				status: 'in_progress',
				priority: 'normal',
				dependsOn: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				workflowRunId: 'run-xyz',
				taskAgentSessionId: 'session-abc',
			},
		]);

		vi.doMock('../../../lib/space-store', () => ({
			get spaceStore() {
				return {
					tasks: mockTasks,
					taskActivity: signal(new Map()),
					subscribeTaskActivity: vi.fn().mockResolvedValue(undefined),
					unsubscribeTaskActivity: vi.fn(),
					agents: signal([]),
					workflows: signal([]),
					workflowRuns: signal([]),
					updateTask: vi.fn().mockResolvedValue(undefined),
					ensureTaskAgentSession: vi.fn().mockResolvedValue({
						id: 'task-1',
						taskAgentSessionId: 'session-abc',
					}),
					sendTaskMessage: vi.fn().mockResolvedValue(undefined),
				};
			},
		}));

		vi.doMock('../SpaceTaskUnifiedThread', () => ({
			SpaceTaskUnifiedThread: () => <div data-testid="space-task-unified-thread" />,
		}));
		vi.doMock('../TaskArtifactsPanel', () => ({
			TaskArtifactsPanel: ({ runId }: { runId: string }) => (
				<div data-testid="artifacts-panel" data-run-id={runId} />
			),
		}));
		vi.doMock('../../../lib/router', () => ({
			navigateToSpaceSession: vi.fn(),
			navigateToSpaceAgent: vi.fn(),
		}));
		vi.doMock('../../../lib/utils', () => ({
			cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
		}));

		const { SpaceTaskPane } = await import('../SpaceTaskPane');
		const { getByTestId } = render(<SpaceTaskPane taskId="task-1" spaceId="space-1" />);
		expect(getByTestId('artifacts-toggle')).toBeTruthy();
	});

	it('does not render artifacts-toggle when task has no workflowRunId', async () => {
		const { signal } = await import('@preact/signals');
		mockTasks = signal([
			{
				id: 'task-2',
				spaceId: 'space-1',
				title: 'No Run Task',
				description: '',
				status: 'open',
				priority: 'normal',
				dependsOn: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				workflowRunId: null,
				taskAgentSessionId: null,
			},
		]);

		vi.doMock('../../../lib/space-store', () => ({
			get spaceStore() {
				return {
					tasks: mockTasks,
					taskActivity: signal(new Map()),
					subscribeTaskActivity: vi.fn().mockResolvedValue(undefined),
					unsubscribeTaskActivity: vi.fn(),
					agents: signal([]),
					workflows: signal([]),
					workflowRuns: signal([]),
					updateTask: vi.fn().mockResolvedValue(undefined),
					ensureTaskAgentSession: vi.fn().mockResolvedValue({ id: 'task-2' }),
					sendTaskMessage: vi.fn().mockResolvedValue(undefined),
				};
			},
		}));

		vi.doMock('../SpaceTaskUnifiedThread', () => ({
			SpaceTaskUnifiedThread: () => <div data-testid="space-task-unified-thread" />,
		}));
		vi.doMock('../TaskArtifactsPanel', () => ({
			TaskArtifactsPanel: () => <div data-testid="artifacts-panel" />,
		}));
		vi.doMock('../../../lib/router', () => ({
			navigateToSpaceSession: vi.fn(),
			navigateToSpaceAgent: vi.fn(),
		}));
		vi.doMock('../../../lib/utils', () => ({
			cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
		}));

		const { SpaceTaskPane } = await import('../SpaceTaskPane');
		const { queryByTestId } = render(<SpaceTaskPane taskId="task-2" spaceId="space-1" />);
		expect(queryByTestId('artifacts-toggle')).toBeNull();
	});

	it('shows artifacts panel when toggle is clicked', async () => {
		const { signal } = await import('@preact/signals');
		mockTasks = signal([
			{
				id: 'task-3',
				spaceId: 'space-1',
				title: 'Run Task',
				description: '',
				status: 'in_progress',
				priority: 'normal',
				dependsOn: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
				workflowRunId: 'run-toggle',
				taskAgentSessionId: 'session-toggle',
			},
		]);

		vi.doMock('../../../lib/space-store', () => ({
			get spaceStore() {
				return {
					tasks: mockTasks,
					taskActivity: signal(new Map()),
					subscribeTaskActivity: vi.fn().mockResolvedValue(undefined),
					unsubscribeTaskActivity: vi.fn(),
					agents: signal([]),
					workflows: signal([]),
					workflowRuns: signal([]),
					updateTask: vi.fn().mockResolvedValue(undefined),
					ensureTaskAgentSession: vi.fn().mockResolvedValue({
						id: 'task-3',
						taskAgentSessionId: 'session-toggle',
					}),
					sendTaskMessage: vi.fn().mockResolvedValue(undefined),
				};
			},
		}));

		vi.doMock('../SpaceTaskUnifiedThread', () => ({
			SpaceTaskUnifiedThread: () => <div data-testid="space-task-unified-thread" />,
		}));
		vi.doMock('../TaskArtifactsPanel', () => ({
			TaskArtifactsPanel: ({ runId, onClose }: { runId: string; onClose: () => void }) => (
				<div data-testid="artifacts-panel" data-run-id={runId}>
					<button data-testid="artifacts-panel-close" onClick={onClose}>
						Close
					</button>
				</div>
			),
		}));
		vi.doMock('../../../lib/router', () => ({
			navigateToSpaceSession: vi.fn(),
			navigateToSpaceAgent: vi.fn(),
		}));
		vi.doMock('../../../lib/utils', () => ({
			cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
		}));

		const { SpaceTaskPane } = await import('../SpaceTaskPane');
		const { getByTestId, queryByTestId } = render(
			<SpaceTaskPane taskId="task-3" spaceId="space-1" />
		);

		// Artifacts panel not shown initially
		expect(queryByTestId('artifacts-panel')).toBeNull();

		// Click toggle → panel appears
		fireEvent.click(getByTestId('artifacts-toggle'));
		expect(getByTestId('artifacts-panel')).toBeTruthy();
		expect(getByTestId('artifacts-panel').getAttribute('data-run-id')).toBe('run-toggle');

		// Click close → panel disappears
		fireEvent.click(getByTestId('artifacts-panel-close'));
		expect(queryByTestId('artifacts-panel')).toBeNull();
	});
});
