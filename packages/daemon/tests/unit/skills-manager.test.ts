/**
 * Unit Tests for SkillRepository and SkillsManager
 *
 * Covers:
 * - CRUD operations with in-memory SQLite
 * - Built-in skill deletion protection
 * - Persistence across load cycles
 * - getEnabledSkills() filtering
 * - All validation rules (plugin path traversal, mcp_server ref, builtin commandName)
 * - sourceType / config.type consistency enforcement
 * - Name uniqueness enforcement
 * - Valid configs pass validation
 */

import { unlinkSync } from 'node:fs';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../src/storage/schema';
import { SkillRepository } from '../../src/storage/repositories/skill-repository';
import { AppMcpServerRepository } from '../../src/storage/repositories/app-mcp-server-repository';
import { SkillsManager } from '../../src/lib/skills-manager';
import { noOpReactiveDb } from '../helpers/reactive-database';
import type { AppSkill } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	createTables(db);
	return db;
}

function makeRepo(db: BunDatabase): SkillRepository {
	return new SkillRepository(db, noOpReactiveDb);
}

function makeMcpRepo(db: BunDatabase): AppMcpServerRepository {
	return new AppMcpServerRepository(db, noOpReactiveDb);
}

function makeManager(db: BunDatabase): { mgr: SkillsManager; mcpRepo: AppMcpServerRepository } {
	const mcpRepo = makeMcpRepo(db);
	const skillRepo = makeRepo(db);
	const mgr = new SkillsManager(skillRepo, mcpRepo);
	return { mgr, mcpRepo };
}

// ---------------------------------------------------------------------------
// SkillRepository tests
// ---------------------------------------------------------------------------

