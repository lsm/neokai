import { describe, test, expect, mock } from 'bun:test';
import type { McpServerConfig } from '@neokai/shared';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

function makeManager(memoryRepo?: unknown): TaskAgentManager {
	return Object.create(TaskAgentManager.prototype, {
		config: {
			value: { memoryRepo },
		},
	}) as TaskAgentManager;
}

function makeSession(mcpServers: Record<string, McpServerConfig>) {
	let restartCount = 0;
	return {
		session: { config: { mcpServers } },
		mergeRuntimeMcpServers(servers: Record<string, McpServerConfig>) {
			this.session.config.mcpServers = {
				...this.session.config.mcpServers,
				...servers,
			};
		},
		async restartQuery() {
			restartCount += 1;
		},
		get restartCount() {
			return restartCount;
		},
	};
}

function makeSpaceToolsManager(): TaskAgentManager {
	return Object.create(TaskAgentManager.prototype, {
		config: {
			value: {},
		},
		reinjectSpaceAgentToolsMcpServer: {
			value: mock(async (session) => {
				session.mergeRuntimeMcpServers({
					'space-agent-tools': { type: 'sdk' } as McpServerConfig,
				});
			}),
		},
	}) as TaskAgentManager;
}

describe('TaskAgentManager agent-memory MCP wiring', () => {
	test('builds agent-memory server when memory repo is configured', () => {
		const manager = makeManager({});
		const servers = manager.buildAgentMemoryMcpServers('space-a', 'session-a');

		expect(Object.keys(servers)).toContain('agent-memory');
	});

	test('omits agent-memory server when memory repo is absent', () => {
		const manager = makeManager();
		const servers = manager.buildAgentMemoryMcpServers('space-a', 'session-a');

		expect(servers).toEqual({});
	});

	test('requires agent-memory only when memory repo is configured', () => {
		expect(makeManager().requiredWorkflowSubSessionMcpServers()).toEqual([
			'node-agent',
			'space-agent-tools',
		]);
		expect(makeManager({}).requiredWorkflowSubSessionMcpServers()).toEqual([
			'node-agent',
			'space-agent-tools',
			'agent-memory',
		]);
	});

	test('reattaches agent-memory when missing during rehydrate self-heal', async () => {
		const manager = makeManager({});
		const session = makeSession({
			'node-agent': { type: 'sdk' } as McpServerConfig,
			'space-agent-tools': { type: 'sdk' } as McpServerConfig,
		});

		await manager.ensureNodeAgentAttached(session as never, {
			taskId: 'task-a',
			subSessionId: 'session-a',
			agentName: 'coder',
			spaceId: 'space-a',
			workflowRunId: 'run-a',
			workspacePath: '/tmp/space-a',
			workflowNodeId: 'node-a',
			phase: 'rehydrate',
		});

		expect(Object.keys(session.session.config.mcpServers).sort()).toEqual([
			'agent-memory',
			'node-agent',
			'space-agent-tools',
		]);
		expect(session.restartCount).toBe(1);
	});

	test('reattaches space-agent-tools and wires member self-heal callback', async () => {
		const manager = makeSpaceToolsManager();
		const session = makeSession({
			'node-agent': { type: 'sdk' } as McpServerConfig,
		});

		await manager.ensureNodeAgentAttached(session as never, {
			taskId: 'task-a',
			subSessionId: 'session-a',
			agentName: 'coder',
			spaceId: 'space-a',
			workflowRunId: 'run-a',
			workspacePath: '/tmp/space-a',
			workflowNodeId: 'node-a',
			phase: 'rehydrate',
		});

		expect(Object.keys(session.session.config.mcpServers).sort()).toEqual([
			'node-agent',
			'space-agent-tools',
		]);
		expect(typeof session.onMissingMemberSpaceMcpServers).toBe('function');
	});
});
