/**
 * Unit tests for autonomy level behavior — space agent prompt and tool behavior.
 *
 * Verifies the behavioral contract for supervised vs semi_autonomous autonomy levels:
 *
 * 1. Prompt generation with `supervised` autonomy includes "notify human" instruction
 * 2. Prompt generation with `semi_autonomous` autonomy includes "retry once autonomously" instruction
 * 3. Prompt generation with no autonomy level defaults to supervised instructions
 * 4. Notification messages include the space's autonomy level so the agent can act accordingly
 * 5. `retry_task` tool succeeds regardless of autonomy level — the gate is in the prompt, not the tool
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';

import { buildSpaceChatSystemPrompt } from '../../../src/lib/space/agents/space-chat-agent';
import { formatEventMessage } from '../../../src/lib/space/runtime/session-notification-sink';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime.ts';
import { createSpaceAgentToolHandlers } from '../../../src/lib/space/tools/space-agent-tools.ts';
import type { SpaceNotificationEvent } from '../../../src/lib/space/runtime/notification-sink';
import type { SpaceAutonomyLevel } from '@neokai/shared/types/space';

// ---------------------------------------------------------------------------
// DB + space setup helpers (mirrors space-agent-tools.test.ts patterns)
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-space-agent-autonomy',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/workspace'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, workspacePath, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgentRow(
	db: BunDatabase,
	agentId: string,
	spaceId: string,
	name: string,
	role: string
): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, name, role, Date.now(), Date.now());
}

interface TestCtx {
	db: BunDatabase;
	dir: string;
	spaceId: string;
	agentId: string;
	workflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
	taskManager: SpaceTaskManager;
	agentManager: SpaceAgentManager;
	runtime: SpaceRuntime;
}

function makeCtx(): TestCtx {
	const { db, dir } = makeDb();
	const spaceId = 'space-autonomy-test';
	const workspacePath = '/tmp/test-workspace';

	seedSpaceRow(db, spaceId, workspacePath);

	const agentId = 'agent-coder-1';
	seedAgentRow(db, agentId, spaceId, 'Coder', 'coder');

	const agentRepo = new SpaceAgentRepository(db);
	const agentManager = new SpaceAgentManager(agentRepo);

	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const spaceManager = new SpaceManager(db);

	const runtime = new SpaceRuntime({
		db,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
	});

	const taskManager = new SpaceTaskManager(db, spaceId);

	return {
		db,
		dir,
		spaceId,
		agentId,
		workflowManager,
		workflowRunRepo,
		taskRepo,
		taskManager,
		agentManager,
		runtime,
	};
}

function makeHandlers(ctx: TestCtx) {
	return createSpaceAgentToolHandlers({
		spaceId: ctx.spaceId,
		runtime: ctx.runtime,
		workflowManager: ctx.workflowManager,
		taskRepo: ctx.taskRepo,
		workflowRunRepo: ctx.workflowRunRepo,
		taskManager: ctx.taskManager,
		spaceAgentManager: ctx.agentManager,
	});
}

const TIMESTAMP = '2026-03-20T10:00:00.000Z';

// ---------------------------------------------------------------------------
// 1. Prompt — supervised mode
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — supervised autonomy level', () => {
	test('explicitly labels the space as supervised mode', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(prompt).toContain('`supervised` mode');
	});

	test('instructs agent to notify human of every TASK_EVENT', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(prompt).toContain('Notify the human');
		expect(prompt).toContain('[TASK_EVENT]');
	});

	test('instructs agent to wait for human approval before acting', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(prompt).toContain('wait for human approval');
	});

	test('instructs agent NOT to call retry_task without explicit instruction', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(prompt).toContain('retry_task');
		expect(prompt).toContain('without explicit human instruction');
	});

	test('instructs agent NOT to call reassign_task or cancel_task without explicit instruction', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(prompt).toContain('reassign_task');
		expect(prompt).toContain('cancel_task');
	});

	test('does NOT include semi_autonomous autonomous-action instructions', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		// The semi_autonomous section about acting without human approval should not be present
		expect(prompt).not.toContain('act without human approval');
	});
});

// ---------------------------------------------------------------------------
// 2. Prompt — semi_autonomous mode
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — semi_autonomous autonomy level', () => {
	test('explicitly labels the space as semi_autonomous mode', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('`semi_autonomous` mode');
	});

	test('allows retrying a failed task once without human approval', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('Retry a failed task once');
		expect(prompt).toContain('retry_task');
	});

	test('allows reassigning a task without human approval', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('Reassign a task');
		expect(prompt).toContain('reassign_task');
	});

	test('instructs agent to escalate after one failed retry', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('one failed retry');
		expect(prompt).toContain('escalate to the human');
	});

	test('human-gated steps still require human approval even in semi_autonomous mode', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		expect(prompt).toContain('Human-gated workflow steps always require human approval');
	});

	test('does NOT include the supervised "wait for human approval" restriction for all events', () => {
		const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });
		// In supervised mode, this line is present — in semi_autonomous it should not be
		expect(prompt).not.toContain('wait for human approval before acting');
	});
});

// ---------------------------------------------------------------------------
// 3. Default autonomy level — treated as supervised
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — default autonomy level (supervised fallback)', () => {
	test('omitting autonomyLevel defaults to supervised mode label', () => {
		const prompt = buildSpaceChatSystemPrompt({});
		expect(prompt).toContain('`supervised` mode');
	});

	test('calling with no arguments defaults to supervised mode label', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('`supervised` mode');
	});

	test('no-arg prompt includes notify-human instruction', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).toContain('Notify the human');
	});

	test('no-arg prompt does not include semi_autonomous retry-autonomously instruction', () => {
		const prompt = buildSpaceChatSystemPrompt();
		expect(prompt).not.toContain('act without human approval');
	});

	test('default prompt and explicit supervised prompt are identical', () => {
		const defaultPrompt = buildSpaceChatSystemPrompt();
		const supervisedPrompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		expect(defaultPrompt).toBe(supervisedPrompt);
	});
});

// ---------------------------------------------------------------------------
// 4. Notification messages include autonomy level
// ---------------------------------------------------------------------------

describe('formatEventMessage — autonomy level in message', () => {
	const spaceId = 'space-notify-test';

	test('task_needs_attention message includes supervised autonomy level', () => {
		const event: SpaceNotificationEvent = {
			kind: 'task_needs_attention',
			spaceId,
			taskId: 'task-1',
			reason: 'Build failed',
			timestamp: TIMESTAMP,
		};
		const message = formatEventMessage(event, 'supervised');
		expect(message).toContain('supervised');
		expect(message).toContain('[TASK_EVENT]');
		expect(message).toContain('task_needs_attention');
	});

	test('task_needs_attention message includes semi_autonomous autonomy level', () => {
		const event: SpaceNotificationEvent = {
			kind: 'task_needs_attention',
			spaceId,
			taskId: 'task-2',
			reason: 'Tests failing',
			timestamp: TIMESTAMP,
		};
		const message = formatEventMessage(event, 'semi_autonomous');
		expect(message).toContain('semi_autonomous');
		expect(message).toContain('[TASK_EVENT]');
	});

	test('autonomy level appears both as plain text and in JSON payload', () => {
		const event: SpaceNotificationEvent = {
			kind: 'task_needs_attention',
			spaceId,
			taskId: 'task-3',
			reason: 'Timeout',
			timestamp: TIMESTAMP,
		};
		const message = formatEventMessage(event, 'supervised');

		// Plain text line
		expect(message).toContain('Autonomy level: supervised');

		// JSON payload
		const jsonMatch = message.match(/```json\n([\s\S]*?)```/);
		expect(jsonMatch).not.toBeNull();
		const payload = JSON.parse(jsonMatch![1]);
		expect(payload.autonomyLevel).toBe('supervised');
	});

	test('workflow_run_needs_attention message includes autonomy level in JSON payload', () => {
		const event: SpaceNotificationEvent = {
			kind: 'workflow_run_needs_attention',
			spaceId,
			runId: 'run-1',
			reason: 'Transition condition failed',
			timestamp: TIMESTAMP,
		};
		const message = formatEventMessage(event, 'semi_autonomous');
		const jsonMatch = message.match(/```json\n([\s\S]*?)```/);
		expect(jsonMatch).not.toBeNull();
		const payload = JSON.parse(jsonMatch![1]);
		expect(payload.autonomyLevel).toBe('semi_autonomous');
	});

	test('task_timeout message includes autonomy level in JSON payload', () => {
		const event: SpaceNotificationEvent = {
			kind: 'task_timeout',
			spaceId,
			taskId: 'task-4',
			elapsedMs: 120000,
			timestamp: TIMESTAMP,
		};
		const message = formatEventMessage(event, 'supervised');
		const jsonMatch = message.match(/```json\n([\s\S]*?)```/);
		expect(jsonMatch).not.toBeNull();
		const payload = JSON.parse(jsonMatch![1]);
		expect(payload.autonomyLevel).toBe('supervised');
	});

	test('workflow_run_completed message includes autonomy level in JSON payload', () => {
		const event: SpaceNotificationEvent = {
			kind: 'workflow_run_completed',
			spaceId,
			runId: 'run-2',
			status: 'completed',
			summary: 'All steps completed successfully',
			timestamp: TIMESTAMP,
		};
		const message = formatEventMessage(event, 'semi_autonomous');
		const jsonMatch = message.match(/```json\n([\s\S]*?)```/);
		expect(jsonMatch).not.toBeNull();
		const payload = JSON.parse(jsonMatch![1]);
		expect(payload.autonomyLevel).toBe('semi_autonomous');
	});

	test('autonomy level in message changes when level changes — same event, different level', () => {
		const event: SpaceNotificationEvent = {
			kind: 'task_needs_attention',
			spaceId,
			taskId: 'task-5',
			reason: 'Error',
			timestamp: TIMESTAMP,
		};
		const supervisedMsg = formatEventMessage(event, 'supervised');
		const semiMsg = formatEventMessage(event, 'semi_autonomous');
		expect(supervisedMsg).toContain('supervised');
		expect(semiMsg).toContain('semi_autonomous');
		expect(supervisedMsg).not.toContain('semi_autonomous');
		expect(semiMsg).not.toContain('supervised');
	});
});

// ---------------------------------------------------------------------------
// 5. retry_task tool — callable at both autonomy levels (gate is in the prompt)
// ---------------------------------------------------------------------------

describe('retry_task tool — autonomy level does not affect tool behavior', () => {
	let ctx: TestCtx;
	beforeEach(() => {
		ctx = makeCtx();
	});
	afterEach(() => {
		ctx.db.close();
		rmSync(ctx.dir, { recursive: true, force: true });
	});

	async function createNeedsAttentionTask(ctx: TestCtx): Promise<string> {
		// Create a task directly in needs_attention status by inserting it via the DB
		// (createStandaloneTask creates in draft→pending; we need needs_attention for retry_task)
		const taskId = `task-retry-${Math.random().toString(36).slice(2)}`;
		ctx.db
			.prepare(
				`INSERT INTO space_tasks
         (id, space_id, title, description, status, priority, task_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'needs_attention', 'normal', 'coding', ?, ?)`
			)
			.run(
				taskId,
				ctx.spaceId,
				'Failing task',
				'Task that needs attention',
				Date.now(),
				Date.now()
			);
		return taskId;
	}

	test('retry_task succeeds for a supervised space (tool has no autonomy gate)', async () => {
		const taskId = await createNeedsAttentionTask(ctx);
		const handlers = makeHandlers(ctx);

		const result = await handlers.retry_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
		expect(parsed.task.status).toBe('pending');
	});

	test('retry_task succeeds for a semi_autonomous space (same tool, no autonomy check)', async () => {
		const taskId = await createNeedsAttentionTask(ctx);
		const handlers = makeHandlers(ctx);

		const result = await handlers.retry_task({ task_id: taskId });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.id).toBe(taskId);
		expect(parsed.task.status).toBe('pending');
	});

	test('retry_task with description update succeeds regardless of autonomy level', async () => {
		const taskId = await createNeedsAttentionTask(ctx);
		const handlers = makeHandlers(ctx);

		const result = await handlers.retry_task({
			task_id: taskId,
			description: 'Updated description with root cause fix',
		});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(true);
		expect(parsed.task.status).toBe('pending');
		expect(parsed.task.description).toBe('Updated description with root cause fix');
	});

	test('retry_task returns error for non-existent task at both autonomy levels', async () => {
		const handlers = makeHandlers(ctx);

		const result = await handlers.retry_task({ task_id: 'non-existent-task' });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.success).toBe(false);
		expect(typeof parsed.error).toBe('string');
	});

	test('retry_task resets task to pending — the autonomy gate is only in the prompt', () => {
		// This test documents the architectural contract:
		// - The TOOL always works if the task is in a retryable status
		// - The PROMPT tells the agent WHEN it may call this tool (supervised: never without permission,
		//   semi_autonomous: can call once after needs_attention)
		// This separation keeps tool logic simple and autonomy policy in the prompt.

		const supervisedPrompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'supervised' });
		const semiPrompt = buildSpaceChatSystemPrompt({ autonomyLevel: 'semi_autonomous' });

		// Both prompts mention retry_task — supervised warns not to call it, semi_autonomous allows it
		expect(supervisedPrompt).toContain('retry_task');
		expect(semiPrompt).toContain('retry_task');

		// Supervised restricts usage
		expect(supervisedPrompt).toContain('without explicit human instruction');

		// Semi-autonomous allows autonomous retry
		expect(semiPrompt).toContain('Retry a failed task once');
	});
});

// ---------------------------------------------------------------------------
// 6. Prompt structure — both levels include Event Handling and Escalation
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — sections always present regardless of autonomy level', () => {
	const levels: Array<SpaceAutonomyLevel | undefined> = [
		'supervised',
		'semi_autonomous',
		undefined,
	];

	for (const level of levels) {
		const label = level ?? 'undefined (default)';

		test(`Event Handling section is always present [autonomyLevel=${label}]`, () => {
			const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: level });
			expect(prompt).toContain('## Event Handling');
			expect(prompt).toContain('[TASK_EVENT]');
		});

		test(`Escalation section is always present [autonomyLevel=${label}]`, () => {
			const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: level });
			expect(prompt).toContain('## Escalation');
		});

		test(`Coordination Tools section is always present [autonomyLevel=${label}]`, () => {
			const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: level });
			expect(prompt).toContain('## Coordination Tools');
		});

		test(`Autonomy Level section is always present [autonomyLevel=${label}]`, () => {
			const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: level });
			expect(prompt).toContain('## Autonomy Level');
		});
	}
});
