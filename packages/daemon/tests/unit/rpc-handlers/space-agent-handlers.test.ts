/**
 * Space Agent RPC Handlers Unit Tests
 *
 * Tests for CRUD RPC handlers:
 * - spaceAgent.create
 * - spaceAgent.list
 * - spaceAgent.get
 * - spaceAgent.update
 * - spaceAgent.delete
 *
 * Uses in-memory SQLite to exercise the real SpaceAgentManager and
 * SpaceAgentRepository, so the full business-logic path is covered.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { MessageHub } from '@neokai/shared';
import { setupSpaceAgentHandlers } from '../../../src/lib/rpc-handlers/space-agent-handlers';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import { setModelsCache } from '../../../src/lib/model-service';
import {
	createSpaceAgentSchema,
	insertSpace,
	insertWorkflow,
	insertWorkflowStep,
} from '../helpers/space-agent-schema';

// ─── minimal mock types ────────────────────────────────────────────────────

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockDaemonHub(): { daemonHub: DaemonHub; emitMock: ReturnType<typeof mock> } {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
	return { daemonHub, emitMock };
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** Call a registered handler and cast the result */
async function call<T>(
	handlers: Map<string, RequestHandler>,
	method: string,
	params: unknown
): Promise<T> {
	const handler = handlers.get(method);
	if (!handler) throw new Error(`Handler not registered: ${method}`);
	return (await handler(params, {})) as T;
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('Space Agent RPC Handlers', () => {
	let db: Database;
	let manager: SpaceAgentManager;
	let hubData: ReturnType<typeof createMockMessageHub>;
	let daemonData: ReturnType<typeof createMockDaemonHub>;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceAgentSchema(db);
		insertSpace(db, 'space-1');

		const repo = new SpaceAgentRepository(db as any);
		manager = new SpaceAgentManager(repo);
		hubData = createMockMessageHub();
		daemonData = createMockDaemonHub();

		// Disable model validation (no models in cache)
		setModelsCache(new Map());

		setupSpaceAgentHandlers(hubData.hub, daemonData.daemonHub, manager);
	});

	afterEach(() => {
		db.close();
		setModelsCache(new Map());
		mock.restore();
	});

	// ── spaceAgent.create ────────────────────────────────────────────────────

	describe('spaceAgent.create', () => {
		it('registers the handler', () => {
			expect(hubData.handlers.has('spaceAgent.create')).toBe(true);
		});

		it('creates an agent with required params', async () => {
			const result = await call<{ agent: { id: string; name: string } }>(
				hubData.handlers,
				'spaceAgent.create',
				{ spaceId: 'space-1', name: 'MyAgent', role: 'coder' }
			);

			expect(result.agent).toBeDefined();
			expect(result.agent.name).toBe('MyAgent');
		});

		it('creates an agent with all optional params', async () => {
			const result = await call<{
				agent: {
					name: string;
					description: string;
					model: string | undefined;
					systemPrompt: string;
				};
			}>(hubData.handlers, 'spaceAgent.create', {
				spaceId: 'space-1',
				name: 'FullAgent',
				role: 'planner',
				description: 'A detailed agent',
				model: 'claude-opus-4-5',
				provider: 'anthropic',
				systemPrompt: 'You are helpful.',
			});

			expect(result.agent.name).toBe('FullAgent');
			expect(result.agent.description).toBe('A detailed agent');
			expect(result.agent.systemPrompt).toBe('You are helpful.');
		});

		it('emits spaceAgent.created event after creation', async () => {
			await call(hubData.handlers, 'spaceAgent.create', {
				spaceId: 'space-1',
				name: 'EventAgent',
				role: 'coder',
			});

			// Allow microtask queue to flush
			await new Promise((r) => setTimeout(r, 0));

			expect(daemonData.emitMock).toHaveBeenCalled();
			const [eventName, payload] = daemonData.emitMock.mock.calls[0] as [
				string,
				{ spaceId: string; agent: { name: string } },
			];
			expect(eventName).toBe('spaceAgent.created');
			expect(payload.spaceId).toBe('space-1');
			expect(payload.agent.name).toBe('EventAgent');
		});

		it('throws when spaceId is missing', async () => {
			await expect(
				call(hubData.handlers, 'spaceAgent.create', { name: 'A', role: 'coder' })
			).rejects.toThrow('spaceId is required');
		});

		it('throws when name is missing', async () => {
			await expect(
				call(hubData.handlers, 'spaceAgent.create', { spaceId: 'space-1', role: 'coder' })
			).rejects.toThrow('name is required');
		});

		it('throws when role is missing', async () => {
			await expect(
				call(hubData.handlers, 'spaceAgent.create', { spaceId: 'space-1', name: 'A' })
			).rejects.toThrow('role is required');
		});

		it('throws for an invalid role value', async () => {
			await expect(
				call(hubData.handlers, 'spaceAgent.create', {
					spaceId: 'space-1',
					name: 'A',
					role: 'leader',
				})
			).rejects.toThrow('Invalid role: "leader"');
		});

		it('accepts all valid role values', async () => {
			for (const role of ['planner', 'coder', 'general'] as const) {
				const result = await call<{ agent: { role: string } }>(
					hubData.handlers,
					'spaceAgent.create',
					{ spaceId: 'space-1', name: `Agent-${role}`, role }
				);
				expect(result.agent.role).toBe(role);
			}
		});

		it('throws on duplicate name within the same space', async () => {
			await call(hubData.handlers, 'spaceAgent.create', {
				spaceId: 'space-1',
				name: 'Duplicate',
				role: 'coder',
			});

			await expect(
				call(hubData.handlers, 'spaceAgent.create', {
					spaceId: 'space-1',
					name: 'Duplicate',
					role: 'coder',
				})
			).rejects.toThrow('"Duplicate" already exists');
		});
	});

	// ── spaceAgent.list ──────────────────────────────────────────────────────

	describe('spaceAgent.list', () => {
		it('registers the handler', () => {
			expect(hubData.handlers.has('spaceAgent.list')).toBe(true);
		});

		it('returns empty array for a space with no agents', async () => {
			const result = await call<{ agents: unknown[] }>(hubData.handlers, 'spaceAgent.list', {
				spaceId: 'space-1',
			});
			expect(result.agents).toEqual([]);
		});

		it('returns all agents for a space', async () => {
			await call(hubData.handlers, 'spaceAgent.create', {
				spaceId: 'space-1',
				name: 'Alpha',
				role: 'coder',
			});
			await call(hubData.handlers, 'spaceAgent.create', {
				spaceId: 'space-1',
				name: 'Beta',
				role: 'planner',
			});

			const result = await call<{ agents: { name: string }[] }>(
				hubData.handlers,
				'spaceAgent.list',
				{ spaceId: 'space-1' }
			);
			expect(result.agents).toHaveLength(2);
			const names = result.agents.map((a) => a.name).sort();
			expect(names).toEqual(['Alpha', 'Beta']);
		});

		it('throws when spaceId is missing', async () => {
			await expect(call(hubData.handlers, 'spaceAgent.list', {})).rejects.toThrow(
				'spaceId is required'
			);
		});
	});

	// ── spaceAgent.get ───────────────────────────────────────────────────────

	describe('spaceAgent.get', () => {
		it('registers the handler', () => {
			expect(hubData.handlers.has('spaceAgent.get')).toBe(true);
		});

		it('returns the agent by id', async () => {
			const created = await call<{ agent: { id: string; name: string } }>(
				hubData.handlers,
				'spaceAgent.create',
				{ spaceId: 'space-1', name: 'GetMe', role: 'coder' }
			);

			const result = await call<{ agent: { id: string; name: string } }>(
				hubData.handlers,
				'spaceAgent.get',
				{ id: created.agent.id }
			);
			expect(result.agent.id).toBe(created.agent.id);
			expect(result.agent.name).toBe('GetMe');
		});

		it('throws when id is missing', async () => {
			await expect(call(hubData.handlers, 'spaceAgent.get', {})).rejects.toThrow('id is required');
		});

		it('throws when agent does not exist', async () => {
			await expect(
				call(hubData.handlers, 'spaceAgent.get', { id: 'nonexistent-id' })
			).rejects.toThrow('Agent not found');
		});
	});

	// ── spaceAgent.update ────────────────────────────────────────────────────

	describe('spaceAgent.update', () => {
		let agentId: string;

		beforeEach(async () => {
			const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
				spaceId: 'space-1',
				name: 'Original',
				role: 'coder',
			});
			agentId = created.agent.id;
			daemonData.emitMock.mockClear();
		});

		it('registers the handler', () => {
			expect(hubData.handlers.has('spaceAgent.update')).toBe(true);
		});

		it('updates the agent name', async () => {
			const result = await call<{ agent: { name: string } }>(
				hubData.handlers,
				'spaceAgent.update',
				{ id: agentId, name: 'Renamed' }
			);
			expect(result.agent.name).toBe('Renamed');
		});

		it('updates description and systemPrompt', async () => {
			const result = await call<{
				agent: { description: string; systemPrompt: string };
			}>(hubData.handlers, 'spaceAgent.update', {
				id: agentId,
				description: 'New desc',
				systemPrompt: 'New prompt',
			});
			expect(result.agent.description).toBe('New desc');
			expect(result.agent.systemPrompt).toBe('New prompt');
		});

		it('emits spaceAgent.updated event', async () => {
			await call(hubData.handlers, 'spaceAgent.update', { id: agentId, name: 'Updated' });
			await new Promise((r) => setTimeout(r, 0));

			expect(daemonData.emitMock).toHaveBeenCalled();
			const [eventName] = daemonData.emitMock.mock.calls[0] as [string, unknown];
			expect(eventName).toBe('spaceAgent.updated');
		});

		it('throws when id is missing', async () => {
			await expect(call(hubData.handlers, 'spaceAgent.update', { name: 'X' })).rejects.toThrow(
				'id is required'
			);
		});

		it('throws when agent does not exist', async () => {
			await expect(
				call(hubData.handlers, 'spaceAgent.update', { id: 'bad-id', name: 'X' })
			).rejects.toThrow('Agent not found');
		});

		it('throws on duplicate name conflict', async () => {
			await call(hubData.handlers, 'spaceAgent.create', {
				spaceId: 'space-1',
				name: 'OtherAgent',
				role: 'coder',
			});

			await expect(
				call(hubData.handlers, 'spaceAgent.update', { id: agentId, name: 'OtherAgent' })
			).rejects.toThrow('already exists');
		});

		it('throws for an invalid role value', async () => {
			await expect(
				call(hubData.handlers, 'spaceAgent.update', { id: agentId, role: 'admin' })
			).rejects.toThrow('Invalid role: "admin"');
		});
	});

	// ── spaceAgent.delete ────────────────────────────────────────────────────

	describe('spaceAgent.delete', () => {
		let agentId: string;

		beforeEach(async () => {
			const created = await call<{ agent: { id: string } }>(hubData.handlers, 'spaceAgent.create', {
				spaceId: 'space-1',
				name: 'ToDelete',
				role: 'coder',
			});
			agentId = created.agent.id;
			daemonData.emitMock.mockClear();
		});

		it('registers the handler', () => {
			expect(hubData.handlers.has('spaceAgent.delete')).toBe(true);
		});

		it('deletes the agent and returns success', async () => {
			const result = await call<{ success: boolean }>(hubData.handlers, 'spaceAgent.delete', {
				id: agentId,
			});
			expect(result.success).toBe(true);
		});

		it('emits spaceAgent.deleted event', async () => {
			await call(hubData.handlers, 'spaceAgent.delete', { id: agentId });
			await new Promise((r) => setTimeout(r, 0));

			expect(daemonData.emitMock).toHaveBeenCalled();
			const [eventName, payload] = daemonData.emitMock.mock.calls[0] as [
				string,
				{ agentId: string },
			];
			expect(eventName).toBe('spaceAgent.deleted');
			expect(payload.agentId).toBe(agentId);
		});

		it('throws when id is missing', async () => {
			await expect(call(hubData.handlers, 'spaceAgent.delete', {})).rejects.toThrow(
				'id is required'
			);
		});

		it('throws when agent does not exist', async () => {
			await expect(call(hubData.handlers, 'spaceAgent.delete', { id: 'ghost-id' })).rejects.toThrow(
				'Agent not found'
			);
		});

		it('throws clear error when agent is referenced by a workflow step', async () => {
			insertWorkflow(db, 'wf-1', 'space-1', 'My Workflow');
			insertWorkflowStep(db, 'step-1', 'wf-1', agentId);

			await expect(call(hubData.handlers, 'spaceAgent.delete', { id: agentId })).rejects.toThrow(
				/Cannot delete agent.*referenced by workflow steps/
			);
		});

		it('throws and includes workflow names in error when referenced', async () => {
			insertWorkflow(db, 'wf-2', 'space-1', 'Important Workflow');
			insertWorkflowStep(db, 'step-2', 'wf-2', agentId);

			await expect(call(hubData.handlers, 'spaceAgent.delete', { id: agentId })).rejects.toThrow(
				'Important Workflow'
			);
		});

		it('allows deletion after the step reference is removed', async () => {
			insertWorkflow(db, 'wf-3', 'space-1', 'Temp Workflow');
			insertWorkflowStep(db, 'step-3', 'wf-3', agentId);

			// Remove the step reference by setting agent_id to NULL
			db.prepare(`UPDATE space_workflow_steps SET agent_id = NULL WHERE id = 'step-3'`).run();

			const result = await call<{ success: boolean }>(hubData.handlers, 'spaceAgent.delete', {
				id: agentId,
			});
			expect(result.success).toBe(true);
		});
	});
});
