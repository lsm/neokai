/**
 * Coordinator Agents Tests
 *
 * Tests the coordinator mode agent definitions and merging logic.
 */

import { describe, expect, it } from 'bun:test';
import { getCoordinatorAgents } from '../../../src/lib/agent/coordinator-agents';
import type { AgentDefinition } from '@neokai/shared';

describe('getCoordinatorAgents', () => {
	it('should return coordinator and all specialist agents', () => {
		const agents = getCoordinatorAgents();

		expect(agents.coordinator).toBeDefined();
		expect(agents.coder).toBeDefined();
		expect(agents.debugger).toBeDefined();
		expect(agents.tester).toBeDefined();
		expect(agents.reviewer).toBeDefined();
		expect(agents.vcs).toBeDefined();
		expect(agents.verifier).toBeDefined();
		expect(agents.executor).toBeDefined();
	});

	it('should include coordinator agent with orchestration tools only', () => {
		const agents = getCoordinatorAgents();
		const coordinator = agents.coordinator;

		expect(coordinator.tools).toContain('Task');
		expect(coordinator.tools).toContain('TodoWrite');
		expect(coordinator.tools).toContain('AskUserQuestion');
		expect(coordinator.model).toBe('opus');
	});

	it('should include specialist agents with appropriate tools', () => {
		const agents = getCoordinatorAgents();

		// Coder should have file editing tools
		expect(agents.coder.tools).toContain('Edit');
		expect(agents.coder.tools).toContain('Write');

		// Debugger should have file tools for writing tests
		expect(agents.debugger.tools).toContain('Bash');
		expect(agents.debugger.tools).toContain('Write');

		// VCS should have Bash for git operations
		expect(agents.vcs.tools).toContain('Bash');
	});

	it('should merge user agents with specialists', () => {
		const userAgents: Record<string, AgentDefinition> = {
			'custom-agent': {
				description: 'A custom agent',
				prompt: 'You are a custom agent.',
			},
		};

		const agents = getCoordinatorAgents(userAgents);

		expect(agents['custom-agent']).toBeDefined();
		expect(agents['custom-agent'].description).toBe('A custom agent');
		// Specialists should still be present
		expect(agents.coder).toBeDefined();
		expect(agents.coordinator).toBeDefined();
	});

	it('should let specialists win on name conflicts with user agents', () => {
		const userAgents: Record<string, AgentDefinition> = {
			coder: {
				description: 'User-defined coder',
				prompt: 'Custom coder prompt.',
			},
		};

		const agents = getCoordinatorAgents(userAgents);

		// Specialist should win over user agent
		expect(agents.coder.description).not.toBe('User-defined coder');
	});

	it('should return correct number of agents', () => {
		const agents = getCoordinatorAgents();
		const agentNames = Object.keys(agents);

		// coordinator + 7 specialists = 8
		expect(agentNames).toHaveLength(8);
	});

	it('should work with undefined user agents', () => {
		const agents = getCoordinatorAgents(undefined);

		expect(agents.coordinator).toBeDefined();
		expect(Object.keys(agents)).toHaveLength(8);
	});

	it('should have verifier using opus model for critical verification', () => {
		const agents = getCoordinatorAgents();

		expect(agents.verifier.model).toBe('opus');
	});

	it('should have all agents with non-empty prompts', () => {
		const agents = getCoordinatorAgents();

		for (const [_name, agent] of Object.entries(agents)) {
			expect(agent.prompt.length).toBeGreaterThan(0);
			expect(agent.description.length).toBeGreaterThan(0);
		}
	});
});
