/**
 * ExternalEventTaskResolver Unit Tests
 *
 * Covers:
 *   - GitHubExternalEventTaskResolver
 *     * trusted routedTaskId returns enriched
 *     * single matching task returns enriched
 *     * multiple matching tasks returns ambiguous
 *     * no matching tasks returns unknown
 *     * missing prNumber/repoOwner/repoName returns ignored
 *     * non-github source returns ignored
 *     * archived/done/cancelled tasks are excluded from matching
 *     * PR number boundary matching (not raw substring)
 *     * repo filter narrows candidates in multi-repo spaces
 *   - No direct workflow/task/gate table queries
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSpaceTables } from '../../helpers/space-test-db';
import { GitHubExternalEventTaskResolver } from '../../../../src/lib/external-events/external-event-task-resolver';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';

let db: Database;
let taskRepo: SpaceTaskRepository;
let resolver: GitHubExternalEventTaskResolver;

const SPACE_ID = 'sp-resolver';

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
		id: 'evt-1',
		spaceId: SPACE_ID,
		source: 'github',
		topic: 'github/lsm/neokai/pull_request.review_submitted',
		occurredAt: 1_700_000_000_000,
		ingestedAt: 1_700_000_001_000,
		dedupeKey: 'dk-1',
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
	taskRepo = new SpaceTaskRepository(db);
	resolver = new GitHubExternalEventTaskResolver({ taskRepo });
});

// ---------------------------------------------------------------------------
// Trusted metadata
// ---------------------------------------------------------------------------

describe('trusted routedTaskId', () => {
	test('returns enriched with the provided routedTaskId', async () => {
		const event = makeEvent({ routedTaskId: 'task-trusted' });
		const result = await resolver.resolve(event);

		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe('task-trusted');
		}
	});
});

// ---------------------------------------------------------------------------
// Heuristic matching
// ---------------------------------------------------------------------------

describe('heuristic PR matching', () => {
	test('single open task matching PR number returns enriched', async () => {
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent());

		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe(task.id);
		}
	});

	test('multiple open tasks matching PR number returns ambiguous', async () => {
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

		const result = await resolver.resolve(makeEvent());

		expect(result.type).toBe('ambiguous');
		if (result.type === 'ambiguous') {
			expect(result.candidateTaskIds).toHaveLength(2);
		}
	});

	test('no matching tasks returns unknown', async () => {
		const result = await resolver.resolve(makeEvent());

		expect(result.type).toBe('unknown');
	});

	test('archived tasks are excluded from matching', async () => {
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: '',
			status: 'archived',
		});

		const result = await resolver.resolve(makeEvent());
		expect(result.type).toBe('unknown');
	});

	test('done tasks are excluded from matching', async () => {
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: '',
			status: 'done',
		});

		const result = await resolver.resolve(makeEvent());
		expect(result.type).toBe('unknown');
	});

	test('cancelled tasks are excluded from matching', async () => {
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: '',
			status: 'cancelled',
		});

		const result = await resolver.resolve(makeEvent());
		expect(result.type).toBe('unknown');
	});

	test('in_progress tasks are included in matching', async () => {
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'in_progress',
		});

		const result = await resolver.resolve(makeEvent());
		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe(task.id);
		}
	});
});

// ---------------------------------------------------------------------------
// Boundary matching
// ---------------------------------------------------------------------------

describe('PR number boundary matching', () => {
	test('does not match #42 inside #420', async () => {
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #420',
			description: '',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent({ prNumber: 42 }));
		expect(result.type).toBe('unknown');
	});

	test('does not match #42 inside abc#42x', async () => {
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'abc#42x something',
			description: '',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent({ prNumber: 42 }));
		expect(result.type).toBe('unknown');
	});

	test('matches #42 at start of title', async () => {
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: '#42 fix bug',
			description: 'lsm/neokai',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent({ prNumber: 42 }));
		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe(task.id);
		}
	});

	test('matches #42 at end of title', async () => {
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'lsm/neokai',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent({ prNumber: 42 }));
		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe(task.id);
		}
	});

	test('matches #42 surrounded by spaces', async () => {
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42 in parser',
			description: 'lsm/neokai',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent({ prNumber: 42 }));
		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe(task.id);
		}
	});
});

// ---------------------------------------------------------------------------
// Repo filter
// ---------------------------------------------------------------------------

describe('repo filter', () => {
	test('taskRepoFilter narrows candidates by repo', async () => {
		const repoA = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: '',
			status: 'open',
		});
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Also #42',
			description: '',
			status: 'open',
		});

		const filteredResolver = new GitHubExternalEventTaskResolver({
			taskRepo,
			taskRepoFilter: (task) => task.id === repoA.id,
		});

		const result = await filteredResolver.resolve(makeEvent());
		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe(repoA.id);
		}
	});

	test('taskRepoFilter can produce unknown when no tasks match repo', async () => {
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: '',
			status: 'open',
		});

		const filteredResolver = new GitHubExternalEventTaskResolver({
			taskRepo,
			taskRepoFilter: () => false,
		});

		const result = await filteredResolver.resolve(makeEvent());
		expect(result.type).toBe('unknown');
	});
});

// ---------------------------------------------------------------------------
// Default repo filter
// ---------------------------------------------------------------------------

describe('default repo filter', () => {
	test('excludes tasks that do not mention repo owner or name', async () => {
		taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'some unrelated work',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent());
		expect(result.type).toBe('unknown');
	});

	test('includes tasks that mention repo owner in title', async () => {
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42 for lsm',
			description: '',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent());
		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe(task.id);
		}
	});

	test('includes tasks that mention repo name in description', async () => {
		const task = taskRepo.createTask({
			spaceId: SPACE_ID,
			title: 'Fix bug #42',
			description: 'work on neokai feature',
			status: 'open',
		});

		const result = await resolver.resolve(makeEvent());
		expect(result.type).toBe('enriched');
		if (result.type === 'enriched') {
			expect(result.routedTaskId).toBe(task.id);
		}
	});
});

// ---------------------------------------------------------------------------
// PR number validation
// ---------------------------------------------------------------------------

describe('PR number validation', () => {
	test('non-integer prNumber returns unknown (tried to match but found nothing)', async () => {
		const result = await resolver.resolve(makeEvent({ prNumber: 3.14 }));
		expect(result.type).toBe('unknown');
	});

	test('negative prNumber returns unknown', async () => {
		const result = await resolver.resolve(makeEvent({ prNumber: -1 }));
		expect(result.type).toBe('unknown');
	});

	test('zero prNumber returns unknown', async () => {
		const result = await resolver.resolve(makeEvent({ prNumber: 0 }));
		expect(result.type).toBe('unknown');
	});
});

// ---------------------------------------------------------------------------
// Ignored cases
// ---------------------------------------------------------------------------

describe('ignored resolution', () => {
	test('missing prNumber returns ignored', async () => {
		const result = await resolver.resolve(makeEvent({ prNumber: undefined }));
		expect(result.type).toBe('ignored');
	});

	test('missing repoOwner returns ignored', async () => {
		const result = await resolver.resolve(makeEvent({ repoOwner: undefined }));
		expect(result.type).toBe('ignored');
	});

	test('missing repoName returns ignored', async () => {
		const result = await resolver.resolve(makeEvent({ repoName: undefined }));
		expect(result.type).toBe('ignored');
	});

	test('non-github source returns ignored', async () => {
		const result = await resolver.resolve(makeEvent({ source: 'slack' as unknown as 'github' }));
		expect(result.type).toBe('ignored');
	});
});
