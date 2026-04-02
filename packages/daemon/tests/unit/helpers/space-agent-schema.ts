/**
 * Shared test schema helpers for Space Agent tests.
 *
 * Used by both space-agent-repository.test.ts and space-agent-manager.test.ts
 * to avoid duplicating schema setup and fixture insertion code.
 *
 * Keep in sync with the fully-migrated production schema (after M71).
 */

import type { Database } from 'bun:sqlite';

export function createSpaceAgentSchema(db: Database): void {
	db.exec(`PRAGMA foreign_keys = ON`);
	db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			workspace_path TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			background_context TEXT NOT NULL DEFAULT '',
			instructions TEXT NOT NULL DEFAULT '',
			default_model TEXT,
			allowed_models TEXT NOT NULL DEFAULT '[]',
			session_ids TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active',
			autonomy_level TEXT NOT NULL DEFAULT 'supervised',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);

	// Keep in sync with space-test-db.ts (post-M71 schema).
	db.exec(`
		CREATE TABLE space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			system_prompt TEXT NOT NULL DEFAULT '',
			instructions TEXT,
			provider TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
	db.exec(`CREATE INDEX idx_space_agents_space_id ON space_agents(space_id)`);

	db.exec(`
		CREATE TABLE space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			start_node_id TEXT,
			end_node_id TEXT,
			channels TEXT,
			gates TEXT,
			layout TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE space_workflow_nodes (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			agents TEXT NOT NULL DEFAULT '[]',
			order_index INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);
}

export function insertSpace(db: Database, id = 'space-1'): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, `/workspace/${id}`, `Space ${id}`, id, now, now);
}

export function insertWorkflow(db: Database, id: string, spaceId: string, name: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
	).run(id, spaceId, name, now, now);
}

export function insertWorkflowNode(
	db: Database,
	id: string,
	workflowId: string,
	agentId: string | null
): void {
	const now = Date.now();
	// agents column stores a JSON array of {agentId, name} objects
	const agentsJson = agentId ? JSON.stringify([{ agentId, name: `Node ${id}` }]) : '[]';
	db.prepare(
		`INSERT INTO space_workflow_nodes (id, workflow_id, name, agents, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(id, workflowId, `Node ${id}`, agentsJson, 0, now, now);
}
