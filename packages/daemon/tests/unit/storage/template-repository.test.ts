import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TemplateRepository } from '../../../src/storage/repositories/template-repository';

describe('TemplateRepository', () => {
	let db: Database;
	let repo: TemplateRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		db.exec(`
			CREATE TABLE session_templates (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				description TEXT,
				scope TEXT NOT NULL DEFAULT 'session' CHECK(scope IN ('session', 'room')),
				config TEXT NOT NULL DEFAULT '{}',
				room_config TEXT,
				variables TEXT,
				built_in INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		repo = new TemplateRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it('creates and retrieves a template', () => {
		const template = repo.createTemplate({
			name: 'Bug Fix',
			description: 'Fix a bug',
			scope: 'session',
			config: { systemPrompt: 'Fix: {{description}}' },
			variables: [
				{ name: 'description', label: 'Bug Description', type: 'textarea', required: true },
			],
		});

		expect(template.name).toBe('Bug Fix');
		expect(template.scope).toBe('session');
		expect(template.config.systemPrompt).toBe('Fix: {{description}}');
		expect(template.variables).toHaveLength(1);
		expect(template.builtIn).toBe(false);

		const retrieved = repo.getTemplate(template.id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.name).toBe('Bug Fix');
	});

	it('lists templates filtered by scope', () => {
		repo.createTemplate({
			name: 'Session Template',
			scope: 'session',
			config: {},
		});
		repo.createTemplate({
			name: 'Room Template',
			scope: 'room',
			config: {},
		});

		const all = repo.listTemplates();
		expect(all).toHaveLength(2);

		const sessions = repo.listTemplates('session');
		expect(sessions).toHaveLength(1);
		expect(sessions[0].name).toBe('Session Template');

		const rooms = repo.listTemplates('room');
		expect(rooms).toHaveLength(1);
		expect(rooms[0].name).toBe('Room Template');
	});

	it('updates a user-created template', () => {
		const template = repo.createTemplate({
			name: 'Original',
			scope: 'session',
			config: { systemPrompt: 'old prompt' },
		});

		const updated = repo.updateTemplate(template.id, {
			name: 'Updated',
			config: { systemPrompt: 'new prompt' },
		});

		expect(updated).not.toBeNull();
		expect(updated!.name).toBe('Updated');
		expect(updated!.config.systemPrompt).toBe('new prompt');
	});

	it('cannot update a built-in template', () => {
		const now = Date.now();
		repo.createBuiltIn({
			id: 'builtin:test',
			name: 'Built-in',
			scope: 'session',
			config: {},
			builtIn: true,
			createdAt: now,
			updatedAt: now,
		});

		const result = repo.updateTemplate('builtin:test', { name: 'Hacked' });
		expect(result).toBeNull();

		const unchanged = repo.getTemplate('builtin:test');
		expect(unchanged!.name).toBe('Built-in');
	});

	it('deletes a user-created template', () => {
		const template = repo.createTemplate({
			name: 'Deletable',
			scope: 'session',
			config: {},
		});

		const deleted = repo.deleteTemplate(template.id);
		expect(deleted).toBe(true);

		const gone = repo.getTemplate(template.id);
		expect(gone).toBeNull();
	});

	it('cannot delete a built-in template', () => {
		const now = Date.now();
		repo.createBuiltIn({
			id: 'builtin:nodelete',
			name: 'Protected',
			scope: 'session',
			config: {},
			builtIn: true,
			createdAt: now,
			updatedAt: now,
		});

		const deleted = repo.deleteTemplate('builtin:nodelete');
		expect(deleted).toBe(false);

		const still = repo.getTemplate('builtin:nodelete');
		expect(still).not.toBeNull();
	});

	it('createBuiltIn is idempotent', () => {
		const now = Date.now();
		const template = {
			id: 'builtin:idem',
			name: 'First',
			scope: 'session' as const,
			config: {},
			builtIn: true,
			createdAt: now,
			updatedAt: now,
		};

		repo.createBuiltIn(template);
		repo.createBuiltIn({ ...template, name: 'Second' });

		const result = repo.getTemplate('builtin:idem');
		expect(result!.name).toBe('First'); // First insertion wins
	});

	it('lists built-in templates first', () => {
		const now = Date.now();
		repo.createBuiltIn({
			id: 'builtin:alpha',
			name: 'Alpha Built-in',
			scope: 'session',
			config: {},
			builtIn: true,
			createdAt: now,
			updatedAt: now,
		});
		repo.createTemplate({
			name: 'Aardvark User',
			scope: 'session',
			config: {},
		});

		const all = repo.listTemplates();
		expect(all[0].builtIn).toBe(true);
		expect(all[1].builtIn).toBe(false);
	});
});
