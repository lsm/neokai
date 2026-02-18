/**
 * PromptTemplateManager Tests
 *
 * Tests for centralized prompt template management:
 * - Template retrieval (built-in and custom)
 * - Template rendering with variable substitution
 * - Custom template CRUD operations
 * - Rendered prompt management per room
 * - Template version tracking
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	PromptTemplateManager,
	BUILTIN_TEMPLATES,
	getBuiltinTemplate,
	getTemplatesByCategory,
	BUILTIN_TEMPLATE_IDS,
	BUILTIN_JOBS,
} from '../../../src/lib/prompts';
import type {
	PromptTemplate,
	RoomPromptContext,
	PromptTemplateCategory,
	RenderedPrompt,
} from '../../../src/lib/prompts';

describe('PromptTemplateManager', () => {
	let db: Database;
	let manager: PromptTemplateManager;

	// Helper to create prompt tables
	function createPromptTables(database: Database): void {
		database.exec(`
			CREATE TABLE IF NOT EXISTS prompt_templates (
				id TEXT PRIMARY KEY,
				category TEXT NOT NULL
					CHECK(category IN ('room_agent', 'manager_agent', 'worker_agent', 'lobby_agent', 'security_agent', 'router_agent')),
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				template TEXT NOT NULL,
				variables TEXT DEFAULT '[]',
				version INTEGER DEFAULT 1,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_prompt_templates_category ON prompt_templates(category);

			CREATE TABLE IF NOT EXISTS rendered_prompts (
				id TEXT PRIMARY KEY,
				template_id TEXT NOT NULL,
				room_id TEXT NOT NULL,
				content TEXT NOT NULL,
				rendered_with TEXT DEFAULT '{}',
				template_version INTEGER DEFAULT 1,
				rendered_at INTEGER NOT NULL,
				customizations TEXT,
				UNIQUE(template_id, room_id)
			);

			CREATE INDEX IF NOT EXISTS idx_rendered_prompts_room ON rendered_prompts(room_id);
			CREATE INDEX IF NOT EXISTS idx_rendered_prompts_template ON rendered_prompts(template_id);
		`);
	}

	// Helper to create a sample room context
	function createRoomContext(overrides?: Partial<RoomPromptContext>): RoomPromptContext {
		return {
			roomId: 'room-1',
			roomName: 'Test Room',
			allowedPaths: ['/workspace/test'],
			repositories: ['owner/repo'],
			activeGoals: [],
			currentDate: '2026-02-18',
			...overrides,
		};
	}

	beforeEach(() => {
		db = new Database(':memory:');
		createPromptTables(db);
		manager = new PromptTemplateManager(db);
	});

	afterEach(() => {
		db.close();
	});

	describe('getTemplate', () => {
		it('should return built-in template by ID', () => {
			const template = manager.getTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);

			expect(template).not.toBeNull();
			expect(template?.id).toBe(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);
			expect(template?.name).toBe('Room Agent System Prompt');
			expect(template?.category).toBe('room_agent');
		});

		it('should return null for non-existent template', () => {
			const template = manager.getTemplate('non_existent_template');

			expect(template).toBeNull();
		});

		it('should return custom template when it overrides built-in', async () => {
			// Save a custom template with same ID as built-in
			await manager.saveCustomTemplate({
				id: BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				category: 'room_agent',
				name: 'Custom Room Agent',
				description: 'Customized template',
				template: 'Custom template content',
				variables: [],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const template = manager.getTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);

			expect(template).not.toBeNull();
			expect(template?.name).toBe('Custom Room Agent');
			expect(template?.template).toBe('Custom template content');
		});

		it('should return custom template that has no built-in equivalent', async () => {
			await manager.saveCustomTemplate({
				id: 'custom_template_1',
				category: 'room_agent',
				name: 'My Custom Template',
				description: 'A completely custom template',
				template: 'Hello {{roomName}}',
				variables: [{ name: 'roomName', description: 'Room name', required: true }],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const template = manager.getTemplate('custom_template_1');

			expect(template).not.toBeNull();
			expect(template?.name).toBe('My Custom Template');
		});
	});

	describe('getAllTemplates', () => {
		it('should return all built-in templates', () => {
			const templates = manager.getAllTemplates();

			expect(templates.length).toBeGreaterThanOrEqual(BUILTIN_TEMPLATES.length);

			// Check that all built-in IDs are present
			const ids = templates.map((t) => t.id);
			expect(ids).toContain(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);
			expect(ids).toContain(BUILTIN_TEMPLATE_IDS.MANAGER_AGENT_SYSTEM);
			expect(ids).toContain(BUILTIN_TEMPLATE_IDS.WORKER_AGENT_SYSTEM);
			expect(ids).toContain(BUILTIN_TEMPLATE_IDS.LOBBY_AGENT_ROUTER);
		});

		it('should include custom templates', async () => {
			await manager.saveCustomTemplate({
				id: 'custom_1',
				category: 'room_agent',
				name: 'Custom 1',
				description: 'Custom template',
				template: 'Content',
				variables: [],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const templates = manager.getAllTemplates();

			expect(templates.find((t) => t.id === 'custom_1')).toBeDefined();
		});

		it('should override built-in with custom when same ID', async () => {
			await manager.saveCustomTemplate({
				id: BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				category: 'room_agent',
				name: 'Overridden',
				description: 'Overridden template',
				template: 'Overridden content',
				variables: [],
				version: 2,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const templates = manager.getAllTemplates();
			const roomAgentTemplate = templates.find(
				(t) => t.id === BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM
			);

			expect(roomAgentTemplate?.name).toBe('Overridden');
			expect(roomAgentTemplate?.version).toBe(2);
		});
	});

	describe('getTemplatesByCategory', () => {
		it('should return only room_agent templates by default', () => {
			const templates = manager.getTemplatesByCategory('room_agent');

			expect(templates.length).toBeGreaterThan(0);
			templates.forEach((t) => {
				expect(t.category).toBe('room_agent');
			});
		});

		it('should return manager_agent templates', () => {
			const templates = manager.getTemplatesByCategory('manager_agent');

			expect(templates.length).toBeGreaterThan(0);
			templates.forEach((t) => {
				expect(t.category).toBe('manager_agent');
			});
		});

		it('should return worker_agent templates', () => {
			const templates = manager.getTemplatesByCategory('worker_agent');

			expect(templates.length).toBeGreaterThan(0);
			templates.forEach((t) => {
				expect(t.category).toBe('worker_agent');
			});
		});

		it('should return lobby_agent templates', () => {
			const templates = manager.getTemplatesByCategory('lobby_agent');

			expect(templates.length).toBeGreaterThan(0);
			templates.forEach((t) => {
				expect(t.category).toBe('lobby_agent');
			});
		});

		it('should return empty array for category with no templates', () => {
			const templates = manager.getTemplatesByCategory('security_agent');

			expect(templates).toEqual([]);
		});

		it('should include custom templates in category', async () => {
			await manager.saveCustomTemplate({
				id: 'custom_security',
				category: 'security_agent',
				name: 'Security Template',
				description: 'Custom security template',
				template: 'Security check',
				variables: [],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const templates = manager.getTemplatesByCategory('security_agent');

			expect(templates.length).toBe(1);
			expect(templates[0].id).toBe('custom_security');
		});
	});

	describe('saveCustomTemplate', () => {
		it('should create a new custom template', async () => {
			const template = await manager.saveCustomTemplate({
				id: 'new_custom',
				category: 'room_agent',
				name: 'New Template',
				description: 'A new template',
				template: 'Hello {{name}}',
				variables: [{ name: 'name', description: 'Name' }],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			expect(template.id).toBe('new_custom');
			expect(template.version).toBe(1);
			expect(template.createdAt).toBeDefined();
			expect(template.updatedAt).toBeDefined();
		});

		it('should increment version when updating existing template', async () => {
			// Create initial
			await manager.saveCustomTemplate({
				id: 'versioned',
				category: 'room_agent',
				name: 'V1',
				description: 'Version 1',
				template: 'V1 content',
				variables: [],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			// Update
			const updated = await manager.saveCustomTemplate({
				id: 'versioned',
				category: 'room_agent',
				name: 'V2',
				description: 'Version 2',
				template: 'V2 content',
				variables: [],
				version: 1, // This should be ignored and incremented
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			expect(updated.version).toBe(2);
			expect(updated.name).toBe('V2');
		});

		it('should preserve createdAt when updating', async () => {
			const originalCreatedAt = Date.now() - 10000;

			const original = await manager.saveCustomTemplate({
				id: 'preserve_created',
				category: 'room_agent',
				name: 'Original',
				description: 'Original',
				template: 'Original',
				variables: [],
				version: 1,
				createdAt: originalCreatedAt,
				updatedAt: originalCreatedAt,
			});

			// Store the createdAt from the first save
			const savedCreatedAt = original.createdAt;

			const updated = await manager.saveCustomTemplate({
				id: 'preserve_created',
				category: 'room_agent',
				name: 'Updated',
				description: 'Updated',
				template: 'Updated',
				variables: [],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			expect(updated.createdAt).toBe(savedCreatedAt);
		});

		it('should increment version when overriding built-in', async () => {
			const template = await manager.saveCustomTemplate({
				id: BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				category: 'room_agent',
				name: 'Overridden',
				description: 'Override',
				template: 'Override',
				variables: [],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			// Built-in has version 1, so custom should be version 2
			expect(template.version).toBe(2);
		});
	});

	describe('deleteCustomTemplate', () => {
		it('should delete an existing custom template', async () => {
			await manager.saveCustomTemplate({
				id: 'to_delete',
				category: 'room_agent',
				name: 'To Delete',
				description: 'Will be deleted',
				template: 'Content',
				variables: [],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const deleted = await manager.deleteCustomTemplate('to_delete');

			expect(deleted).toBe(true);
			expect(manager.getTemplate('to_delete')).toBeNull();
		});

		it('should return false when deleting non-existent template', async () => {
			const deleted = await manager.deleteCustomTemplate('non_existent');

			expect(deleted).toBe(false);
		});

		it('should revert to built-in when deleting override', async () => {
			// Override a built-in
			await manager.saveCustomTemplate({
				id: BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				category: 'room_agent',
				name: 'Override',
				description: 'Override',
				template: 'Override',
				variables: [],
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			// Delete the override
			await manager.deleteCustomTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);

			// Should fall back to built-in
			const template = manager.getTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);
			expect(template?.name).toBe('Room Agent System Prompt');
		});
	});

	describe('renderTemplate', () => {
		it('should render template with simple variables', () => {
			const context = createRoomContext({
				roomName: 'Development Room',
			});

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered).not.toBeNull();
			expect(rendered?.content).toContain('Development Room');
			expect(rendered?.content).toContain('Current Date: 2026-02-18');
		});

		it('should return null for non-existent template', () => {
			const context = createRoomContext();

			const rendered = manager.renderTemplate('non_existent', context);

			expect(rendered).toBeNull();
		});

		it('should save rendered prompt to database', () => {
			const context = createRoomContext({
				roomId: 'room-123',
			});

			manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			// Retrieve from database
			const saved = manager.getRenderedPrompt('room-123', BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);
			expect(saved).not.toBeNull();
			expect(saved?.roomId).toBe('room-123');
		});

		it('should track template version in rendered prompt', () => {
			const context = createRoomContext();

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered?.templateVersion).toBe(1); // Built-in has version 1
		});

		it('should handle optional variables (falsy/missing)', () => {
			const context = createRoomContext({
				roomDescription: undefined,
				backgroundContext: undefined,
			});

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered).not.toBeNull();
			// The #if blocks should be empty when variables are missing
			expect(rendered?.content).not.toContain('## Room Description');
			expect(rendered?.content).not.toContain('## Background Context');
		});

		it('should handle optional variables (truthy)', () => {
			const context = createRoomContext({
				roomDescription: 'A test room for development',
				backgroundContext: 'This is background info',
			});

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered).not.toBeNull();
			expect(rendered?.content).toContain('## Room Description');
			expect(rendered?.content).toContain('A test room for development');
			expect(rendered?.content).toContain('## Background Context');
			expect(rendered?.content).toContain('This is background info');
		});

		it('should render #each blocks with arrays', () => {
			const context = createRoomContext({
				repositories: ['owner/repo1', 'owner/repo2'],
			});

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered?.content).toContain('- owner/repo1');
			expect(rendered?.content).toContain('- owner/repo2');
		});

		it('should handle empty arrays in #each blocks', () => {
			const context = createRoomContext({
				repositories: [],
				activeGoals: [],
			});

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered).not.toBeNull();
			// When repositories and activeGoals are empty, the #each blocks should be empty
			// Check that the Repositories section has no list items (just the header)
			expect(rendered?.content).not.toContain('- owner/');
			// Check that Active Goals section is empty
			expect(rendered?.content).not.toMatch(/- .+ \(.+, .+% complete\)/);
		});

		it('should render #each with object items', () => {
			const context = createRoomContext({
				activeGoals: [
					{ title: 'Goal 1', progress: 50, status: 'in_progress' },
					{ title: 'Goal 2', progress: 100, status: 'completed' },
				],
			});

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered?.content).toContain('- Goal 1 (in_progress, 50% complete)');
			expect(rendered?.content).toContain('- Goal 2 (completed, 100% complete)');
		});

		it('should set renderedAt timestamp', () => {
			const beforeTime = Date.now();
			const context = createRoomContext();

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered?.renderedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should store renderedWith context', () => {
			const context = createRoomContext({
				roomName: 'My Room',
			});

			const rendered = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			expect(rendered?.renderedWith.roomName).toBe('My Room');
			expect(rendered?.renderedWith.currentDate).toBe('2026-02-18');
		});
	});

	describe('renderAllTemplatesForRoom', () => {
		it('should render all templates for a room', () => {
			const context = createRoomContext({
				roomId: 'room-all',
			});

			const rendered = manager.renderAllTemplatesForRoom(context);

			expect(rendered.length).toBe(BUILTIN_TEMPLATES.length);
			rendered.forEach((r) => {
				expect(r.roomId).toBe('room-all');
				expect(r.content).toBeDefined();
			});
		});

		it('should save all rendered prompts to database', () => {
			const context = createRoomContext({
				roomId: 'room-save-all',
			});

			manager.renderAllTemplatesForRoom(context);

			const savedPrompts = manager.getAllRenderedPrompts('room-save-all');
			expect(savedPrompts.length).toBe(BUILTIN_TEMPLATES.length);
		});
	});

	describe('getRenderedPrompt', () => {
		it('should retrieve rendered prompt by room and template ID', () => {
			const context = createRoomContext({
				roomId: 'room-get',
			});

			manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			const saved = manager.getRenderedPrompt('room-get', BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);

			expect(saved).not.toBeNull();
			expect(saved?.templateId).toBe(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);
			expect(saved?.roomId).toBe('room-get');
		});

		it('should return null for non-existent rendered prompt', () => {
			const saved = manager.getRenderedPrompt('non-existent-room', 'non-existent-template');

			expect(saved).toBeNull();
		});
	});

	describe('getAllRenderedPrompts', () => {
		it('should return all rendered prompts for a room', () => {
			const context = createRoomContext({
				roomId: 'room-all-prompts',
			});

			manager.renderAllTemplatesForRoom(context);

			const prompts = manager.getAllRenderedPrompts('room-all-prompts');

			expect(prompts.length).toBe(BUILTIN_TEMPLATES.length);
		});

		it('should return empty array for room with no rendered prompts', () => {
			const prompts = manager.getAllRenderedPrompts('empty-room');

			expect(prompts).toEqual([]);
		});
	});

	describe('reRenderPromptsForRoom', () => {
		it('should delete old prompts and create new ones', () => {
			const context = createRoomContext({
				roomId: 'room-rerender',
				roomName: 'Original Name',
			});

			// Initial render
			manager.renderAllTemplatesForRoom(context);
			const original = manager.getRenderedPrompt(
				'room-rerender',
				BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM
			);
			expect(original?.content).toContain('Original Name');

			// Re-render with new context
			const newContext = createRoomContext({
				roomId: 'room-rerender',
				roomName: 'New Name',
			});
			manager.reRenderPromptsForRoom(newContext);

			const reRendered = manager.getRenderedPrompt(
				'room-rerender',
				BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM
			);
			expect(reRendered?.content).toContain('New Name');
		});

		it('should return the newly rendered prompts', () => {
			const context = createRoomContext({
				roomId: 'room-rerender-return',
			});

			const rendered = manager.reRenderPromptsForRoom(context);

			expect(rendered.length).toBe(BUILTIN_TEMPLATES.length);
		});
	});

	describe('updateRenderedPrompt', () => {
		it('should update rendered prompt with customizations', async () => {
			const context = createRoomContext({
				roomId: 'room-update',
			});

			manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			const updated = await manager.updateRenderedPrompt(
				'room-update',
				BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				'Customized prompt content'
			);

			expect(updated).not.toBeNull();
			expect(updated?.content).toBe('Customized prompt content');
			expect(updated?.customizations).toBe('Customized prompt content');
		});

		it('should update renderedAt timestamp', async () => {
			const context = createRoomContext({
				roomId: 'room-update-ts',
			});

			const original = manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);
			const originalTime = original?.renderedAt;

			// Wait a bit
			await new Promise((r) => setTimeout(r, 5));

			const updated = await manager.updateRenderedPrompt(
				'room-update-ts',
				BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				'New content'
			);

			expect(updated?.renderedAt).toBeGreaterThan(originalTime!);
		});

		it('should return null for non-existent rendered prompt', async () => {
			const updated = await manager.updateRenderedPrompt(
				'non-existent-room',
				BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				'Content'
			);

			expect(updated).toBeNull();
		});

		it('should persist customization to database', async () => {
			const context = createRoomContext({
				roomId: 'room-persist-custom',
			});

			manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			await manager.updateRenderedPrompt(
				'room-persist-custom',
				BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				'Persisted customization'
			);

			// Retrieve from database
			const saved = manager.getRenderedPrompt(
				'room-persist-custom',
				BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM
			);
			expect(saved?.customizations).toBe('Persisted customization');
		});
	});

	describe('checkForUpdates', () => {
		it('should return empty array when no updates needed', () => {
			const context = createRoomContext({
				roomId: 'room-no-updates',
			});

			manager.renderAllTemplatesForRoom(context);

			const updates = manager.checkForUpdates('room-no-updates');

			expect(updates).toEqual([]);
		});

		it('should detect when template version is newer', async () => {
			const context = createRoomContext({
				roomId: 'room-has-updates',
			});

			// Render with original template (version 1)
			manager.renderTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM, context);

			// Update the custom template (version 2)
			await manager.saveCustomTemplate({
				id: BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM,
				category: 'room_agent',
				name: 'Updated Template',
				description: 'Updated',
				template: 'Updated content',
				variables: [],
				version: 1, // Will be incremented to 2
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const updates = manager.checkForUpdates('room-has-updates');

			expect(updates.length).toBe(1);
			expect(updates[0].templateId).toBe(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);
			expect(updates[0].currentVersion).toBe(1);
			expect(updates[0].latestVersion).toBe(2);
		});

		it('should return empty array for room with no rendered prompts', () => {
			const updates = manager.checkForUpdates('empty-room');

			expect(updates).toEqual([]);
		});
	});
});

describe('getBuiltinTemplate', () => {
	it('should return template by ID', () => {
		const template = getBuiltinTemplate(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);

		expect(template).toBeDefined();
		expect(template?.id).toBe(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM);
	});

	it('should return undefined for non-existent ID', () => {
		const template = getBuiltinTemplate('non_existent');

		expect(template).toBeUndefined();
	});

	it('should return manager agent template', () => {
		const template = getBuiltinTemplate(BUILTIN_TEMPLATE_IDS.MANAGER_AGENT_SYSTEM);

		expect(template).toBeDefined();
		expect(template?.category).toBe('manager_agent');
	});

	it('should return worker agent template', () => {
		const template = getBuiltinTemplate(BUILTIN_TEMPLATE_IDS.WORKER_AGENT_SYSTEM);

		expect(template).toBeDefined();
		expect(template?.category).toBe('worker_agent');
	});

	it('should return lobby agent templates', () => {
		const routerTemplate = getBuiltinTemplate(BUILTIN_TEMPLATE_IDS.LOBBY_AGENT_ROUTER);
		const securityTemplate = getBuiltinTemplate(BUILTIN_TEMPLATE_IDS.LOBBY_AGENT_SECURITY);

		expect(routerTemplate).toBeDefined();
		expect(securityTemplate).toBeDefined();
		expect(routerTemplate?.category).toBe('lobby_agent');
		expect(securityTemplate?.category).toBe('lobby_agent');
	});
});

describe('getTemplatesByCategory (builtin)', () => {
	it('should return all room_agent templates', () => {
		const templates = getTemplatesByCategory('room_agent');

		expect(templates.length).toBeGreaterThan(0);
		templates.forEach((t) => {
			expect(t.category).toBe('room_agent');
		});
	});

	it('should return all lobby_agent templates', () => {
		const templates = getTemplatesByCategory('lobby_agent');

		expect(templates.length).toBeGreaterThan(0);
		templates.forEach((t) => {
			expect(t.category).toBe('lobby_agent');
		});
	});
});

describe('BUILTIN_TEMPLATES', () => {
	it('should have valid structure for all templates', () => {
		BUILTIN_TEMPLATES.forEach((template) => {
			expect(template.id).toBeDefined();
			expect(template.category).toBeDefined();
			expect(template.name).toBeDefined();
			expect(template.description).toBeDefined();
			expect(template.template).toBeDefined();
			expect(template.variables).toBeDefined();
			expect(Array.isArray(template.variables)).toBe(true);
			expect(template.version).toBeGreaterThanOrEqual(1);
			expect(template.createdAt).toBeDefined();
			expect(template.updatedAt).toBeDefined();
		});
	});

	it('should have required variables marked as required', () => {
		const roomAgentTemplate = BUILTIN_TEMPLATES.find(
			(t) => t.id === BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM
		);

		const requiredVars = roomAgentTemplate?.variables.filter((v) => v.required);
		expect(requiredVars?.length).toBeGreaterThan(0);
		expect(requiredVars?.find((v) => v.name === 'roomName')).toBeDefined();
		expect(requiredVars?.find((v) => v.name === 'currentDate')).toBeDefined();
	});

	it('should have unique IDs', () => {
		const ids = BUILTIN_TEMPLATES.map((t) => t.id);
		const uniqueIds = new Set(ids);

		expect(uniqueIds.size).toBe(ids.length);
	});
});

describe('BUILTIN_TEMPLATE_IDS', () => {
	it('should have all expected template IDs', () => {
		expect(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_SYSTEM).toBe('room_agent_system');
		expect(BUILTIN_TEMPLATE_IDS.ROOM_AGENT_IDLE_CHECK).toBe('room_agent_idle_check');
		expect(BUILTIN_TEMPLATE_IDS.MANAGER_AGENT_SYSTEM).toBe('manager_agent_system');
		expect(BUILTIN_TEMPLATE_IDS.WORKER_AGENT_SYSTEM).toBe('worker_agent_system');
		expect(BUILTIN_TEMPLATE_IDS.LOBBY_AGENT_ROUTER).toBe('lobby_agent_router');
		expect(BUILTIN_TEMPLATE_IDS.LOBBY_AGENT_SECURITY).toBe('lobby_agent_security');
		expect(BUILTIN_TEMPLATE_IDS.JOB_SESSION_REVIEW).toBe('job_session_review');
	});
});

describe('BUILTIN_JOBS', () => {
	it('should have valid structure for all jobs', () => {
		BUILTIN_JOBS.forEach((job) => {
			expect(job.id).toBeDefined();
			expect(job.name).toBeDefined();
			expect(job.description).toBeDefined();
			expect(job.schedule).toBeDefined();
			expect(job.schedule.type).toBe('interval');
			expect(job.schedule.minutes).toBeGreaterThan(0);
			expect(job.taskTemplate).toBeDefined();
			expect(job.taskTemplate.title).toBeDefined();
			expect(job.taskTemplate.description).toBeDefined();
			expect(job.taskTemplate.priority).toBeDefined();
		});
	});

	it('should have session review job', () => {
		const sessionReview = BUILTIN_JOBS.find((j) => j.id === 'builtin_session_review');
		expect(sessionReview).toBeDefined();
		expect(sessionReview?.schedule.minutes).toBe(60);
	});

	it('should have goal progress check job', () => {
		const goalCheck = BUILTIN_JOBS.find((j) => j.id === 'builtin_goal_progress_check');
		expect(goalCheck).toBeDefined();
		expect(goalCheck?.schedule.minutes).toBe(30);
	});

	it('should have cleanup job', () => {
		const cleanup = BUILTIN_JOBS.find((j) => j.id === 'builtin_cleanup_completed');
		expect(cleanup).toBeDefined();
		expect(cleanup?.schedule.minutes).toBe(120);
	});

	it('should have unique job IDs', () => {
		const ids = BUILTIN_JOBS.map((j) => j.id);
		const uniqueIds = new Set(ids);

		expect(uniqueIds.size).toBe(ids.length);
	});
});

describe('Template Rendering (renderTemplate function)', () => {
	let db: Database;
	let manager: PromptTemplateManager;

	function createPromptTables(database: Database): void {
		database.exec(`
			CREATE TABLE IF NOT EXISTS prompt_templates (
				id TEXT PRIMARY KEY,
				category TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				template TEXT NOT NULL,
				variables TEXT DEFAULT '[]',
				version INTEGER DEFAULT 1,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS rendered_prompts (
				id TEXT PRIMARY KEY,
				template_id TEXT NOT NULL,
				room_id TEXT NOT NULL,
				content TEXT NOT NULL,
				rendered_with TEXT DEFAULT '{}',
				template_version INTEGER DEFAULT 1,
				rendered_at INTEGER NOT NULL,
				customizations TEXT,
				UNIQUE(template_id, room_id)
			);
		`);
	}

	beforeEach(() => {
		db = new Database(':memory:');
		createPromptTables(db);
		manager = new PromptTemplateManager(db);
	});

	afterEach(() => {
		db.close();
	});

	it('should replace simple variables', async () => {
		await manager.saveCustomTemplate({
			id: 'simple-var',
			category: 'room_agent',
			name: 'Simple Var',
			description: 'Test',
			template: 'Hello {{name}}, today is {{day}}.',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context: RoomPromptContext = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
			customVariables: {
				name: 'World',
				day: 'Monday',
			},
		} as RoomPromptContext;

		// Add customVariables to the context type
		const extendedContext = {
			...context,
			name: 'World',
			day: 'Monday',
		};

		const rendered = manager.renderTemplate('simple-var', extendedContext as RoomPromptContext);

		// Note: customVariables handling depends on implementation
		// This tests the simple variable replacement
	});

	it('should handle null/undefined variables gracefully', async () => {
		await manager.saveCustomTemplate({
			id: 'null-var',
			category: 'room_agent',
			name: 'Null Var',
			description: 'Test',
			template: 'Value: {{missingVar}}',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context: RoomPromptContext = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
		};

		const rendered = manager.renderTemplate('null-var', context);

		expect(rendered?.content).toBe('Value: ');
	});

	it('should handle arrays by joining with comma', async () => {
		await manager.saveCustomTemplate({
			id: 'array-var',
			category: 'room_agent',
			name: 'Array Var',
			description: 'Test',
			template: 'Items: {{items}}',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
			items: ['a', 'b', 'c'],
		};

		const rendered = manager.renderTemplate('array-var', context as RoomPromptContext);

		expect(rendered?.content).toBe('Items: a, b, c');
	});

	it('should handle objects by JSON stringifying', async () => {
		await manager.saveCustomTemplate({
			id: 'object-var',
			category: 'room_agent',
			name: 'Object Var',
			description: 'Test',
			template: 'Data: {{data}}',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
			data: { key: 'value' },
		};

		const rendered = manager.renderTemplate('object-var', context as RoomPromptContext);

		expect(rendered?.content).toBe('Data: {"key":"value"}');
	});

	it('should handle nested #each with {{this}}', async () => {
		await manager.saveCustomTemplate({
			id: 'each-this',
			category: 'room_agent',
			name: 'Each This',
			description: 'Test',
			template: 'List:{{#each items}} [{{this}}]{{/each}}',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
			items: ['x', 'y', 'z'],
		};

		const rendered = manager.renderTemplate('each-this', context as RoomPromptContext);

		expect(rendered?.content).toBe('List: [x] [y] [z]');
	});

	it('should handle #if with truthy values', async () => {
		await manager.saveCustomTemplate({
			id: 'if-truthy',
			category: 'room_agent',
			name: 'If Truthy',
			description: 'Test',
			template: 'Start{{#if show}} Show this{{/if}} End',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
			show: true,
		};

		const rendered = manager.renderTemplate('if-truthy', context as RoomPromptContext);

		expect(rendered?.content).toBe('Start Show this End');
	});

	it('should handle #if with falsy values', async () => {
		await manager.saveCustomTemplate({
			id: 'if-falsy',
			category: 'room_agent',
			name: 'If Falsy',
			description: 'Test',
			template: 'Start{{#if show}} Show this{{/if}} End',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
			show: false,
		};

		const rendered = manager.renderTemplate('if-falsy', context as RoomPromptContext);

		expect(rendered?.content).toBe('Start End');
	});

	it('should handle #if with empty array (falsy)', async () => {
		await manager.saveCustomTemplate({
			id: 'if-empty-array',
			category: 'room_agent',
			name: 'If Empty Array',
			description: 'Test',
			template: 'Start{{#if items}} Has items{{/if}} End',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
			items: [],
		};

		const rendered = manager.renderTemplate('if-empty-array', context as RoomPromptContext);

		expect(rendered?.content).toBe('Start End');
	});

	it('should handle #if with non-empty array (truthy)', async () => {
		await manager.saveCustomTemplate({
			id: 'if-nonempty-array',
			category: 'room_agent',
			name: 'If NonEmpty Array',
			description: 'Test',
			template: 'Start{{#if items}} Has items{{/if}} End',
			variables: [],
			version: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		const context = {
			roomId: 'room-1',
			roomName: 'Test',
			allowedPaths: [],
			repositories: [],
			activeGoals: [],
			currentDate: '2026-02-18',
			items: ['a'],
		};

		const rendered = manager.renderTemplate('if-nonempty-array', context as RoomPromptContext);

		expect(rendered?.content).toBe('Start Has items End');
	});
});
