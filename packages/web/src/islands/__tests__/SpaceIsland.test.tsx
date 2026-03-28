// @ts-nocheck
/**
 * Tests for SpaceIsland — visual workflow editor and dashboard integration
 *
 * Visual editor
 * - Opens only the visual editor when creating or editing a workflow
 * - Hides the tab bar while editing
 * - Passes the correct workflow prop to the visual editor
 * - onSave/onCancel close the editor
 *
 * Dashboard integration
 * - Shows the dashboard view on the dashboard tab
 * - Does not render a workflow canvas wrapper on the dashboard
 * - Opens the create-task, start-workflow, and space-agent actions from the overview
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceWorkflow, SpaceAgent, Space, SpaceWorkflowRun } from '@neokai/shared';

// ============================================================================
// Mock signals — must be declared before vi.mock calls
// ============================================================================

let mockLoading = signal(false);
let mockError = signal<string | null>(null);
let mockSpace = signal<Space | null>(null);
let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceAgent[]>([]);
let mockActiveRuns = signal<SpaceWorkflowRun[]>([]);

const mockSelectSpace = vi.fn().mockResolvedValue(undefined);

// ============================================================================
// Child component mocks
// ============================================================================

// WorkflowList renders a button to trigger create/edit workflow
vi.mock('../../components/space/WorkflowList', () => ({
	WorkflowList: (props: { onCreateWorkflow: () => void; onEditWorkflow: (id: string) => void }) => (
		<div data-testid="workflow-list">
			<button data-testid="create-workflow-btn" onClick={props.onCreateWorkflow}>
				Create
			</button>
			<button data-testid="edit-workflow-btn" onClick={() => props.onEditWorkflow('wf-existing')}>
				Edit
			</button>
		</div>
	),
}));

// Track props passed to VisualWorkflowEditor
let capturedVisualEditorProps: Record<string, unknown> = {};
vi.mock('../../components/space/visual-editor/VisualWorkflowEditor', () => ({
	VisualWorkflowEditor: (props: {
		workflow?: SpaceWorkflow;
		onSave: () => void;
		onCancel: () => void;
	}) => {
		capturedVisualEditorProps = props;
		return (
			<div data-testid="visual-workflow-editor">
				<span data-testid="visual-editor-name">{props.workflow?.name ?? 'new'}</span>
				<button data-testid="visual-editor-save" onClick={props.onSave}>
					Save
				</button>
				<button data-testid="visual-editor-cancel" onClick={props.onCancel}>
					Cancel
				</button>
			</div>
		);
	},
}));

vi.mock('../../components/space/SpaceDashboard', () => ({
	SpaceDashboard: (props: {
		onOpenSpaceAgent?: () => void;
		onSelectTask?: (id: string) => void;
	}) => (
		<div data-testid="space-dashboard">
			<button data-testid="quick-open-space-agent" onClick={props.onOpenSpaceAgent}>
				Ask Space Agent
			</button>
		</div>
	),
}));
vi.mock('../../components/space/SpaceTaskPane', () => ({
	SpaceTaskPane: (props: { taskId: string | null; spaceId?: string; onClose?: () => void }) => (
		<div
			data-testid="space-task-pane-inner"
			data-task-id={props.taskId ?? ''}
			data-space-id={props.spaceId ?? ''}
		/>
	),
}));

vi.mock('../../components/space/SpaceAgentList', () => ({
	SpaceAgentList: () => <div data-testid="space-agent-list" />,
}));
vi.mock('../../components/space/SpaceSettings', () => ({
	SpaceSettings: () => <div data-testid="space-settings" />,
}));
vi.mock('../ChatContainer', () => ({
	default: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="chat-container" data-session-id={sessionId} />
	),
}));

vi.mock('../../lib/space-store', () => ({
	get spaceStore() {
		return {
			loading: mockLoading,
			error: mockError,
			space: mockSpace,
			workflows: mockWorkflows,
			agents: mockAgents,
			activeRuns: mockActiveRuns,
			selectSpace: mockSelectSpace,
		};
	},
}));

vi.mock('../../lib/signals', () => ({
	currentSessionIdSignal: signal(null),
	slashCommandsSignal: signal([]),
}));

vi.mock('../../lib/router', () => ({
	navigateToSpace: vi.fn(),
	navigateToSpaceAgent: vi.fn(),
	navigateToSpaceTask: vi.fn(),
}));

vi.mock('../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import SpaceIsland from '../SpaceIsland';

// ============================================================================
// Fixtures
// ============================================================================

function makeSpace(overrides: Partial<Space> = {}): Space {
	return {
		id: 'space-1',
		name: 'Test Space',
		description: '',
		status: 'active',
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-existing',
		spaceId: 'space-1',
		name: 'Existing Workflow',
		description: '',
		nodes: [],
		transitions: [],
		startNodeId: '',
		rules: [],
		tags: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeWorkflowRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'wf-existing',
		title: 'Test Run',
		status: 'in_progress',
		iterationCount: 0,
		maxIterations: 10,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

// ============================================================================
// Helpers
// ============================================================================

/** Render SpaceIsland in the Workflows tab with a space loaded. */
function renderOnWorkflowsTab() {
	const result = render(<SpaceIsland spaceId="space-1" />);
	const workflowsTab = result.getByText('Workflows');
	fireEvent.click(workflowsTab);
	return result;
}

