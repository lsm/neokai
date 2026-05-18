import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceActorRegistryAdapter } from '../../../src/lib/space/actor-registry';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository';
import { PendingAgentMessageRepository } from '../../../src/storage/repositories/pending-agent-message-repository';
import { SessionRepository } from '../../../src/storage/repositories/session-repository';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import type { Session } from '@neokai/shared';
import { createSpaceTables } from '../helpers/space-test-db';

function alignTestSchema(db: Database): void {
	db.exec('ALTER TABLE space_agents ADD COLUMN custom_prompt TEXT DEFAULT NULL');
	db.exec('DROP TABLE sessions');
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			workspace_path TEXT,
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
			config TEXT NOT NULL,
			metadata TEXT NOT NULL,
			is_worktree INTEGER DEFAULT 0,
			worktree_path TEXT,
			main_repo_path TEXT,
			worktree_branch TEXT,
			git_branch TEXT,
			sdk_session_id TEXT,
			sdk_origin_path TEXT,
			available_commands TEXT,
			processing_state TEXT,
			archived_at TEXT,
			type TEXT DEFAULT 'worker',
			session_context TEXT
		)
	`);
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
	return {
		id,
		title: id,
		workspacePath: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		lastActiveAt: '2026-01-01T00:00:00.000Z',
		status: 'active',
		config: {},
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
		type: 'worker',
		context: undefined,
		...overrides,
	};
}

describe('SpaceActorRegistryAdapter', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let sessionRepo: SessionRepository;
	let spaceAgentRepo: SpaceAgentRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let pendingMessageRepo: PendingAgentMessageRepository;
	let registry: SpaceActorRegistryAdapter;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		alignTestSchema(db);
		spaceRepo = new SpaceRepository(db);
		sessionRepo = new SessionRepository(db);
		spaceAgentRepo = new SpaceAgentRepository(db);
		workflowRepo = new SpaceWorkflowRepository(db);
		workflowRunRepo = new SpaceWorkflowRunRepository(db);
		nodeExecutionRepo = new NodeExecutionRepository(db);
		pendingMessageRepo = new PendingAgentMessageRepository(db);
		registry = new SpaceActorRegistryAdapter({
			spaceRepo,
			sessionRepo,
			spaceAgentRepo,
			workflowRunRepo,
			nodeExecutionRepo,
			pendingMessageRepo,
		});
	});

	afterEach(() => {
		db.close();
	});

	it('seeds humans, coordinator, ad-hoc sessions, agents, workers, pending workers, and systems', () => {
		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/project',
			slug: 'project',
			name: 'Project',
		});
		const member = makeSession('member-1', { context: { spaceId: space.id } });
		const coordinator = makeSession(`space:chat:${space.id}`, {
			type: 'space_chat',
			context: { spaceId: space.id },
		});
		const taskAgent = makeSession('task-agent-1', {
			type: 'space_task_agent',
			context: { spaceId: space.id },
		});
		const workerSubSession = makeSession('space:task:t1:exec:e1', {
			context: { spaceId: space.id },
		});
		sessionRepo.createSession(member);
		sessionRepo.createSession(coordinator);
		sessionRepo.createSession(taskAgent);
		sessionRepo.createSession(workerSubSession);
		spaceRepo.addSessionToSpace(space.id, member.id);
		spaceRepo.addSessionToSpace(space.id, coordinator.id);
		spaceRepo.addSessionToSpace(space.id, taskAgent.id);
		spaceRepo.addSessionToSpace(space.id, workerSubSession.id);

		const agent = spaceAgentRepo.create({
			spaceId: space.id,
			name: 'Long Term Agent',
		});
		const workflow = workflowRepo.createWorkflow({
			spaceId: space.id,
			name: 'Coding Workflow',
			nodes: [],
			transitions: [],
			startNodeId: 'Coding',
			rules: [],
			completionAutonomyLevel: 3,
		});
		const run = workflowRunRepo.createRun({
			spaceId: space.id,
			workflowId: workflow.id,
			title: 'Run',
		});
		nodeExecutionRepo.create({
			workflowRunId: run.id,
			workflowNodeId: 'Coding',
			agentName: 'coder',
			agentId: agent.id,
			agentSessionId: workerSubSession.id,
			status: 'in_progress',
		});
		pendingMessageRepo.enqueue({
			workflowRunId: run.id,
			spaceId: space.id,
			targetKind: 'node_agent',
			targetAgentName: 'reviewer',
			message: 'review this',
		});

		const actors = registry.listActors(space.id);

		expect(actors).toContainEqual({
			actorId: `human:${member.id}`,
			kind: 'human',
			spaceId: space.id,
			handle: `@human:${member.id}`,
			roles: ['member'],
			status: 'active',
		});
		expect(actors).toContainEqual({
			actorId: `session:${member.id}`,
			kind: 'session',
			spaceId: space.id,
			handle: `@session:${member.id}`,
			roles: ['member-session'],
			status: 'active',
		});
		expect(actors).toContainEqual({
			actorId: `agent:coordinator:${space.id}`,
			kind: 'agent',
			spaceId: space.id,
			handle: '@coordinator',
			roles: ['coordinator', 'space-agent'],
			status: 'active',
		});
		expect(actors).toContainEqual({
			actorId: `agent:${agent.id}`,
			kind: 'agent',
			spaceId: space.id,
			handle: '@long-term-agent',
			roles: ['long-term-agent', 'space-agent'],
			status: 'active',
		});
		expect(actors).toContainEqual({
			actorId: `worker:${run.id}:Coding:coder`,
			kind: 'worker',
			spaceId: space.id,
			handle: `@worker:${run.id}/Coding/coder`,
			roles: ['Coding', 'coder'],
			status: 'active',
		});
		expect(actors).toContainEqual({
			actorId: `worker:${run.id}:reviewer:reviewer`,
			kind: 'worker',
			spaceId: space.id,
			handle: `@worker:${run.id}/reviewer/reviewer`,
			roles: ['reviewer'],
			status: 'inactive',
		});
		expect(actors).toContainEqual({
			actorId: 'system:runtime',
			kind: 'system',
			spaceId: space.id,
			handle: '@system:runtime',
			roles: ['runtime'],
			status: 'active',
		});
		expect(actors.some((actor) => actor.actorId === `session:${coordinator.id}`)).toBe(false);
		expect(actors.some((actor) => actor.actorId === `session:${taskAgent.id}`)).toBe(false);
		expect(actors.some((actor) => actor.actorId === `session:${workerSubSession.id}`)).toBe(false);
	});

	it('returns inactive coordinator when no space chat session exists', () => {
		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/project',
			slug: 'project',
			name: 'Project',
		});

		expect(registry.getActor(space.id, `agent:coordinator:${space.id}`)).toEqual({
			actorId: `agent:coordinator:${space.id}`,
			kind: 'agent',
			spaceId: space.id,
			handle: '@coordinator',
			roles: ['coordinator', 'space-agent'],
			status: 'inactive',
		});
	});
});
