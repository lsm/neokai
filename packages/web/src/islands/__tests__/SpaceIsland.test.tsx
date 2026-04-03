// @ts-nocheck
/**
 * Tests for SpaceIsland.
 *
 * Covers:
 * - route-driven overview vs configure rendering
 * - workflow editor behavior inside configure
 * - content priority for session/task routes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceWorkflow, SpaceAgent, Space, SpaceWorkflowRun } from '@neokai/shared';

let mockLoading = signal(false);
let mockError = signal<string | null>(null);
let mockSpace = signal<Space | null>(null);
let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceAgent[]>([]);
let mockActiveRuns = signal<SpaceWorkflowRun[]>([]);
let mockWorkflowRuns = signal<SpaceWorkflowRun[]>([]);

const mockSelectSpace = vi.fn().mockResolvedValue(undefined);

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

vi.mock('../../components/space/WorkflowCanvas', () => ({
	WorkflowCanvas: (props: { workflowId: string; runId?: string | null; spaceId: string }) => (
		<div
			data-testid="workflow-canvas"
			data-workflow-id={props.workflowId}
			data-run-id={props.runId ?? ''}
		/>
	),
}));

vi.mock('../../components/space/SpaceDashboard', () => ({
	SpaceDashboard: (props: { onOpenSpaceAgent?: () => void }) => (
		<div data-testid="space-dashboard">
			<button data-testid="quick-open-space-agent" onClick={props.onOpenSpaceAgent}>
				Ask Space Agent
			</button>
		</div>
	),
}));

vi.mock('../../components/space/SpaceTaskPane', () => ({
	SpaceTaskPane: (props: { taskId: string | null; spaceId?: string }) => (
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
			workflowRuns: mockWorkflowRuns,
			selectSpace: mockSelectSpace,
		};
	},
}));

vi.mock('../../lib/router', () => ({
	navigateToSpace: vi.fn(),
	navigateToSpaceAgent: vi.fn(),
	navigateToSpaceTask: vi.fn(),
}));

import SpaceIsland from '../SpaceIsland';

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

beforeEach(() => {
	mockLoading = signal(false);
	mockError = signal(null);
	mockSpace = signal(makeSpace());
	mockWorkflows = signal([makeWorkflow()]);
	mockAgents = signal([]);
	mockActiveRuns = signal([]);
	mockWorkflowRuns = signal([]);
	capturedVisualEditorProps = {};
});

afterEach(() => {
	cleanup();
});

describe('SpaceIsland — route-driven views', () => {
	it('renders the overview view with tab bar by default', () => {
		const { getByTestId } = render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
		// Outer wrapper
		expect(getByTestId('space-overview-view')).toBeTruthy();
		// Tab bar is present
		expect(getByTestId('space-tab-bar')).toBeTruthy();
		// SpaceDashboard is in the dashboard-fallback (mobile/no-canvas path)
		expect(getByTestId('space-dashboard')).toBeTruthy();
	});

	it('renders the configure view when requested', () => {
		const { getByTestId } = render(<SpaceIsland spaceId="space-1" viewMode="configure" />);
		expect(getByTestId('space-configure-view')).toBeTruthy();
		expect(getByTestId('space-agent-list')).toBeTruthy();
	});

	it('routes to the space agent when Ask Space Agent is clicked from overview', async () => {
		const router = await import('../../lib/router');
		const { getByTestId } = render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
		fireEvent.click(getByTestId('quick-open-space-agent'));
		expect(router.navigateToSpaceAgent).toHaveBeenCalledWith('space-1');
	});
});

describe('SpaceIsland — configure workflow editor', () => {
	function renderConfigure() {
		return render(<SpaceIsland spaceId="space-1" viewMode="configure" />);
	}

	it('renders configure sub-tabs', () => {
		const { getByTestId } = renderConfigure();
		expect(getByTestId('space-configure-tab-bar')).toBeTruthy();
		expect(getByTestId('space-configure-tab-agents')).toBeTruthy();
		expect(getByTestId('space-configure-tab-workflows')).toBeTruthy();
		expect(getByTestId('space-configure-tab-settings')).toBeTruthy();
	});

	it('opens the visual editor when creating a workflow', () => {
		const result = renderConfigure();
		fireEvent.click(result.getByTestId('space-configure-tab-workflows'));
		fireEvent.click(result.getByTestId('create-workflow-btn'));
		expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
		expect(capturedVisualEditorProps.workflow).toBeUndefined();
	});

	it('opens the visual editor when editing a workflow', () => {
		const result = renderConfigure();
		fireEvent.click(result.getByTestId('space-configure-tab-workflows'));
		fireEvent.click(result.getByTestId('edit-workflow-btn'));
		expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
		expect((capturedVisualEditorProps.workflow as SpaceWorkflow)?.id).toBe('wf-existing');
	});

	it('hides configure sub-tabs while editing a workflow', () => {
		const result = renderConfigure();
		fireEvent.click(result.getByTestId('space-configure-tab-workflows'));
		fireEvent.click(result.getByTestId('create-workflow-btn'));
		expect(result.queryByTestId('space-configure-tab-bar')).toBeNull();
	});

	it('restores configure sub-tabs after save', () => {
		const result = renderConfigure();
		fireEvent.click(result.getByTestId('space-configure-tab-workflows'));
		fireEvent.click(result.getByTestId('create-workflow-btn'));
		fireEvent.click(result.getByTestId('visual-editor-save'));
		expect(result.getByTestId('space-configure-tab-bar')).toBeTruthy();
	});
});

describe('SpaceIsland — content priority chain', () => {
	it('renders ChatContainer when sessionViewId is set', () => {
		const { getByTestId } = render(
			<SpaceIsland spaceId="space-1" viewMode="overview" sessionViewId="session-abc" />
		);
		expect(getByTestId('chat-container')).toBeTruthy();
	});

	it('renders SpaceTaskPane when taskViewId is set', () => {
		const { getByTestId } = render(
			<SpaceIsland spaceId="space-1" viewMode="overview" taskViewId="task-xyz" />
		);
		expect(getByTestId('space-task-pane')).toBeTruthy();
		expect(getByTestId('space-task-pane-inner').getAttribute('data-task-id')).toBe('task-xyz');
	});

	it('sessionViewId takes priority over taskViewId', () => {
		const { getByTestId, queryByTestId } = render(
			<SpaceIsland
				spaceId="space-1"
				viewMode="overview"
				sessionViewId="session-abc"
				taskViewId="task-xyz"
			/>
		);
		expect(getByTestId('chat-container')).toBeTruthy();
		expect(queryByTestId('space-task-pane')).toBeNull();
	});
});