/** Open the create-new workflow editor. */
function openCreateEditor(result: { getByTestId: (id: string) => HTMLElement }) {
	fireEvent.click(result.getByTestId('create-workflow-btn'));
}

/** Open the edit workflow editor (uses wf-existing). */
function openEditEditor(result: { getByTestId: (id: string) => HTMLElement }) {
	fireEvent.click(result.getByTestId('edit-workflow-btn'));
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	mockLoading = signal(false);
	mockError = signal(null);
	mockSpace = signal(makeSpace());
	mockWorkflows = signal([makeWorkflow()]);
	mockAgents = signal([]);
	mockActiveRuns = signal([]);
	capturedVisualEditorProps = {};
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('SpaceIsland — visual workflow editor', () => {
	it('does not show the visual editor when the workflows list is open', () => {
		const { queryByTestId } = renderOnWorkflowsTab();
		expect(queryByTestId('visual-workflow-editor')).toBeNull();
	});

	it('opens the visual editor when creating a workflow', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
	});

	it('opens the visual editor when editing an existing workflow', () => {
		const result = renderOnWorkflowsTab();
		openEditEditor(result);
		expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
	});

	it('passes undefined workflow to the visual editor when creating new', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		expect(capturedVisualEditorProps.workflow).toBeUndefined();
	});

	it('passes the existing workflow to the visual editor when editing', () => {
		const result = renderOnWorkflowsTab();
		openEditEditor(result);
		expect((capturedVisualEditorProps.workflow as SpaceWorkflow)?.id).toBe('wf-existing');
	});

	it('hides the tab bar while the visual editor is open', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		expect(result.queryByTestId('space-tab-bar')).toBeNull();
	});

	it('restores the tab bar after saving the visual editor', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		fireEvent.click(result.getByTestId('visual-editor-save'));
		expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
		expect(result.getByTestId('space-tab-bar')).toBeTruthy();
	});

	it('closes the visual editor on cancel', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		fireEvent.click(result.getByTestId('visual-editor-cancel'));
		expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
		expect(result.getByTestId('space-tab-bar')).toBeTruthy();
	});
});

