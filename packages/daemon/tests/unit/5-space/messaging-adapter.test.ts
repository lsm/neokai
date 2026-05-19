import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	SpaceDeliveryFacade,
	SpaceMessageResolver,
	pendingMessageToDeliveryRecords,
	pendingMessageToMessageRecord,
} from '../../../src/lib/space/messaging-adapter';
import { SpaceActorRegistryAdapter } from '../../../src/lib/space/actor-registry';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository';
import { PendingAgentMessageRepository } from '../../../src/storage/repositories/pending-agent-message-repository';
import { SessionRepository } from '../../../src/storage/repositories/session-repository';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import type { MessageRecord } from '../../../../messaging/src/types';
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

describe('Space messaging adapter', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let sessionRepo: SessionRepository;
	let spaceAgentRepo: SpaceAgentRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let workflowRunRepo: SpaceWorkflowRunRepository;
	let nodeExecutionRepo: NodeExecutionRepository;
	let pendingMessageRepo: PendingAgentMessageRepository;
	let registry: SpaceActorRegistryAdapter;
	let spaceId: string;
	let runId: string;
	let message: MessageRecord;

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
			workflowRepo,
			workflowRunRepo,
			nodeExecutionRepo,
			pendingMessageRepo,
		});

		const space = spaceRepo.createSpace({
			workspacePath: '/workspace/project',
			slug: 'project',
			name: 'Project',
		});
		spaceId = space.id;
		const agent = spaceAgentRepo.create({ spaceId, name: 'Worker Agent' });
		const workflow = workflowRepo.createWorkflow({
			spaceId,
			name: 'Coding Workflow',
			nodes: [
				{ id: 'Coding', name: 'Coding', agents: [{ agentId: agent.id, name: 'coder' }] },
				{ id: 'Review', name: 'Review', agents: [{ agentId: agent.id, name: 'reviewer' }] },
				{ id: 'QA', name: 'QA', agents: [{ agentId: agent.id, name: 'reviewer' }] },
			],
			channels: [{ from: 'Coding', to: ['Review', 'QA'] }],
			transitions: [],
			startNodeId: 'Coding',
			rules: [],
			completionAutonomyLevel: 3,
		});
		const run = workflowRunRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Run' });
		runId = run.id;
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'Coding',
			agentName: 'coder',
			agentId: agent.id,
			agentSessionId: 'coding-session',
			status: 'in_progress',
		});
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'Review',
			agentName: 'reviewer',
			agentId: agent.id,
			agentSessionId: 'review-session',
			status: 'in_progress',
		});
		nodeExecutionRepo.create({
			workflowRunId: runId,
			workflowNodeId: 'QA',
			agentName: 'reviewer',
			agentId: agent.id,
			agentSessionId: null,
			status: 'pending',
		});
		message = {
			messageId: 'msg-1',
			spaceId,
			senderActorId: `worker:${encodeURIComponent(runId)}:Coding:coder`,
			targets: [],
			body: 'hello',
			kind: 'message',
			workflowRunId: runId,
			createdAt: 1,
		};
	});

	afterEach(() => {
		db.close();
	});

	it('resolves handles, role fan-out, sessions, and workers deterministically', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'Coding', agentName: 'coder' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@coordinator', '@role:reviewer', '@worker:Review/reviewer'],
		});

		expect(result.unresolved).toEqual([]);
		expect(result.resolved.map((target) => target.actor.actorId)).toEqual([
			`agent:coordinator:${spaceId}`,
			`worker:${encodeURIComponent(runId)}:Review:reviewer`,
			`worker:${encodeURIComponent(runId)}:Review:reviewer`,
		]);
	});

	it('errors instead of falling back for stale handles and forbidden worker topology', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'Review', agentName: 'reviewer' }
		);
		const result = await resolver.resolveTargets({
			...message,
			targets: ['@coordiantor', '@worker:QA/reviewer'],
		});

		expect(result.resolved).toEqual([]);
		expect(result.unresolved.map((target) => target.reason)).toEqual([
			'No routable actor found for handle @coordiantor',
			'Channel topology does not permit worker target @worker:QA/reviewer',
		]);
	});

	it('writes queued deliveries for inactive actors and failed rows for unresolved targets', async () => {
		const resolver = new SpaceMessageResolver(
			{ actorRegistry: registry, workflowRepo, workflowRunRepo },
			{ spaceId, workflowRunId: runId, nodeId: 'Coding', agentName: 'coder' }
		);
		const facade = new SpaceDeliveryFacade({ resolver });
		const result = await facade.routeMessage({
			...message,
			targets: ['@worker:QA/reviewer', '@missing'],
		});

		expect(result.deliveries).toHaveLength(2);
		expect(result.deliveries[0]).toMatchObject({
			targetActorId: `worker:${encodeURIComponent(runId)}:QA:reviewer`,
			targetRef: '@worker:QA/reviewer',
			state: 'queued',
		});
		expect(result.deliveries[1]).toMatchObject({
			targetRef: '@missing',
			state: 'failed',
			lastError: 'No routable actor found for handle @missing',
		});
	});

	it('maps pending_agent_messages rows into message and delivery facade records', () => {
		const pending = pendingMessageRepo.enqueue({
			workflowRunId: runId,
			spaceId,
			taskId: 'task-1',
			sourceAgentName: 'coder',
			targetKind: 'node_agent',
			targetAgentName: 'reviewer',
			message: 'queued review',
			idempotencyKey: 'idem-1',
		}).record;

		const mappedMessage = pendingMessageToMessageRecord(pending);
		const deliveries = pendingMessageToDeliveryRecords(pending, registry.listActors(spaceId));

		expect(mappedMessage).toMatchObject({
			messageId: `msg_legacy_${pending.id}`,
			spaceId,
			targets: ['reviewer'],
			body: 'queued review',
			workflowRunId: runId,
			taskId: 'task-1',
			idempotencyKey: 'idem-1',
		});
		expect(deliveries.map((delivery) => delivery.targetActorId)).toEqual([
			`worker:${encodeURIComponent(runId)}:QA:reviewer`,
			`worker:${encodeURIComponent(runId)}:Review:reviewer`,
		]);
		expect(deliveries.every((delivery) => delivery.state === 'queued')).toBe(true);
	});
});
