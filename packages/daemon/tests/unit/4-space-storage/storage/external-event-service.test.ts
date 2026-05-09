/**
 * ExternalEventService Unit Tests
 *
 * Covers:
 *   - publish: new event → stored, enriched, bus published
 *   - publish: terminal duplicate → short-circuits
 *   - publish: retryable duplicate → returns retryable_duplicate, re-emits bus
 *   - publish: enriched routedTaskId returned and persisted
 *   - publish: ambiguous/unknown task resolution → ignored
 *   - publish: ignored resolution (no PR number) → non-terminal
 *   - bus payload carries space-scoped sessionId
 *   - no session injection in service or resolver
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSpaceTables } from '../../helpers/space-test-db';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import {
	ExternalEventService,
	type ExternalEventPublishedPayload,
} from '../../../../src/lib/external-events/external-event-service';
import {
	GitHubExternalEventTaskResolver,
	type ExternalEventTaskResolver,
	type TaskResolution,
} from '../../../../src/lib/external-events/external-event-task-resolver';
import {
	createInternalEventBus,
	type InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';

let db: Database;
let store: ExternalEventStore;
let taskRepo: SpaceTaskRepository;
let resolver: ExternalEventTaskResolver;
let bus: InternalEventBus<{
	'externalEvent.published': ExternalEventPublishedPayload;
}>;
let service: ExternalEventService;

const SPACE_ID = 'sp-evt-svc';

function freshDb(): Database {
	const d = new Database(':memory:');
	createSpaceTables(d);
	const now = Date.now();
	d.exec(
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('${SPACE_ID}', '${SPACE_ID}', '/tmp/test', 'Test Space', ${now}, ${now})`
	);
	return d;
}

function makeEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
	return {
		id: `evt-${Math.random().toString(36).slice(2, 8)}`,
		spaceId: SPACE_ID,
		source: 'github',
		topic: 'github/lsm/neokai/pull_request.review_submitted',
		occurredAt: 1_700_000_000_000,
		ingestedAt: 1_700_000_001_000,
		dedupeKey: `dk-${Math.random().toString(36).slice(2, 8)}`,
		summary: 'PR review submitted',
		payload: { action: 'review_submitted' },
		prNumber: 42,
		repoOwner: 'lsm',
		repoName: 'neokai',
		...overrides,
	};
}

beforeEach(() => {
	db = freshDb();
	store = new ExternalEventStore(db);
	taskRepo = new SpaceTaskRepository(db);
	resolver = new GitHubExternalEventTaskResolver({ taskRepo });
	bus = createInternalEventBus<{
		'externalEvent.published': ExternalEventPublishedPayload;
	}>();
	service = new ExternalEventService(store, resolver, bus);
});

// ---------------------------------------------------------------------------
// New event
// ---------------------------------------------------------------------------

describe('publish — new event', () => {
	test('stores event, enriches, publishes bus event, returns published', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'test-sub' }
		);

		// Seed a matching open task
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'open',
		});

		const event = makeEvent();
		const result = await service.publish(event);

		expect(result.outcome).toBe('published');
		expect(result.eventId).toBe(event.id);
		expect(result.routedTaskId).toBeDefined();

		// Bus fired
		expect(busReceived).toHaveLength(1);
		expect(busReceived[0]!.spaceId).toBe(SPACE_ID);
		expect(busReceived[0]!.sessionId).toBe(SPACE_ID);
		expect(busReceived[0]!.eventId).toBe(event.id);
		expect(busReceived[0]!.routedTaskId).toBe(result.routedTaskId);

		// Stored state advanced to routed and routedTaskId persisted
		const rec = store.getById(event.id);
		expect(rec!.state).toBe('routed');
		expect(rec!.event.routedTaskId).toBe(result.routedTaskId);
	});

	test('returns published with routedTaskId when event carries trusted metadata', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'test-sub' }
		);

		const event = makeEvent({ routedTaskId: 'task-trusted-1' });
		const result = await service.publish(event);

		expect(result.outcome).toBe('published');
		expect(result.routedTaskId).toBe('task-trusted-1');
		expect(busReceived[0]!.routedTaskId).toBe('task-trusted-1');

		const rec = store.getById(event.id);
		expect(rec!.event.routedTaskId).toBe('task-trusted-1');
	});
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

describe('publish — duplicates', () => {
	test('terminal duplicate returns duplicate_terminal', async () => {
		const event = makeEvent();
		store.store(event);
		store.markEventIgnored(event.id, 'no_matching_subscriptions');

		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);

		expect(result.outcome).toBe('duplicate_terminal');
		expect(result.eventId).toBe(event.id);
	});

	test('retryable duplicate that gets enriched returns published', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'sub' }
		);

		// First observation: missing PR number means 'ignored' resolution.
		// Event stays in 'published' state (non-terminal) so it can be retried.
		const event = makeEvent({ prNumber: undefined });
		const firstResult = await service.publish(event);
		expect(firstResult.outcome).toBe('ignored');
		expect(store.getById(event.id)!.state).toBe('published');
		expect(busReceived).toHaveLength(1);

		// A task is created later. Retryable duplicate with PR number now enriches.
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'open',
		});
		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);

		expect(result.outcome).toBe('published');
		expect(result.eventId).toBe(event.id);
		expect(result.routedTaskId).toBeDefined();
		expect(busReceived).toHaveLength(2);
	});

	test('retryable duplicate still unresolvable returns retryable_duplicate and re-emits bus', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'sub' }
		);

		// First observation: missing PR number means 'ignored' resolution.
		// Event stays in 'published' state (non-terminal) so it can be retried.
		const event = makeEvent({ prNumber: undefined });
		await service.publish(event);
		expect(busReceived).toHaveLength(1);

		// Retryable duplicate with still no PR number re-emits canonical payload
		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey, prNumber: undefined });
		const result = await service.publish(dup);

		expect(result.outcome).toBe('retryable_duplicate');
		expect(result.eventId).toBe(event.id);
		expect(busReceived).toHaveLength(2);
	});

	test('retryable duplicate after routed state preserves canonical route', async () => {
		const event = makeEvent();
		store.store(event);
		store.setRoutedTaskId(event.id, 'task-canonical');
		store.updateEventState(event.id, 'routed');

		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);

		// Canonical route is preserved — resolver is NOT re-run.
		expect(result.outcome).toBe('retryable_duplicate');
		expect(result.routedTaskId).toBe('task-canonical');
	});

	test('retryable duplicate after delivery_failed preserves canonical route', async () => {
		const event = makeEvent();
		store.store(event);
		store.setRoutedTaskId(event.id, 'task-canonical');
		store.updateEventState(event.id, 'routed');
		store.updateEventState(event.id, 'delivery_failed');

		// Duplicate preserves canonical route — resolver is NOT re-run.
		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);

		expect(result.outcome).toBe('retryable_duplicate');
		expect(result.routedTaskId).toBe('task-canonical');
	});

	test('retryable duplicate enriches without regressing delivery_failed state', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'sub' }
		);

		// First observation: unknown (no matching task yet). State stays published.
		const event = makeEvent();
		await service.publish(event);
		expect(store.getById(event.id)!.state).toBe('published');

		// Router advances to routed, then delivery fails — but NO routedTaskId set
		// (simulating a case where the router set state but enrichment happened later)
		store.updateEventState(event.id, 'routed');
		store.updateEventState(event.id, 'delivery_failed');

		// Task created later. Retryable duplicate enriches.
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'open',
		});
		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);

		expect(result.outcome).toBe('published');
		expect(result.routedTaskId).toBeDefined();
		// State must NOT regress from delivery_failed to routed
		expect(store.getById(event.id)!.state).toBe('delivery_failed');
		// But routedTaskId IS persisted
		expect(store.getById(event.id)!.event.routedTaskId).toBe(result.routedTaskId);
		expect(busReceived).toHaveLength(2);
	});

	test('retryable duplicate with ambiguous resolution terminalizes', async () => {
		const event = makeEvent({ prNumber: undefined });
		await service.publish(event);
		expect(store.getById(event.id)!.state).toBe('published');

		// Two tasks now exist — duplicate resolves to ambiguous
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Work on #42',
			description: 'lsm/neokai',
			status: 'open',
		});
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Also #42',
			description: 'neokai',
			status: 'open',
		});
		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);

		expect(result.outcome).toBe('retryable_duplicate');
		expect(store.getById(event.id)!.state).toBe('ambiguous');
	});
});

// ---------------------------------------------------------------------------
// Task resolution outcomes
// ---------------------------------------------------------------------------

describe('publish — task resolution', () => {
	test('ambiguous resolution returns ignored and sets ambiguous state', async () => {
		// Seed two open tasks both matching PR #42
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Work on #42',
			description: 'lsm/neokai',
			status: 'open',
		});
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Also #42',
			description: 'neokai',
			status: 'open',
		});

		const event = makeEvent();
		const result = await service.publish(event);

		expect(result.outcome).toBe('ignored');
		expect(store.getById(event.id)!.state).toBe('ambiguous');
	});

	test('unknown resolution returns ignored and leaves event retryable', async () => {
		// No tasks at all
		const event = makeEvent();
		const result = await service.publish(event);

		expect(result.outcome).toBe('ignored');
		// Do NOT terminalize — a matching task may be created later.
		expect(store.getById(event.id)!.state).toBe('published');
	});

	test('ignored resolution (no PR number) leaves event non-terminal', async () => {
		const event = makeEvent({ prNumber: undefined });
		const result = await service.publish(event);

		expect(result.outcome).toBe('ignored');
		// Event stays in published so a later re-observation with complete
		// metadata can still be enriched.
		expect(store.getById(event.id)!.state).toBe('published');
	});

	test('ignored resolution still publishes bus event', async () => {
		const busReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				busReceived.push(data);
			},
			{ subscriberName: 'sub' }
		);

		const event = makeEvent({ prNumber: undefined });
		const result = await service.publish(event);

		expect(result.outcome).toBe('ignored');
		expect(busReceived).toHaveLength(1);
		expect(busReceived[0]!.eventId).toBe(event.id);
		expect(busReceived[0]!.routedTaskId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Custom resolver injection
// ---------------------------------------------------------------------------

describe('publish — custom resolver', () => {
	test('uses injected resolver for enrichment', async () => {
		const customResolver: ExternalEventTaskResolver = {
			async resolve(): Promise<TaskResolution> {
				return { type: 'enriched', routedTaskId: 'custom-task-1' };
			},
		};

		const customService = new ExternalEventService(store, customResolver, bus);
		const event = makeEvent();
		const result = await customService.publish(event);

		expect(result.outcome).toBe('published');
		expect(result.routedTaskId).toBe('custom-task-1');

		const rec = store.getById(event.id);
		expect(rec!.event.routedTaskId).toBe('custom-task-1');
		expect(rec!.state).toBe('routed');
	});
});

// ---------------------------------------------------------------------------
// Bus semantics
// ---------------------------------------------------------------------------

describe('publish — bus semantics', () => {
	test('bus event is space-scoped (sessionId === spaceId)', async () => {
		const received: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				received.push(data);
			},
			{ subscriberName: 'scoped-sub', sessionId: SPACE_ID }
		);

		// Seed matching task
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'open',
		});

		const event = makeEvent();
		await service.publish(event);

		expect(received).toHaveLength(1);
		expect(received[0]!.sessionId).toBe(SPACE_ID);
	});

	test('global subscriber also receives space-scoped event', async () => {
		const globalReceived: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				globalReceived.push(data);
			},
			{ subscriberName: 'global-sub' }
		);

		// Seed matching task
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'open',
		});

		const event = makeEvent();
		await service.publish(event);

		expect(globalReceived).toHaveLength(1);
	});

	test('bus is not fired for terminal duplicates', async () => {
		const received: ExternalEventPublishedPayload[] = [];
		bus.subscribe(
			'externalEvent.published',
			(data) => {
				received.push(data);
			},
			{ subscriberName: 'sub' }
		);

		// Seed a matching task so the first publish succeeds and fires the bus
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'open',
		});

		const event = makeEvent();
		await service.publish(event);
		expect(received).toHaveLength(1);

		// Mark terminal, then duplicate should NOT fire bus
		store.markEventIgnored(event.id, 'no_matching_subscriptions');
		const dup = makeEvent({ id: 'evt-dup', dedupeKey: event.dedupeKey });
		const result = await service.publish(dup);
		expect(result.outcome).toBe('duplicate_terminal');
		expect(received).toHaveLength(1); // no second bus event
	});
});