describe('SkillRepository', () => {
	let db: BunDatabase;
	let repo: SkillRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
	});

	afterEach(() => {
		db.close();
	});

	test('findAll returns empty array on fresh DB', () => {
		expect(repo.findAll()).toEqual([]);
	});

	test('insert and get round-trip', () => {
		const skill: AppSkill = {
			id: 'skill-1',
			name: 'test-skill',
			displayName: 'Test Skill',
			description: 'A test skill',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'test-cmd' },
			enabled: true,
			builtIn: false,
			validationStatus: 'pending',
			createdAt: Date.now(),
		};
		repo.insert(skill);

		const found = repo.get('skill-1');
		expect(found).not.toBeNull();
		expect(found!.id).toBe('skill-1');
		expect(found!.name).toBe('test-skill');
		expect(found!.displayName).toBe('Test Skill');
		expect(found!.config).toEqual({ type: 'builtin', commandName: 'test-cmd' });
		expect(found!.enabled).toBe(true);
		expect(found!.builtIn).toBe(false);
		expect(found!.validationStatus).toBe('pending');
	});

	test('get returns null for unknown id', () => {
		expect(repo.get('nonexistent')).toBeNull();
	});

	test('getByName returns skill by name', () => {
		const skill: AppSkill = {
			id: 'gbn-1',
			name: 'by-name',
			displayName: 'By Name',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			builtIn: false,
			validationStatus: 'pending',
			createdAt: 1,
		};
		repo.insert(skill);
		expect(repo.getByName('by-name')).not.toBeNull();
		expect(repo.getByName('nonexistent')).toBeNull();
	});

	test('findAll returns all inserted skills', () => {
		const base = {
			description: 'd',
			sourceType: 'builtin' as const,
			enabled: true,
			builtIn: false,
			validationStatus: 'pending' as const,
			createdAt: 1,
		};
		repo.insert({
			...base,
			id: 'a',
			name: 'skill-a',
			displayName: 'A',
			config: { type: 'builtin', commandName: 'cmd-a' },
		});
		repo.insert({
			...base,
			id: 'b',
			name: 'skill-b',
			displayName: 'B',
			config: { type: 'builtin', commandName: 'cmd-b' },
		});

		const all = repo.findAll();
		expect(all).toHaveLength(2);
		expect(all.map((s) => s.id)).toContain('a');
		expect(all.map((s) => s.id)).toContain('b');
	});

	test('findEnabled returns only enabled skills', () => {
		const base = {
			description: 'd',
			sourceType: 'builtin' as const,
			builtIn: false,
			validationStatus: 'pending' as const,
			createdAt: 1,
		};
		repo.insert({
			...base,
			id: 'e1',
			name: 'enabled-1',
			displayName: 'E1',
			config: { type: 'builtin', commandName: 'c1' },
			enabled: true,
		});
		repo.insert({
			...base,
			id: 'e2',
			name: 'disabled-1',
			displayName: 'D1',
			config: { type: 'builtin', commandName: 'c2' },
			enabled: false,
		});

		const enabled = repo.findEnabled();
		expect(enabled).toHaveLength(1);
		expect(enabled[0].id).toBe('e1');
	});

	test('update modifies displayName and description', () => {
		const skill: AppSkill = {
			id: 'upd-1',
			name: 'upd',
			displayName: 'Old',
			description: 'Old desc',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			builtIn: false,
			validationStatus: 'pending',
			createdAt: 1,
		};
		repo.insert(skill);
		repo.update('upd-1', { displayName: 'New Name', description: 'New desc' });

		const found = repo.get('upd-1');
		expect(found!.displayName).toBe('New Name');
		expect(found!.description).toBe('New desc');
	});

	test('setEnabled toggles enabled flag', () => {
		const skill: AppSkill = {
			id: 'tog-1',
			name: 'tog',
			displayName: 'Tog',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			builtIn: false,
			validationStatus: 'pending',
			createdAt: 1,
		};
		repo.insert(skill);
		repo.setEnabled('tog-1', false);
		expect(repo.get('tog-1')!.enabled).toBe(false);
		repo.setEnabled('tog-1', true);
		expect(repo.get('tog-1')!.enabled).toBe(true);
	});

	test('setValidationStatus updates validation_status and returns true', () => {
		const skill: AppSkill = {
			id: 'val-1',
			name: 'val',
			displayName: 'Val',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			builtIn: false,
			validationStatus: 'pending',
			createdAt: 1,
		};
		repo.insert(skill);
		const changed = repo.setValidationStatus('val-1', 'valid');
		expect(changed).toBe(true);
		expect(repo.get('val-1')!.validationStatus).toBe('valid');
	});

	test('setValidationStatus returns false for unknown id', () => {
		expect(repo.setValidationStatus('ghost', 'valid')).toBe(false);
	});

	test('delete removes a skill and returns true', () => {
		const skill: AppSkill = {
			id: 'del-1',
			name: 'del',
			displayName: 'Del',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			builtIn: false,
			validationStatus: 'pending',
			createdAt: 1,
		};
		repo.insert(skill);
		expect(repo.delete('del-1')).toBe(true);
		expect(repo.get('del-1')).toBeNull();
	});

	test('delete returns false for unknown id', () => {
		expect(repo.delete('ghost')).toBe(false);
	});

	test('persistence across load cycles — re-open same DB path', () => {
		const tmpPath = `/tmp/skills-test-${Date.now()}.db`;
		const db1 = new BunDatabase(tmpPath);
		createTables(db1);
		const repo1 = new SkillRepository(db1, noOpReactiveDb);
		repo1.insert({
			id: 'persist-1',
			name: 'persist',
			displayName: 'Persist',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'p-cmd' },
			enabled: true,
			builtIn: false,
			validationStatus: 'valid',
			createdAt: 42,
		});
		db1.close();

		// Re-open — data must still be there
		const db2 = new BunDatabase(tmpPath);
		const repo2 = new SkillRepository(db2, noOpReactiveDb);
		const found = repo2.get('persist-1');
		expect(found).not.toBeNull();
		expect(found!.name).toBe('persist');
		expect(found!.validationStatus).toBe('valid');
		db2.close();

		// Clean up temp file
		unlinkSync(tmpPath);
	});
});

// ---------------------------------------------------------------------------
// SkillsManager tests
// ---------------------------------------------------------------------------

