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

	it('prefers nodeExecutionId over agentName when resolving node_agent', () => {
		const membersWithNodeExecution: SpaceTaskActivityMember[] = [
			{
				id: 'm1',
				sessionId: 'reviewer-a-session',
				kind: 'node_agent',
				label: 'Reviewer A',
				role: 'reviewer',
				state: 'active',
				processingStatus: 'idle',
				messageCount: 0,
				nodeExecution: {
					nodeExecutionId: 'ne-a',
					nodeId: 'n1',
					agentName: 'reviewer',
					status: 'in_progress',
				},
			},
			{
				id: 'm2',
				sessionId: 'reviewer-b-session',
				kind: 'node_agent',
				label: 'Reviewer B',
				role: 'reviewer',
				state: 'active',
				processingStatus: 'idle',
				messageCount: 0,
				nodeExecution: {
					nodeExecutionId: 'ne-b',
					nodeId: 'n2',
					agentName: 'reviewer',
					status: 'in_progress',
				},
			},
		];

		const targetA = {
			id: 'node:n1:reviewer',
			kind: 'node_agent' as const,
			label: 'Reviewer A',
			agentName: 'reviewer',
			nodeExecutionId: 'ne-a',
		};
		const targetB = {
			id: 'node:n2:reviewer',
			kind: 'node_agent' as const,
			label: 'Reviewer B',
			agentName: 'reviewer',
			nodeExecutionId: 'ne-b',
		};

		expect(resolveTargetSessionId(targetA, membersWithNodeExecution, 'task-session')).toBe(
			'reviewer-a-session'
		);
		expect(resolveTargetSessionId(targetB, membersWithNodeExecution, 'task-session')).toBe(
			'reviewer-b-session'
		);
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
						{
							id: 'claude-opus-4-5',
							display_name: 'Claude Opus 4.5',
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
			if (method === 'session.model.switch') {
				return Promise.resolve({ success: true, model: 'claude-opus-4-5' });
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
				taskId: 'task-1',
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
				taskId: 'task-1',
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
				taskId: 'task-1',
				selectedTarget: notStartedTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
				defaultAgentModels: new Map([['node:n1:reviewer', 'claude-opus-4-5']]),
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
				taskId: 'task-1',
				selectedTarget: notStartedTarget,
				activityMembers: members,
				taskAgentSessionId: 'task-sess-123',
				defaultAgentModels: new Map([['node:n1:reviewer', 'claude-opus-4-5']]),
			})
		);

		await waitFor(() => {
			expect(result.current.currentModel).toBe('claude-opus-4-5');
		});
	});

	it('derives isProcessing from activity member processingStatus', async () => {
		const { result } = renderHook(() =>
			useTargetSessionContext({
				taskId: 'task-1',
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
				taskId: 'task-1',
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
				taskId: 'task-1',
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
				taskId: 'task-1',
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

	it('auto-applies pre-configured model and thinking when session spawns', async () => {
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

		const { result, rerender } = renderHook(
			(props: { members: SpaceTaskActivityMember[] }) =>
				useTargetSessionContext({
					taskId: 'task-1',
					selectedTarget: notStartedTarget,
					activityMembers: props.members,
					taskAgentSessionId: 'task-sess-123',
				}),
			{ initialProps: { members: [] as SpaceTaskActivityMember[] } }
		);

		// Pre-configure model and thinking while agent is not started
		await act(async () => {
			await result.current.switchModel(model);
		});
		await act(async () => {
			await result.current.setThinkingLevel('think16k');
		});

		expect(result.current.currentModel).toBe('claude-opus-4-5');
		expect(result.current.thinkingLevel).toBe('think16k');
		expect(mockRequest).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
		expect(mockRequest).not.toHaveBeenCalledWith('session.thinking.set', expect.anything());

		// Spawn the agent session
		const spawnedMembers: SpaceTaskActivityMember[] = [
			{
				id: 'm-reviewer',
				sessionId: 'reviewer-session',
				kind: 'node_agent',
				label: 'Reviewer',
				role: 'reviewer',
				state: 'active',
				processingStatus: 'idle',
				messageCount: 0,
			},
		];

		rerender({ members: spawnedMembers });

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
				sessionId: 'reviewer-session',
				model: 'claude-opus-4-5',
				provider: 'anthropic',
			});
		});

		expect(mockRequest).toHaveBeenCalledWith('session.thinking.set', {
			sessionId: 'reviewer-session',
			level: 'think16k',
		});
	});

	it('retries auto-apply when pre-config persistence fails', async () => {
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

		// First call fails, second succeeds
		let callCount = 0;
		mockRequest.mockImplementation((method: string) => {
			if (method === 'models.list') {
				return Promise.resolve({
					models: [
						{
							id: 'claude-opus-4-5',
							display_name: 'Claude Opus 4.5',
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
			if (method === 'session.model.switch') {
				callCount++;
				if (callCount === 1) {
					return Promise.reject(new Error('Switch failed'));
				}
				return Promise.resolve({ success: true, model: 'claude-opus-4-5' });
			}
			return Promise.resolve({});
		});

		const { result, rerender } = renderHook(
			(props: { members: SpaceTaskActivityMember[] }) =>
				useTargetSessionContext({
					taskId: 'task-1',
					selectedTarget: notStartedTarget,
					activityMembers: props.members,
					taskAgentSessionId: 'task-sess-123',
				}),
			{ initialProps: { members: [] as SpaceTaskActivityMember[] } }
		);

		await act(async () => {
			await result.current.switchModel(model);
		});

		// Spawn session — first attempt fails
		const spawnedMembers: SpaceTaskActivityMember[] = [
			{
				id: 'm-reviewer',
				sessionId: 'reviewer-session',
				kind: 'node_agent',
				label: 'Reviewer',
				role: 'reviewer',
				state: 'active',
				processingStatus: 'idle',
				messageCount: 0,
			},
		];

		rerender({ members: spawnedMembers });

		// Wait for the first auto-apply attempt to run (may be preceded by a
		// no-op run while switcherModels is still empty from the fresh
		// useModelSwitcher instance).
		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('session.model.switch', {
				sessionId: 'reviewer-session',
				model: 'claude-opus-4-5',
				provider: 'anthropic',
			});
		});

		// The first attempt fails, so the target is not marked as applied.
		// A subsequent re-render should trigger a retry.
		rerender({ members: [...spawnedMembers] });

		await waitFor(() => {
			expect(callCount).toBeGreaterThanOrEqual(2);
		});
	});

	it('resets preconfiguration when taskId changes', async () => {
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

		const { result, rerender } = renderHook(
			(props: { taskId: string }) =>
				useTargetSessionContext({
					taskId: props.taskId,
					selectedTarget: notStartedTarget,
					activityMembers: [],
					taskAgentSessionId: 'task-sess-123',
				}),
			{ initialProps: { taskId: 'task-a' } }
		);

		// Pre-configure model for task-a
		await act(async () => {
			await result.current.switchModel(model);
		});

		expect(result.current.currentModel).toBe('claude-opus-4-5');

		// Switch to a different task — preconfiguration should reset
		rerender({ taskId: 'task-b' });

		// Default model is empty for this target, so after reset currentModel
		// should fall back to empty string.
		await waitFor(() => {
			expect(result.current.currentModel).toBe('');
		});
	});
});
