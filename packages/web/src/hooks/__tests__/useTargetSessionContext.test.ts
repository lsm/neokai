import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/preact';
import type { SpaceTaskActivityMember, ModelInfo } from '@neokai/shared';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();

vi.mock('../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: () => mockGetHubIfConnected(),
	},
}));

vi.mock('../../lib/toast', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock('../../lib/state', () => ({
	connectionState: { value: 'connected' },
}));

import { useTargetSessionContext, resolveTargetSessionId } from '../useTargetSessionContext';

describe('resolveTargetSessionId', () => {
	const members: SpaceTaskActivityMember[] = [
		{
			id: 'm1',
			sessionId: 'coder-session',
			kind: 'node_agent',
			label: 'Coder',
			role: 'coder',
			state: 'active',
			processingStatus: 'idle',
			messageCount: 0,
		},
	];

	it('returns taskAgentSessionId for task_agent target', () => {
		const target = { id: 'task-agent', kind: 'task_agent' as const, label: 'Task Agent' };
		expect(resolveTargetSessionId(target, members, 'task-session')).toBe('task-session');
	});

	it('returns member sessionId for node_agent target', () => {
		const target = {
			id: 'node:n1:coder',
			kind: 'node_agent' as const,
			label: 'Coder',
			agentName: 'coder',
		};
		expect(resolveTargetSessionId(target, members, 'task-session')).toBe('coder-session');
	});

	it('returns null for not-yet-started node_agent', () => {
		const target = {
			id: 'node:n1:reviewer',
			kind: 'node_agent' as const,
			label: 'Reviewer',
			agentName: 'reviewer',
		};
		expect(resolveTargetSessionId(target, members, 'task-session')).toBeNull();
	});

	it('returns null when target is null', () => {
		expect(resolveTargetSessionId(null, members, 'task-session')).toBeNull();
	});
});

describe('useTargetSessionContext', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockGetHubIfConnected.mockReturnValue({
			request: mockRequest,
		});
		mockRequest.mockImplementation((method: string) => {
			if (method === 'models.list') {
				return Promise.resolve({
					models: [
						{
							id: 'claude-sonnet-4-6',
							display_name: 'Claude Sonnet 4.6',
							description: '',
							provider: 'anthropic',
						},
					],
				});
			}
			if (method === 'session.model.get') {
				return Promise.resolve({
					currentModel: 'claude-sonnet-4-6',
					modelInfo: {
						id: 'claude-sonnet-4-6',
						name: 'Claude Sonnet 4.6',
						family: 'sonnet',
						provider: 'anthropic',
					},
				});
			}
			return Promise.resolve({});
		});
	});

	const taskAgentTarget = {
		id: 'task-agent',
		kind: 'task_agent' as const,
		label: 'Task Agent',
	};

	const coderTarget = {
		id: 'node:n1:coder',
		kind: 'node_agent' as const,
		label: 'Coder',
		agentName: 'coder',
	};

	const members: SpaceTaskActivityMember[] = [
		{
			id: 'm1',
			sessionId: 'coder-session',
			kind: 'node_agent',
			label: 'Coder',
			role: 'coder',
			state: 'active',
			processingStatus: 'processing',
			messageCount: 0,
		},
	];

	it('resolves task_agent to taskAgentSessionId', async () => {
		const { result } = renderHook(() =>
			useTargetSessionContext({
				selectedTarget: taskAgentTarget,
				activityMembers: [],
				taskAgentSessionId: 'task-sess-123',
			})
		);

		await waitFor(() => {
			expect(result.current.targetSessionId).toBe('task-sess-123');
		});
		expect(result.current.isStarted).toBe(true);
	});

	it('resolves node_agent to member sessionId', async () => {
		const { result } = renderHook(() =>
			useTargetSessionContext({
				selectedTarget: coderTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
			})
		);

		await waitFor(() => {
			expect(result.current.targetSessionId).toBe('coder-session');
		});
		expect(result.current.isStarted).toBe(true);
	});

	it('marks not-yet-started agent as isStarted=false', async () => {
		const notStartedTarget = {
			id: 'node:n1:reviewer',
			kind: 'node_agent' as const,
			label: 'Reviewer',
			agentName: 'reviewer',
		};

		const { result } = renderHook(() =>
			useTargetSessionContext({
				selectedTarget: notStartedTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
				defaultAgentModels: new Map([['reviewer', 'claude-opus-4-5']]),
			})
		);

		await waitFor(() => {
			expect(result.current.isStarted).toBe(false);
		});
		expect(result.current.targetSessionId).toBeNull();
	});

	it('uses workflow default model for not-yet-started agents', async () => {
		const notStartedTarget = {
			id: 'node:n1:reviewer',
			kind: 'node_agent' as const,
			label: 'Reviewer',
			agentName: 'reviewer',
		};

		const { result } = renderHook(() =>
			useTargetSessionContext({
				selectedTarget: notStartedTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
				defaultAgentModels: new Map([['reviewer', 'claude-opus-4-5']]),
			})
		);

		await waitFor(() => {
			expect(result.current.currentModel).toBe('claude-opus-4-5');
		});
	});

	it('derives isProcessing from activity member processingStatus', async () => {
		const { result } = renderHook(() =>
			useTargetSessionContext({
				selectedTarget: coderTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
			})
		);

		await waitFor(() => {
			expect(result.current.isProcessing).toBe(true);
		});
	});

	it('pre-configures model for not-yet-started agents', async () => {
		const notStartedTarget = {
			id: 'node:n1:reviewer',
			kind: 'node_agent' as const,
			label: 'Reviewer',
			agentName: 'reviewer',
		};

		const model: ModelInfo = {
			id: 'claude-opus-4-5',
			name: 'Opus 4.5',
			family: 'opus',
			provider: 'anthropic',
			alias: 'opus',
			contextWindow: 200000,
			description: '',
			releaseDate: '',
			available: true,
		};

		const { result } = renderHook(() =>
			useTargetSessionContext({
				selectedTarget: notStartedTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
			})
		);

		await act(async () => {
			await result.current.switchModel(model);
		});

		expect(result.current.currentModel).toBe('claude-opus-4-5');
	});

	it('sets thinking level for started agents via RPC', async () => {
		const { result } = renderHook(() =>
			useTargetSessionContext({
				selectedTarget: coderTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
			})
		);

		await act(async () => {
			await result.current.setThinkingLevel('think16k');
		});

		expect(mockRequest).toHaveBeenCalledWith('session.thinking.set', {
			sessionId: 'coder-session',
			level: 'think16k',
		});
		expect(result.current.thinkingLevel).toBe('think16k');
	});

	it('pre-configures thinking level for not-yet-started agents', async () => {
		const notStartedTarget = {
			id: 'node:n1:reviewer',
			kind: 'node_agent' as const,
			label: 'Reviewer',
			agentName: 'reviewer',
		};

		const { result } = renderHook(() =>
			useTargetSessionContext({
				selectedTarget: notStartedTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
			})
		);

		await act(async () => {
			await result.current.setThinkingLevel('think32k');
		});

		expect(result.current.thinkingLevel).toBe('think32k');
		expect(mockRequest).not.toHaveBeenCalledWith('session.thinking.set', expect.anything());
	});
});