describe('SpaceIsland — dashboard integration', () => {
	it('shows the dashboard view on the dashboard tab', () => {
		const { getByTestId } = render(<SpaceIsland spaceId="space-1" />);
		expect(getByTestId('dashboard-view')).toBeTruthy();
		expect(getByTestId('space-dashboard')).toBeTruthy();
	});

	it('does not render a dashboard canvas wrapper', () => {
		const { queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
		expect(queryByTestId('canvas-panel')).toBeNull();
		expect(queryByTestId('dashboard-fallback')).toBeNull();
	});

	describe('Agents tab', () => {
		it('renders SpaceAgentList inside a padded wrapper', () => {
			const { getByTestId, getByText } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByText('Agents'));
			const agentList = getByTestId('space-agent-list');
			const wrapper = agentList.parentElement;
			expect(wrapper?.className).toContain('p-6');
		});
	});

	it('does not show the dashboard view when on agents tab', () => {
		const { queryByTestId, getByText } = render(<SpaceIsland spaceId="space-1" />);
		fireEvent.click(getByText('Agents'));
		expect(queryByTestId('dashboard-view')).toBeNull();
	});
});

describe('SpaceIsland — dashboard actions', () => {
	describe('Space agent action', () => {
		it('routes to the space agent when Ask Space Agent is clicked', async () => {
			const router = await import('../../lib/router');
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByTestId('quick-open-space-agent'));
			expect(router.navigateToSpaceAgent).toHaveBeenCalledWith('space-1');
		});
	});
});

describe('SpaceIsland — content priority chain', () => {
	describe('sessionViewId prop', () => {
		it('renders ChatContainer when sessionViewId is set', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" sessionViewId="session-abc" />);
			expect(getByTestId('chat-container')).toBeTruthy();
		});

		it('passes sessionId to ChatContainer', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" sessionViewId="session-abc" />);
			expect(getByTestId('chat-container').getAttribute('data-session-id')).toBe('session-abc');
		});

		it('does not render tab bar when sessionViewId is set', () => {
			const { queryByText } = render(<SpaceIsland spaceId="space-1" sessionViewId="session-abc" />);
			expect(queryByText('Dashboard')).toBeNull();
		});

		it('renders tab view when sessionViewId is null', () => {
			const { getByText, queryByTestId } = render(
				<SpaceIsland spaceId="space-1" sessionViewId={null} />
			);
			expect(getByText('Dashboard')).toBeTruthy();
			expect(queryByTestId('chat-container')).toBeNull();
		});

		it('renders tab view when neither sessionViewId nor taskViewId is set', () => {
			const { getByText, queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			expect(getByText('Dashboard')).toBeTruthy();
			expect(queryByTestId('chat-container')).toBeNull();
		});
	});

	describe('taskViewId prop', () => {
		it('shows SpaceTaskPane wrapper when taskViewId is set', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" taskViewId="task-xyz" />);
			expect(getByTestId('space-task-pane')).toBeTruthy();
		});

		it('hides tab bar when taskViewId is set (full-width task view)', () => {
			const { queryByText } = render(<SpaceIsland spaceId="space-1" taskViewId="task-xyz" />);
			expect(queryByText('Dashboard')).toBeNull();
			expect(queryByText('Agents')).toBeNull();
		});

		it('passes spaceId and taskId to SpaceTaskPane', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" taskViewId="task-xyz" />);
			const inner = getByTestId('space-task-pane-inner');
			expect(inner.getAttribute('data-task-id')).toBe('task-xyz');
			expect(inner.getAttribute('data-space-id')).toBe('space-1');
		});

		it('does not show SpaceTaskPane when taskViewId is null', () => {
			const { queryByTestId } = render(<SpaceIsland spaceId="space-1" taskViewId={null} />);
			expect(queryByTestId('space-task-pane')).toBeNull();
		});

		it('sessionViewId takes priority over taskViewId — renders ChatContainer', () => {
			const { getByTestId, queryByTestId } = render(
				<SpaceIsland spaceId="space-1" sessionViewId="session-abc" taskViewId="task-xyz" />
			);
			expect(getByTestId('chat-container')).toBeTruthy();
			expect(queryByTestId('space-task-pane')).toBeNull();
		});
	});
});
