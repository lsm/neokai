/**
 * Migration 94 Tests — Backfill workflow template tracking & end-node
 * completion actions.
 *
 * Migration 94 realigns legacy `space_workflows` rows with the current built-in
 * templates by:
 *   - Setting `template_name` + `template_hash` on rows whose node names
 *     structurally match a known template.
 *   - Re-injecting `MERGE_PR_COMPLETION_ACTION` on end nodes that lost it (seed
 *     bug A).
 *   - Deleting orphan duplicate rows that have no active `space_workflow_runs`
 *     references.
 *
 * Covers:
 *   - Legacy Coding Workflow backfill (template_name + canonical template_hash
 *     + merge-pr injected on Review end node)
 *   - Legacy Research Workflow backfill (similar)
 *   - Review-Only / Full-Cycle workflows backfill template_name but do NOT
 *     inject completionActions (those templates have no end-node actions)
 *   - Hash self-verification: the hashes my inlined fingerprints produce for
 *     each of the 5 built-in templates must match the canonical
 *     `computeWorkflowHash()` output. This guards against fingerprint drift.
 *   - Idempotency: running twice yields the same result
 *   - Custom workflows (non-template name) are untouched
 *   - Orphan duplicate deletion: older row deleted when no active runs
 *   - Orphan duplicate retention: older row kept when active runs reference it
 *   - Existing completionActions on end node preserved (no duplicate injection)
 *   - Rows with non-matching node structure are not treated as templates
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration94 } from '../../../../../src/storage/schema/migrations.ts';
import { getBuiltInWorkflows } from '../../../../../src/lib/space/workflows/built-in-workflows.ts';
import { computeWorkflowHash } from '../../../../../src/lib/space/workflows/template-hash.ts';

interface WorkflowRow {
	id: string;
	template_name: string | null;
	template_hash: string | null;
}

interface NodeRow {
	id: string;
	config: string | null;
}

function insertSpace(db: BunDatabase, id: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, id, '/ws', id, now, now);
}

function insertWorkflow(
	db: BunDatabase,
	opts: {
		id: string;
		spaceId: string;
		name: string;
		description?: string;
		channels?: unknown[];
		gates?: unknown[];
		startNodeId?: string | null;
		endNodeId?: string | null;
		templateName?: string | null;
		templateHash?: string | null;
		createdAt?: number;
	}
): void {
	const now = opts.createdAt ?? Date.now();
	db.prepare(
		`INSERT INTO space_workflows (
			id, space_id, name, description, start_node_id, end_node_id,
			tags, channels, gates, created_at, updated_at, template_name, template_hash
		 ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
	).run(
		opts.id,
		opts.spaceId,
		opts.name,
		opts.description ?? '',
		opts.startNodeId ?? null,
		opts.endNodeId ?? null,
		JSON.stringify(opts.channels ?? []),
		JSON.stringify(opts.gates ?? []),
		now,
		now,
		opts.templateName ?? null,
		opts.templateHash ?? null
	);
}

function insertNode(
	db: BunDatabase,
	opts: { id: string; workflowId: string; name: string; config?: unknown }
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(
		opts.id,
		opts.workflowId,
		opts.name,
		JSON.stringify(opts.config ?? { agents: [] }),
		now,
		now
	);
}

function insertRun(
	db: BunDatabase,
	opts: { id: string; spaceId: string; workflowId: string; status: string }
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(opts.id, opts.spaceId, opts.workflowId, 'run', opts.status, now, now);
}

function readWorkflow(db: BunDatabase, id: string): WorkflowRow | undefined {
	return db
		.prepare(`SELECT id, template_name, template_hash FROM space_workflows WHERE id = ?`)
		.get(id) as WorkflowRow | undefined;
}

function readNodeConfig(db: BunDatabase, id: string): Record<string, unknown> {
	const row = db.prepare(`SELECT id, config FROM space_workflow_nodes WHERE id = ?`).get(id) as
		| NodeRow
		| undefined;
	return row?.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
}

function seedLegacyCodingWorkflow(
	db: BunDatabase,
	opts: {
		id: string;
		spaceId: string;
		createdAt?: number;
		/** Default false — null template_name simulates pre-M90 legacy rows. */
		withTemplateFields?: boolean;
		/** Default false — when true, end node has completionActions already. */
		withCompletionActions?: boolean;
	}
): { workflowId: string; codingNodeId: string; reviewNodeId: string; doneNodeId: string } {
	const template = getBuiltInWorkflows().find((t) => t.name === 'Coding Workflow');
	if (!template) throw new Error('Coding Workflow template missing');

	const codingNodeId = `${opts.id}-n-coding`;
	const reviewNodeId = `${opts.id}-n-review`;
	const doneNodeId = `${opts.id}-n-done`;

	insertWorkflow(db, {
		id: opts.id,
		spaceId: opts.spaceId,
		name: template.name,
		description: template.description,
		channels: template.channels ?? [],
		gates: template.gates ?? [],
		startNodeId: codingNodeId,
		endNodeId: doneNodeId,
		templateName: opts.withTemplateFields ? template.name : null,
		templateHash: opts.withTemplateFields ? computeWorkflowHash(template) : null,
		createdAt: opts.createdAt,
	});

	insertNode(db, {
		id: codingNodeId,
		workflowId: opts.id,
		name: 'Coding',
		config: { agents: [{ agentId: 'a-coder', name: 'coder' }] },
	});

	insertNode(db, {
		id: reviewNodeId,
		workflowId: opts.id,
		name: 'Review',
		config: { agents: [{ agentId: 'a-reviewer', name: 'reviewer' }] },
	});

	const doneConfig: Record<string, unknown> = {
		agents: [{ agentId: 'a-general', name: 'closer' }],
	};
	if (opts.withCompletionActions) {
		doneConfig.completionActions = [
			{
				id: 'merge-pr',
				name: 'Merge PR',
				type: 'script',
				requiredLevel: 4,
				artifactType: 'pr',
				script: '# existing script',
			},
		];
	}
	insertNode(db, { id: doneNodeId, workflowId: opts.id, name: 'Done', config: doneConfig });

	return { workflowId: opts.id, codingNodeId, reviewNodeId, doneNodeId };
}

