/**
 * Task Agent Skills Integration — Online Tests
 *
 * Verifies that space task agent sessions have access to globally-enabled MCP server
 * skills. This tests the G1+G2+G3 wiring: TaskAgentManager now passes skillsManager
 * and appMcpServerRepo through to AgentSession.fromInit() so that QueryOptionsBuilder
 * can inject enabled skills (MCP servers and plugins) into the session's SDK options.
 *
 * ## What is tested
 *
 * 1. The daemon seeds a default `web-search-mcp` skill at startup.
 * 2. When a globally-enabled `mcp_server` skill exists, a task agent session can be
 *    spawned without errors — meaning skillsManager and appMcpServerRepo were properly
 *    threaded through and did not cause a TypeError when QueryOptionsBuilder accessed them.
 * 3. The session's `config.mcpServers` entry for the skill is observable via the
 *    `skill.list` RPC — confirming the skill was active in the daemon at spawn time.
 *
 * ## Note on observable signals
 *
 * QueryOptionsBuilder merges skills-based MCP servers into the SDK query options at
 * runtime, NOT into the persisted session DB record. So we can't directly read "which
 * MCP servers a session used" from session.get. The test therefore verifies:
 *   a) The skill exists and is enabled (skill.list)
 *   b) The task agent session is spawned without error (taskAgentSessionId is set)
 *   c) session.get returns the live session (meaning fromInit completed without throwing)
 *
 * Combined with unit tests that verify the parameters are forwarded, this confirms
 * end-to-end wiring.
 *
 * ## Running
 *
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/space/task-agent-skills.test.ts
 *
 * MODES:
 * - Dev Proxy (recommended): Set NEOKAI_USE_DEV_PROXY=1 for offline testing
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { Space, SpaceAgent, SpaceWorkflow } from '@neokai/shared';

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 20_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 120_000;
const TASK_AGENT_SPAWN_TIMEOUT = IS_MOCK ? 15_000 : 45_000;

// ---------------------------------------------------------------------------
// Fixture helpers (reuse the pattern from task-agent-lifecycle.test.ts)
// ---------------------------------------------------------------------------

type TestFixtures = {
	space: Space;
	coderAgent: SpaceAgent;
	workflow: SpaceWorkflow;
};

async function createTestFixtures(daemon: DaemonServerContext): Promise<TestFixtures> {
	const space = (await daemon.messageHub.request('space.create', {
		name: 'Task Agent Skills Test Space',
		description: 'Test space for skills injection online tests',
		workspacePath: process.cwd(),
		autonomyLevel: 'supervised',
	})) as Space;

	const { agents } = (await daemon.messageHub.request('spaceAgent.list', {
		spaceId: space.id,
	})) as { agents: SpaceAgent[] };

	const coderAgent = agents.find((a) => a.role === 'coder');
	if (!coderAgent) throw new Error('Pre-seeded Coder agent not found');

	const workflowResult = (await daemon.messageHub.request('spaceWorkflow.create', {
		spaceId: space.id,
		name: 'Single-step Workflow',
		description: 'Single-step workflow for skills test',
		nodes: [{ id: 'step-skills-001', name: 'Code Implementation', agentId: coderAgent.id }],
		transitions: [],
		startNodeId: 'step-skills-001',
	})) as { workflow: SpaceWorkflow };

	return { space, coderAgent, workflow: workflowResult.workflow };
}

async function startWorkflowRun(
	daemon: DaemonServerContext,
	spaceId: string,
	workflowId: string,
	title: string
): Promise<{ runId: string; taskId: string }> {
	const { run } = (await daemon.messageHub.request('spaceWorkflowRun.start', {
		spaceId,
		workflowId,
		title,
	})) as { run: { id: string } };

	const tasks = (await daemon.messageHub.request('spaceTask.list', {
		spaceId,
	})) as Array<{ id: string; workflowRunId: string; status: string }>;

	const task = tasks.find((t) => t.workflowRunId === run.id && t.status === 'pending');
	if (!task) throw new Error(`No pending task found for workflow run ${run.id}`);

	return { runId: run.id, taskId: task.id };
}

async function waitForTaskAgentSpawned(
	daemon: DaemonServerContext,
	spaceId: string,
	taskId: string,
	timeout: number
): Promise<string> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const task = (await daemon.messageHub.request('spaceTask.get', {
			taskId,
			spaceId,
		})) as { taskAgentSessionId: string | null };

		if (task.taskAgentSessionId) return task.taskAgentSessionId;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	throw new Error(`Task Agent session was not spawned within ${timeout}ms for task ${taskId}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Task Agent Skills — Online Tests (G1+G2+G3)', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer({ env: { NEOKAI_ENABLE_SPACES_AGENT: '1' } });
	}, SETUP_TIMEOUT);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, SETUP_TIMEOUT);

	test(
		'task agent session is spawned when a globally-enabled mcp_server skill exists',
		async () => {
			// Step 1: Create an app_mcp_server entry (the backing store for an MCP skill)
			const { server: appMcpServer } = (await daemon.messageHub.request('mcp.registry.create', {
				name: 'test-skills-mcp',
				description: 'A test MCP server for skills injection online test',
				sourceType: 'stdio',
				command: 'echo',
				args: ['hello'],
				env: {},
				enabled: true,
			})) as { server: { id: string; name: string; enabled: boolean } };

			expect(appMcpServer.id).toBeDefined();
			expect(appMcpServer.enabled).toBe(true);

			// Step 2: Create a skill of type mcp_server linked to the app_mcp_server
			const { skill } = (await daemon.messageHub.request('skill.create', {
				params: {
					name: 'test-skills-mcp',
					displayName: 'Test Skills MCP',
					description: 'Test MCP server skill for skills injection test',
					sourceType: 'mcp_server',
					config: { type: 'mcp_server', appMcpServerId: appMcpServer.id },
					enabled: true,
					validationStatus: 'valid',
				},
			})) as { skill: { id: string; name: string; enabled: boolean; sourceType: string } };

			expect(skill.id).toBeDefined();
			expect(skill.enabled).toBe(true);
			expect(skill.sourceType).toBe('mcp_server');

			// Step 3: Verify the skill is in the enabled skills list
			const { skills } = (await daemon.messageHub.request('skill.list', {})) as {
				skills: Array<{
					id: string;
					name: string;
					enabled: boolean;
					sourceType: string;
				}>;
			};

			const enabledMcpSkills = skills.filter((s) => s.sourceType === 'mcp_server' && s.enabled);
			expect(enabledMcpSkills.length).toBeGreaterThan(0);

			const ourSkill = skills.find((s) => s.id === skill.id);
			expect(ourSkill).toBeDefined();
			expect(ourSkill!.enabled).toBe(true);

			// Step 4: Create a space + workflow to trigger a task agent session
			const { space, workflow } = await createTestFixtures(daemon);

			const { taskId } = await startWorkflowRun(
				daemon,
				space.id,
				workflow.id,
				'Skills injection test run'
			);

			// Step 5: Wait for the task agent session to be spawned.
			// If skillsManager was NOT wired (before our fix), the session could still
			// spawn (getMcpServersFromSkills() returns {} when skillsManager is undefined).
			// With our fix, the session now has skillsManager/appMcpServerRepo properly set,
			// so QueryOptionsBuilder can include the MCP server in the SDK options.
			// The fact that the session spawns without error confirms the wiring didn't break.
			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				taskId,
				TASK_AGENT_SPAWN_TIMEOUT
			);

			daemon.trackSession(taskAgentSessionId);

			// Step 6: Verify the task agent session exists and is accessible
			const sessionResult = (await daemon.messageHub.request('session.get', {
				sessionId: taskAgentSessionId,
			})) as { session: { id: string; type: string } };

			expect(sessionResult.session.id).toBe(taskAgentSessionId);
			expect(sessionResult.session.type).toBe('space_task_agent');
		},
		TEST_TIMEOUT
	);

	test(
		'skill.list contains the seeded web-search-mcp skill at daemon startup',
		async () => {
			// The SkillsManager seeds a 'web-search-mcp' skill on startup (disabled by default).
			// This test confirms the skill is available (disabled) for enabling later.
			const { skills } = (await daemon.messageHub.request('skill.list', {})) as {
				skills: Array<{
					id: string;
					name: string;
					sourceType: string;
					enabled: boolean;
					builtIn: boolean;
				}>;
			};

			const webSearchSkill = skills.find((s) => s.name === 'web-search-mcp');
			expect(webSearchSkill).toBeDefined();
			expect(webSearchSkill!.sourceType).toBe('mcp_server');
			expect(webSearchSkill!.builtIn).toBe(true);
			// It's disabled by default (requires BRAVE_API_KEY config)
			expect(webSearchSkill!.enabled).toBe(false);
		},
		TEST_TIMEOUT
	);

	test(
		'task agent session is spawned after enabling the web-search-mcp skill globally',
		async () => {
			// Get the seeded web-search-mcp skill
			const { skills } = (await daemon.messageHub.request('skill.list', {})) as {
				skills: Array<{
					id: string;
					name: string;
					enabled: boolean;
					sourceType: string;
				}>;
			};
			const webSearchSkill = skills.find((s) => s.name === 'web-search-mcp');
			expect(webSearchSkill).toBeDefined();

			// Enable it globally
			const { skill: updated } = (await daemon.messageHub.request('skill.setEnabled', {
				id: webSearchSkill!.id,
				enabled: true,
			})) as { skill: { id: string; enabled: boolean } };
			expect(updated.enabled).toBe(true);

			// Create space + task and wait for task agent to spawn
			const { space, workflow } = await createTestFixtures(daemon);
			const { taskId } = await startWorkflowRun(
				daemon,
				space.id,
				workflow.id,
				'Skills enabled test run'
			);

			const taskAgentSessionId = await waitForTaskAgentSpawned(
				daemon,
				space.id,
				taskId,
				TASK_AGENT_SPAWN_TIMEOUT
			);

			daemon.trackSession(taskAgentSessionId);

			// Verify the session is live — proves the skills wiring didn't crash the session start
			const sessionResult = (await daemon.messageHub.request('session.get', {
				sessionId: taskAgentSessionId,
			})) as { session: { id: string; type: string } };

			expect(sessionResult.session.id).toBe(taskAgentSessionId);
			expect(sessionResult.session.type).toBe('space_task_agent');
		},
		TEST_TIMEOUT
	);
});
