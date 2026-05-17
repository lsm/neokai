import { describe, test, expect } from 'bun:test';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

function makeManager(memoryRepo?: unknown): TaskAgentManager {
	return Object.create(TaskAgentManager.prototype, {
		config: {
			value: { memoryRepo },
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
});