describe('Migration 94: backfill workflow template tracking & completion actions', () => {
	let testDir: string;
	let db: BunDatabase;

	beforeEach(() => {
		testDir = join(
			process.cwd(),
			'tmp',
			'test-migration-94',
			`test-${Date.now()}-${Math.random()}`
		);
		mkdirSync(testDir, { recursive: true });
		db = new BunDatabase(join(testDir, 'test.db'));
		db.exec('PRAGMA foreign_keys = ON');
		runMigrations(db, () => {});
		insertSpace(db, 'sp-1');
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('hash self-verification: inlined template fingerprints match computeWorkflowHash', () => {
		// For each built-in template, insert a workflow with the exact template
		// shape and verify that M94 sets template_hash to the canonical hash.
		// This guards against fingerprint drift between M94's inlined copies
		// and the live built-in template definitions.
		const templates = getBuiltInWorkflows();
		for (const [i, tpl] of templates.entries()) {
			const wfId = `wf-verify-${i}`;
			const endNodeId = `n-${i}-end`;
			const nodeIds = tpl.nodes.map((n) => ({ id: `n-${i}-${n.name}`, name: n.name }));
			const resolvedEndNodeId =
				nodeIds.find((n) => n.name === tpl.nodes.find((x) => x.id === tpl.endNodeId)?.name)?.id ??
				endNodeId;

			insertWorkflow(db, {
				id: wfId,
				spaceId: 'sp-1',
				name: tpl.name,
				description: tpl.description,
				channels: tpl.channels ?? [],
				gates: tpl.gates ?? [],
				endNodeId: resolvedEndNodeId,
			});
			for (const n of nodeIds) {
				insertNode(db, { id: n.id, workflowId: wfId, name: n.name });
			}
		}

		runMigration94(db);

		for (const [i, tpl] of templates.entries()) {
			const row = readWorkflow(db, `wf-verify-${i}`);
			const expectedHash = computeWorkflowHash(tpl);
			expect(row?.template_name).toBe(tpl.name);
			expect(row?.template_hash).toBe(expectedHash);
		}
	});

	test('divergent row (structure matches template but description differs) → template_hash reflects the row, not the canonical template', () => {
		// Pins the ELSE branch of `fingerprintMatches ? known.hash : rowHash` in
		// the migration. Combined with `hash self-verification` above (which
		// covers the TRUE branch), both branches are exercised.
		const template = getBuiltInWorkflows().find((t) => t.name === 'Coding Workflow')!;
		const canonicalHash = computeWorkflowHash(template);

		// Same name + node set as Coding Workflow, but with a tweaked description
		// — so the structural name match passes but fingerprintMatches is false.
		const wfId = 'wf-diverged';
		const codingId = 'n-d-coding';
		const reviewId = 'n-d-review';
		const doneId = 'n-d-done';
		insertWorkflow(db, {
			id: wfId,
			spaceId: 'sp-1',
			name: template.name,
			description: template.description + ' — user edited',
			channels: template.channels ?? [],
			gates: template.gates ?? [],
			endNodeId: doneId,
		});
		insertNode(db, { id: codingId, workflowId: wfId, name: 'Coding' });
		insertNode(db, { id: reviewId, workflowId: wfId, name: 'Review' });
		insertNode(db, { id: doneId, workflowId: wfId, name: 'Done' });

		runMigration94(db);

		const row = readWorkflow(db, wfId)!;
		// template_name still set — we're confident it's a Coding Workflow variant.
		expect(row.template_name).toBe('Coding Workflow');
		// template_hash must NOT be the canonical hash (fingerprint differs).
		expect(row.template_hash).not.toBe(canonicalHash);
		// And it must be non-null — the migration populates it with the row's
		// own fingerprint hash so drift detection reflects the current state.
		expect(row.template_hash).toBeTruthy();
	});

	test('legacy Coding Workflow: sets template_name + canonical hash + injects merge-pr', () => {
		const { workflowId, doneNodeId } = seedLegacyCodingWorkflow(db, {
			id: 'wf-1',
			spaceId: 'sp-1',
		});

		runMigration94(db);

		const template = getBuiltInWorkflows().find((t) => t.name === 'Coding Workflow')!;
		const expectedHash = computeWorkflowHash(template);

		const row = readWorkflow(db, workflowId)!;
		expect(row.template_name).toBe('Coding Workflow');
		expect(row.template_hash).toBe(expectedHash);

		// merge-pr is injected on the Done (end) node after Task #39 — Review is
		// no longer the terminal node.
		const cfg = readNodeConfig(db, doneNodeId) as {
			completionActions?: Array<{ id: string; type: string; artifactType?: string }>;
		};
		expect(cfg.completionActions).toBeDefined();
		expect(cfg.completionActions).toHaveLength(1);
		expect(cfg.completionActions?.[0]?.id).toBe('merge-pr');
		expect(cfg.completionActions?.[0]?.type).toBe('script');
		expect(cfg.completionActions?.[0]?.artifactType).toBe('pr');
	});

	test('legacy Research Workflow: sets template_name + canonical hash + injects merge-pr', () => {
		const template = getBuiltInWorkflows().find((t) => t.name === 'Research Workflow')!;
		const expectedHash = computeWorkflowHash(template);

		const wfId = 'wf-research';
		const researchNodeId = 'n-r-research';
		const reviewNodeId = 'n-r-review';

		insertWorkflow(db, {
			id: wfId,
			spaceId: 'sp-1',
			name: template.name,
			description: template.description,
			channels: template.channels ?? [],
			gates: template.gates ?? [],
			endNodeId: reviewNodeId,
		});
		insertNode(db, { id: researchNodeId, workflowId: wfId, name: 'Research' });
		insertNode(db, { id: reviewNodeId, workflowId: wfId, name: 'Review' });

		runMigration94(db);

		const row = readWorkflow(db, wfId)!;
		expect(row.template_name).toBe('Research Workflow');
		expect(row.template_hash).toBe(expectedHash);

		const cfg = readNodeConfig(db, reviewNodeId) as {
			completionActions?: Array<{ id: string }>;
		};
		expect(cfg.completionActions?.some((a) => a.id === 'merge-pr')).toBe(true);
	});

	test('Review-Only Workflow: sets template_name but does not inject completionActions', () => {
		const template = getBuiltInWorkflows().find((t) => t.name === 'Review-Only Workflow')!;
		const expectedHash = computeWorkflowHash(template);

		const wfId = 'wf-review-only';
		const reviewNodeId = 'n-ro-review';

		insertWorkflow(db, {
			id: wfId,
			spaceId: 'sp-1',
			name: template.name,
			description: template.description,
			channels: template.channels ?? [],
			gates: template.gates ?? [],
			endNodeId: reviewNodeId,
		});
		insertNode(db, { id: reviewNodeId, workflowId: wfId, name: 'Review' });

		runMigration94(db);

		const row = readWorkflow(db, wfId)!;
		expect(row.template_name).toBe('Review-Only Workflow');
		expect(row.template_hash).toBe(expectedHash);

		const cfg = readNodeConfig(db, reviewNodeId) as { completionActions?: unknown[] };
		// Review-Only has no endNodeCompletionActions; migration must not inject.
		expect(cfg.completionActions).toBeUndefined();
	});

	test('idempotent — running twice yields the same result', () => {
		const { workflowId, doneNodeId } = seedLegacyCodingWorkflow(db, {
			id: 'wf-idem',
			spaceId: 'sp-1',
		});

		runMigration94(db);
		const rowAfter1 = readWorkflow(db, workflowId)!;
		const cfgAfter1 = readNodeConfig(db, doneNodeId);

		runMigration94(db);
		const rowAfter2 = readWorkflow(db, workflowId)!;
		const cfgAfter2 = readNodeConfig(db, doneNodeId);

		expect(rowAfter2).toEqual(rowAfter1);
		expect(cfgAfter2).toEqual(cfgAfter1);

		// And the end-node still has exactly one merge-pr action — no duplication.
		const actions = (cfgAfter2 as { completionActions?: Array<{ id: string }> }).completionActions!;
		expect(actions.filter((a) => a.id === 'merge-pr')).toHaveLength(1);
	});

	test('custom workflow with non-matching name is untouched', () => {
		const wfId = 'wf-custom';
		insertWorkflow(db, {
			id: wfId,
			spaceId: 'sp-1',
			name: 'My Custom Workflow',
			description: 'a custom workflow',
			endNodeId: 'n-c',
		});
		insertNode(db, { id: 'n-c', workflowId: wfId, name: 'Custom' });

		runMigration94(db);

		const row = readWorkflow(db, wfId)!;
		expect(row.template_name).toBeNull();
		expect(row.template_hash).toBeNull();
	});

	test('row with matching name but non-matching node structure is NOT treated as a template', () => {
		// Same name as a template, but wrong node count / names — migration should
		// skip the fingerprint match and leave template_name unset.
		const wfId = 'wf-impostor';
		insertWorkflow(db, {
			id: wfId,
			spaceId: 'sp-1',
			name: 'Coding Workflow',
			description: 'imposter',
			endNodeId: 'n-i',
		});
		insertNode(db, { id: 'n-i', workflowId: wfId, name: 'NotCodingNotReview' });

		runMigration94(db);

		const row = readWorkflow(db, wfId)!;
		expect(row.template_name).toBeNull();
		expect(row.template_hash).toBeNull();
	});

	test('existing completionActions on end node preserved (no duplicate injection)', () => {
		const { workflowId, doneNodeId } = seedLegacyCodingWorkflow(db, {
			id: 'wf-has-action',
			spaceId: 'sp-1',
			withCompletionActions: true, // already has merge-pr
		});

		runMigration94(db);

		const cfg = readNodeConfig(db, doneNodeId) as {
			completionActions?: Array<{ id: string; script?: string }>;
		};
		// Must not duplicate — already had a merge-pr with "# existing script".
		expect(cfg.completionActions).toHaveLength(1);
		expect(cfg.completionActions?.[0]?.id).toBe('merge-pr');
		expect(cfg.completionActions?.[0]?.script).toBe('# existing script');

		// template_name + hash still set.
		const row = readWorkflow(db, workflowId)!;
		expect(row.template_name).toBe('Coding Workflow');
	});

	test('orphan duplicate deleted when it has no active runs', () => {
		// Insert two same-name Coding Workflow rows; older one has no runs.
		const older = seedLegacyCodingWorkflow(db, {
			id: 'wf-older',
			spaceId: 'sp-1',
			createdAt: 1000,
		});
		const newer = seedLegacyCodingWorkflow(db, {
			id: 'wf-newer',
			spaceId: 'sp-1',
			createdAt: 2000,
		});

		runMigration94(db);

		expect(readWorkflow(db, newer.workflowId)).toBeDefined();
		expect(readWorkflow(db, older.workflowId)).toBeNull();
	});

	test('duplicate retained when it has active runs', () => {
		const older = seedLegacyCodingWorkflow(db, {
			id: 'wf-older-active',
			spaceId: 'sp-1',
			createdAt: 1000,
		});
		const newer = seedLegacyCodingWorkflow(db, {
			id: 'wf-newer-active',
			spaceId: 'sp-1',
			createdAt: 2000,
		});

		// Active run on older row
		insertRun(db, {
			id: 'run-1',
			spaceId: 'sp-1',
			workflowId: older.workflowId,
			status: 'in_progress',
		});

		runMigration94(db);

		expect(readWorkflow(db, newer.workflowId)).toBeDefined();
		expect(readWorkflow(db, older.workflowId)).toBeDefined(); // kept — has active run
	});

	test('duplicate retained when only run is pending (still active)', () => {
		const older = seedLegacyCodingWorkflow(db, {
			id: 'wf-older-pending',
			spaceId: 'sp-1',
			createdAt: 1000,
		});
		const newer = seedLegacyCodingWorkflow(db, {
			id: 'wf-newer-pending',
			spaceId: 'sp-1',
			createdAt: 2000,
		});

		insertRun(db, {
			id: 'run-p',
			spaceId: 'sp-1',
			workflowId: older.workflowId,
			status: 'pending',
		});

		runMigration94(db);

		expect(readWorkflow(db, older.workflowId)).toBeDefined();
		expect(readWorkflow(db, newer.workflowId)).toBeDefined();
	});

	test('duplicate deleted when its only runs are terminal (done/cancelled)', () => {
		const older = seedLegacyCodingWorkflow(db, {
			id: 'wf-older-done',
			spaceId: 'sp-1',
			createdAt: 1000,
		});
		const newer = seedLegacyCodingWorkflow(db, {
			id: 'wf-newer-done',
			spaceId: 'sp-1',
			createdAt: 2000,
		});

		insertRun(db, {
			id: 'run-done',
			spaceId: 'sp-1',
			workflowId: older.workflowId,
			status: 'done',
		});
		insertRun(db, {
			id: 'run-cancelled',
			spaceId: 'sp-1',
			workflowId: older.workflowId,
			status: 'cancelled',
		});

		runMigration94(db);

		// All runs terminal → older considered orphan → deleted.
		expect(readWorkflow(db, older.workflowId)).toBeNull();
		expect(readWorkflow(db, newer.workflowId)).toBeDefined();
	});

	test('custom workflow rows never considered for duplicate deletion', () => {
		// Two custom workflows with same name — neither should be deleted because
		// they are not treated as built-ins.
		insertWorkflow(db, {
			id: 'wf-c1',
			spaceId: 'sp-1',
			name: 'Custom Workflow',
			createdAt: 1000,
			endNodeId: 'n-c1',
		});
		insertNode(db, { id: 'n-c1', workflowId: 'wf-c1', name: 'N' });

		insertWorkflow(db, {
			id: 'wf-c2',
			spaceId: 'sp-1',
			name: 'Custom Workflow',
			createdAt: 2000,
			endNodeId: 'n-c2',
		});
		insertNode(db, { id: 'n-c2', workflowId: 'wf-c2', name: 'N' });

		runMigration94(db);

		expect(readWorkflow(db, 'wf-c1')).toBeDefined();
		expect(readWorkflow(db, 'wf-c2')).toBeDefined();
	});

	test('row already backfilled is left alone (no redundant writes)', () => {
		const template = getBuiltInWorkflows().find((t) => t.name === 'Coding Workflow')!;
		const { workflowId, doneNodeId } = seedLegacyCodingWorkflow(db, {
			id: 'wf-already-backfilled',
			spaceId: 'sp-1',
			withTemplateFields: true,
			withCompletionActions: true,
		});

		const beforeRow = readWorkflow(db, workflowId)!;
		const beforeCfg = readNodeConfig(db, doneNodeId);

		runMigration94(db);

		const afterRow = readWorkflow(db, workflowId)!;
		const afterCfg = readNodeConfig(db, doneNodeId);

		expect(afterRow.template_name).toBe(template.name);
		expect(afterRow.template_hash).toBe(computeWorkflowHash(template));
		expect(afterCfg).toEqual(beforeCfg);
		expect(afterRow).toEqual(beforeRow);
	});
});