describe('SkillsManager', () => {
	let db: BunDatabase;
	let mgr: SkillsManager;
	let mcpRepo: AppMcpServerRepository;

	beforeEach(() => {
		db = makeDb();
		({ mgr, mcpRepo } = makeManager(db));
	});

	afterEach(() => {
		db.close();
	});

	// --- CRUD ---

	test('addSkill creates a skill with generated id and createdAt', () => {
		const skill = mgr.addSkill({
			name: 'my-skill',
			displayName: 'My Skill',
			description: 'Does something',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'my-cmd' },
			enabled: true,
			validationStatus: 'pending',
		});

		expect(skill.id).toBeTruthy();
		expect(skill.name).toBe('my-skill');
		expect(skill.builtIn).toBe(false);
		expect(skill.createdAt).toBeGreaterThan(0);
	});

	test('listSkills returns all skills', () => {
		mgr.addSkill({
			name: 's1',
			displayName: 'S1',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'c1' },
			enabled: true,
			validationStatus: 'pending',
		});
		mgr.addSkill({
			name: 's2',
			displayName: 'S2',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'c2' },
			enabled: true,
			validationStatus: 'pending',
		});
		expect(mgr.listSkills()).toHaveLength(2);
	});

	test('getSkill returns null for unknown id', () => {
		expect(mgr.getSkill('unknown')).toBeNull();
	});

	test('updateSkill modifies displayName', () => {
		const skill = mgr.addSkill({
			name: 'upd',
			displayName: 'Old',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			validationStatus: 'pending',
		});
		const updated = mgr.updateSkill(skill.id, { displayName: 'New' });
		expect(updated.displayName).toBe('New');
	});

	test('updateSkill throws for unknown id', () => {
		expect(() => mgr.updateSkill('ghost', { displayName: 'x' })).toThrow('not found');
	});

	test('setSkillEnabled toggles enabled', () => {
		const skill = mgr.addSkill({
			name: 'toggle',
			displayName: 'T',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			validationStatus: 'pending',
		});
		const disabled = mgr.setSkillEnabled(skill.id, false);
		expect(disabled.enabled).toBe(false);
	});

	test('setSkillValidationStatus updates status and returns updated skill', () => {
		const skill = mgr.addSkill({
			name: 'valst',
			displayName: 'V',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			validationStatus: 'pending',
		});
		const updated = mgr.setSkillValidationStatus(skill.id, 'valid');
		expect(updated.validationStatus).toBe('valid');
	});

	test('setSkillValidationStatus throws for unknown id', () => {
		expect(() => mgr.setSkillValidationStatus('ghost', 'valid')).toThrow('not found');
	});

	test('getEnabledSkills filters disabled skills', () => {
		mgr.addSkill({
			name: 'on',
			displayName: 'On',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'c1' },
			enabled: true,
			validationStatus: 'pending',
		});
		const off = mgr.addSkill({
			name: 'off',
			displayName: 'Off',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'c2' },
			enabled: false,
			validationStatus: 'pending',
		});
		const enabled = mgr.getEnabledSkills();
		expect(enabled.map((s) => s.id)).not.toContain(off.id);
		expect(enabled).toHaveLength(1);
	});

	// --- Name uniqueness ---

	test('addSkill throws a friendly error on duplicate name', () => {
		mgr.addSkill({
			name: 'dupe',
			displayName: 'Dupe',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			validationStatus: 'pending',
		});
		expect(() =>
			mgr.addSkill({
				name: 'dupe',
				displayName: 'Dupe 2',
				description: 'd',
				sourceType: 'builtin',
				config: { type: 'builtin', commandName: 'cmd2' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('already exists');
	});

	// --- Built-in protection ---

	test('removeSkill returns false for built-in skill', () => {
		// Insert a built-in skill directly via repo (bypasses manager's addSkill)
		const repo = makeRepo(db);
		repo.insert({
			id: 'builtin-1',
			name: 'bi',
			displayName: 'BI',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			builtIn: true,
			validationStatus: 'valid',
			createdAt: Date.now(),
		});
		expect(mgr.removeSkill('builtin-1')).toBe(false);
		expect(mgr.getSkill('builtin-1')).not.toBeNull();
	});

	test('removeSkill returns false for unknown id', () => {
		expect(mgr.removeSkill('ghost')).toBe(false);
	});

	test('removeSkill deletes non-built-in skill', () => {
		const skill = mgr.addSkill({
			name: 'rem',
			displayName: 'R',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'cmd' },
			enabled: true,
			validationStatus: 'pending',
		});
		expect(mgr.removeSkill(skill.id)).toBe(true);
		expect(mgr.getSkill(skill.id)).toBeNull();
	});

	// --- Validation: sourceType / config.type mismatch ---

	test('addSkill rejects mismatched sourceType and config.type', () => {
		expect(() =>
			mgr.addSkill({
				name: 'mismatch',
				displayName: 'M',
				description: 'd',
				sourceType: 'builtin',
				// @ts-expect-error — intentional mismatch for testing runtime guard
				config: { type: 'plugin', pluginPath: '/some/path' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('must match config.type');
	});

	// --- Validation: plugin ---

	test('addSkill with plugin: valid absolute path passes', () => {
		const skill = mgr.addSkill({
			name: 'plugin-ok',
			displayName: 'P',
			description: 'd',
			sourceType: 'plugin',
			config: { type: 'plugin', pluginPath: '/usr/local/plugins/myplugin' },
			enabled: true,
			validationStatus: 'pending',
		});
		expect(skill.name).toBe('plugin-ok');
	});

	test('addSkill with plugin: empty pluginPath throws', () => {
		expect(() =>
			mgr.addSkill({
				name: 'plugin-empty',
				displayName: 'P',
				description: 'd',
				sourceType: 'plugin',
				config: { type: 'plugin', pluginPath: '' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('pluginPath must not be empty');
	});

	test('addSkill with plugin: relative path throws', () => {
		expect(() =>
			mgr.addSkill({
				name: 'plugin-rel',
				displayName: 'P',
				description: 'd',
				sourceType: 'plugin',
				config: { type: 'plugin', pluginPath: 'relative/path' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('absolute path');
	});

	test('addSkill with plugin: path traversal with ../ throws', () => {
		expect(() =>
			mgr.addSkill({
				name: 'plugin-traverse',
				displayName: 'P',
				description: 'd',
				sourceType: 'plugin',
				config: { type: 'plugin', pluginPath: '/plugins/../etc/passwd' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('traversal');
	});

	test('addSkill with plugin: path traversal at end (/foo/..) throws', () => {
		expect(() =>
			mgr.addSkill({
				name: 'plugin-traverse-end',
				displayName: 'P',
				description: 'd',
				sourceType: 'plugin',
				config: { type: 'plugin', pluginPath: '/plugins/foo/..' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('traversal');
	});

	// --- Validation: mcp_server ---

	test('addSkill with mcp_server: valid appMcpServerId passes', () => {
		const server = mcpRepo.create({ name: 'brave', sourceType: 'stdio', command: 'npx' });
		const skill = mgr.addSkill({
			name: 'mcp-ok',
			displayName: 'MCP',
			description: 'd',
			sourceType: 'mcp_server',
			config: { type: 'mcp_server', appMcpServerId: server.id },
			enabled: true,
			validationStatus: 'pending',
		});
		expect(skill.name).toBe('mcp-ok');
	});

	test('addSkill with mcp_server: non-existent appMcpServerId throws', () => {
		expect(() =>
			mgr.addSkill({
				name: 'mcp-bad',
				displayName: 'MCP',
				description: 'd',
				sourceType: 'mcp_server',
				config: { type: 'mcp_server', appMcpServerId: 'does-not-exist' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('not found');
	});

	test('addSkill with mcp_server: empty appMcpServerId throws', () => {
		expect(() =>
			mgr.addSkill({
				name: 'mcp-empty',
				displayName: 'MCP',
				description: 'd',
				sourceType: 'mcp_server',
				config: { type: 'mcp_server', appMcpServerId: '' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('appMcpServerId must not be empty');
	});

	// --- Validation: builtin ---

	test('addSkill with builtin: valid commandName passes', () => {
		const skill = mgr.addSkill({
			name: 'bi-ok',
			displayName: 'BI',
			description: 'd',
			sourceType: 'builtin',
			config: { type: 'builtin', commandName: 'update-config' },
			enabled: true,
			validationStatus: 'pending',
		});
		expect(skill.name).toBe('bi-ok');
	});

	test('addSkill with builtin: empty commandName throws', () => {
		expect(() =>
			mgr.addSkill({
				name: 'bi-empty',
				displayName: 'BI',
				description: 'd',
				sourceType: 'builtin',
				config: { type: 'builtin', commandName: '' },
				enabled: true,
				validationStatus: 'pending',
			})
		).toThrow('commandName must not be empty');
	});

	// --- Validation on updateSkill ---

	test('updateSkill validates new config', () => {
		const skill = mgr.addSkill({
			name: 'upd-val',
			displayName: 'U',
			description: 'd',
			sourceType: 'plugin',
			config: { type: 'plugin', pluginPath: '/good/path' },
			enabled: true,
			validationStatus: 'pending',
		});

		expect(() =>
			mgr.updateSkill(skill.id, { config: { type: 'plugin', pluginPath: 'bad/relative' } })
		).toThrow('absolute path');
	});

	// --- initializeBuiltins ---

	test('initializeBuiltins registers web-search-mcp skill', () => {
		mgr.initializeBuiltins();

		const skill = mgr.listSkills().find((s) => s.name === 'web-search-mcp');
		expect(skill).toBeDefined();
		expect(skill!.displayName).toBe('Web Search (MCP)');
		expect(skill!.sourceType).toBe('mcp_server');
		expect(skill!.builtIn).toBe(true);
		expect(skill!.enabled).toBe(false);
		expect(skill!.validationStatus).toBe('valid');
	});

	test('initializeBuiltins creates backing app_mcp_servers entry web-search-brave', () => {
		mgr.initializeBuiltins();

		const server = mcpRepo.getByName('web-search-brave');
		expect(server).not.toBeNull();
		expect(server!.command).toBe('npx');
		expect(server!.sourceType).toBe('stdio');
		expect(server!.args).toContain('@modelcontextprotocol/server-brave-search');
	});

	test('initializeBuiltins skill config references the app_mcp_servers entry', () => {
		mgr.initializeBuiltins();

		const skill = mgr.listSkills().find((s) => s.name === 'web-search-mcp');
		const server = mcpRepo.getByName('web-search-brave');
		expect(skill).toBeDefined();
		expect(server).not.toBeNull();
		expect(skill!.config.type).toBe('mcp_server');
		if (skill!.config.type === 'mcp_server') {
			expect(skill!.config.appMcpServerId).toBe(server!.id);
		}
	});

	test('initializeBuiltins is idempotent — does not create duplicates on second call', () => {
		mgr.initializeBuiltins();
		mgr.initializeBuiltins();

		const skills = mgr.listSkills().filter((s) => s.name === 'web-search-mcp');
		expect(skills).toHaveLength(1);

		const servers = mcpRepo.list().filter((s) => s.name === 'web-search-brave');
		expect(servers).toHaveLength(1);
	});

	test('initializeBuiltins web-search-mcp cannot be deleted (builtIn guard)', () => {
		mgr.initializeBuiltins();

		const skill = mgr.listSkills().find((s) => s.name === 'web-search-mcp');
		expect(skill).toBeDefined();
		expect(mgr.removeSkill(skill!.id)).toBe(false);
		expect(mgr.getSkill(skill!.id)).not.toBeNull();
	});

	test('initializeBuiltins web-search-mcp can be enabled via setSkillEnabled', () => {
		mgr.initializeBuiltins();

		const skill = mgr.listSkills().find((s) => s.name === 'web-search-mcp')!;
		expect(skill.enabled).toBe(false);

		const enabled = mgr.setSkillEnabled(skill.id, true);
		expect(enabled.enabled).toBe(true);

		// Verify getEnabledSkills now includes it
		const enabledSkills = mgr.getEnabledSkills();
		expect(enabledSkills.some((s) => s.name === 'web-search-mcp')).toBe(true);
	});

	test('initializeBuiltins web-search-mcp absent from getEnabledSkills when disabled', () => {
		mgr.initializeBuiltins();

		const enabledSkills = mgr.getEnabledSkills();
		expect(enabledSkills.some((s) => s.name === 'web-search-mcp')).toBe(false);
	});
});
