/**
 * Prompt Template Manager
 *
 * Manages prompt templates for all rooms:
 * - Stores templates centrally
 * - Renders templates per-room with room context
 * - Tracks rendered prompts for each room
 * - Enables room agents to self-update prompts
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { DaemonHub } from '../daemon-hub';
import type {
	PromptTemplate,
	RenderedPrompt,
	RoomPromptContext,
	PromptTemplateCategory,
} from './types';
import { BUILTIN_TEMPLATES, getBuiltinTemplate } from './builtin-templates';
import { Logger } from '../logger';

const log = new Logger('prompt-template-manager');

/**
 * Simple mustache-like template renderer
 * Supports {{variable}}, {{#if var}}...{{/if}}, {{#each var}}...{{/each}}
 */
function renderTemplate(template: string, context: Record<string, unknown>): string {
	let result = template;

	// Handle #each blocks
	const eachRegex = /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
	result = result.replace(eachRegex, (_, arrayName: string, itemTemplate: string) => {
		const array = context[arrayName];
		if (!Array.isArray(array) || array.length === 0) {
			return '';
		}

		return array
			.map((item) => {
				let itemResult = itemTemplate;
				if (typeof item === 'object' && item !== null) {
					// Replace {{property}} with item.property
					for (const [key, value] of Object.entries(item)) {
						itemResult = itemResult.replace(
							new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
							String(value ?? '')
						);
					}
				} else {
					// Replace {{this}} with the item itself
					itemResult = itemResult.replace(/\{\{this\}\}/g, String(item));
				}
				return itemResult;
			})
			.join('');
	});

	// Handle #if blocks
	const ifRegex = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
	result = result.replace(ifRegex, (_, varName: string, content: string) => {
		const value = context[varName];
		if (value && (Array.isArray(value) ? value.length > 0 : true)) {
			return content;
		}
		return '';
	});

	// Replace simple variables
	result = result.replace(/\{\{(\w+)\}\}/g, (_, varName: string) => {
		const value = context[varName];
		if (value === undefined || value === null) {
			return '';
		}
		if (Array.isArray(value)) {
			return value.join(', ');
		}
		if (typeof value === 'object') {
			return JSON.stringify(value);
		}
		return String(value);
	});

	return result;
}

/**
 * Repository for prompt templates (stored in database for customization)
 */
class PromptTemplateRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Get a custom template (overrides built-in)
	 */
	getCustomTemplate(id: string): PromptTemplate | null {
		const stmt = this.db.prepare('SELECT * FROM prompt_templates WHERE id = ?');
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		return row ? this.rowToTemplate(row) : null;
	}

	/**
	 * Save a custom template
	 */
	saveCustomTemplate(template: PromptTemplate): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO prompt_templates
			(id, category, name, description, template, variables, version, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			template.id,
			template.category,
			template.name,
			template.description,
			template.template,
			JSON.stringify(template.variables),
			template.version,
			template.createdAt,
			template.updatedAt
		);
	}

	/**
	 * Get all custom templates
	 */
	getAllCustomTemplates(): PromptTemplate[] {
		const stmt = this.db.prepare('SELECT * FROM prompt_templates');
		const rows = stmt.all() as Record<string, unknown>[];
		return rows.map((r) => this.rowToTemplate(r));
	}

	/**
	 * Delete a custom template
	 */
	deleteCustomTemplate(id: string): boolean {
		const stmt = this.db.prepare('DELETE FROM prompt_templates WHERE id = ?');
		const result = stmt.run(id);
		return result.changes > 0;
	}

	private rowToTemplate(row: Record<string, unknown>): PromptTemplate {
		return {
			id: row.id as string,
			category: row.category as PromptTemplateCategory,
			name: row.name as string,
			description: row.description as string,
			template: row.template as string,
			variables: JSON.parse(row.variables as string),
			version: row.version as number,
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
		};
	}
}

/**
 * Repository for rendered prompts per room
 */
class RenderedPromptRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Get rendered prompt for a room
	 */
	getRenderedPrompt(roomId: string, templateId: string): RenderedPrompt | null {
		const stmt = this.db.prepare(
			'SELECT * FROM rendered_prompts WHERE room_id = ? AND template_id = ?'
		);
		const row = stmt.get(roomId, templateId) as Record<string, unknown> | undefined;
		return row ? this.rowToRenderedPrompt(row) : null;
	}

	/**
	 * Get all rendered prompts for a room
	 */
	getAllRenderedPrompts(roomId: string): RenderedPrompt[] {
		const stmt = this.db.prepare('SELECT * FROM rendered_prompts WHERE room_id = ?');
		const rows = stmt.all(roomId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToRenderedPrompt(r));
	}

	/**
	 * Save a rendered prompt
	 */
	saveRenderedPrompt(prompt: RenderedPrompt): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO rendered_prompts
			(id, template_id, room_id, content, rendered_with, template_version, rendered_at, customizations)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const id = `${prompt.roomId}:${prompt.templateId}`;
		stmt.run(
			id,
			prompt.templateId,
			prompt.roomId,
			prompt.content,
			JSON.stringify(prompt.renderedWith),
			prompt.templateVersion,
			prompt.renderedAt,
			prompt.customizations ?? null
		);
	}

	/**
	 * Delete all rendered prompts for a room
	 */
	deleteRenderedPrompts(roomId: string): void {
		const stmt = this.db.prepare('DELETE FROM rendered_prompts WHERE room_id = ?');
		stmt.run(roomId);
	}

	private rowToRenderedPrompt(row: Record<string, unknown>): RenderedPrompt {
		return {
			templateId: row.template_id as string,
			roomId: row.room_id as string,
			content: row.content as string,
			renderedWith: JSON.parse(row.rendered_with as string),
			templateVersion: row.template_version as number,
			renderedAt: row.rendered_at as number,
			customizations: row.customizations as string | undefined,
		};
	}
}

/**
 * Prompt Template Manager
 *
 * Manages templates and rendered prompts for all rooms.
 */
export class PromptTemplateManager {
	private templateRepo: PromptTemplateRepository;
	private renderedRepo: RenderedPromptRepository;

	constructor(
		private db: BunDatabase,
		private daemonHub?: DaemonHub
	) {
		this.templateRepo = new PromptTemplateRepository(db);
		this.renderedRepo = new RenderedPromptRepository(db);
	}

	/**
	 * Get a template (custom override or built-in)
	 */
	getTemplate(id: string): PromptTemplate | null {
		// Check for custom override first
		const custom = this.templateRepo.getCustomTemplate(id);
		if (custom) {
			return custom;
		}
		// Fall back to built-in
		return getBuiltinTemplate(id) ?? null;
	}

	/**
	 * Get all templates (custom + built-in, custom overrides built-in)
	 */
	getAllTemplates(): PromptTemplate[] {
		const customTemplates = this.templateRepo.getAllCustomTemplates();
		const customIds = new Set(customTemplates.map((t) => t.id));

		// Combine custom with built-in (excluding overridden)
		const builtins = BUILTIN_TEMPLATES.filter((t) => !customIds.has(t.id));
		return [...customTemplates, ...builtins];
	}

	/**
	 * Get templates by category
	 */
	getTemplatesByCategory(category: PromptTemplateCategory): PromptTemplate[] {
		return this.getAllTemplates().filter((t) => t.category === category);
	}

	/**
	 * Create or update a custom template
	 */
	async saveCustomTemplate(template: PromptTemplate): Promise<PromptTemplate> {
		const existing = this.getTemplate(template.id);
		const version = existing ? existing.version + 1 : 1;

		const updated: PromptTemplate = {
			...template,
			version,
			updatedAt: Date.now(),
			createdAt: existing?.createdAt ?? Date.now(),
		};

		this.templateRepo.saveCustomTemplate(updated);

		// Emit event
		if (this.daemonHub) {
			await this.daemonHub.emit('promptTemplate.updated', {
				sessionId: 'system',
				templateId: template.id,
				version: updated.version,
			});
		}

		log.info(`Saved custom template: ${template.id} v${updated.version}`);
		return updated;
	}

	/**
	 * Delete a custom template (reverts to built-in if exists)
	 */
	async deleteCustomTemplate(id: string): Promise<boolean> {
		const deleted = this.templateRepo.deleteCustomTemplate(id);

		if (deleted && this.daemonHub) {
			await this.daemonHub.emit('promptTemplate.deleted', {
				sessionId: 'system',
				templateId: id,
			});
		}

		log.info(`Deleted custom template: ${id}`);
		return deleted;
	}

	/**
	 * Render a template for a specific room
	 */
	renderTemplate(templateId: string, context: RoomPromptContext): RenderedPrompt | null {
		const template = this.getTemplate(templateId);
		if (!template) {
			log.warn(`Template not found: ${templateId}`);
			return null;
		}

		// Build render context from room context
		const renderContext: Record<string, unknown> = {
			...context,
			roomName: context.roomName,
			roomId: context.roomId,
			currentDate: context.currentDate,
		};

		// Render the template
		const content = renderTemplate(template.template, renderContext);

		const rendered: RenderedPrompt = {
			templateId,
			roomId: context.roomId,
			content,
			renderedWith: {
				roomName: context.roomName,
				currentDate: context.currentDate,
			},
			templateVersion: template.version,
			renderedAt: Date.now(),
		};

		// Save rendered prompt
		this.renderedRepo.saveRenderedPrompt(rendered);

		log.debug(`Rendered template ${templateId} for room ${context.roomId}`);
		return rendered;
	}

	/**
	 * Render all templates for a room (called at room creation)
	 */
	renderAllTemplatesForRoom(context: RoomPromptContext): RenderedPrompt[] {
		const templates = this.getAllTemplates();
		const rendered: RenderedPrompt[] = [];

		for (const template of templates) {
			const result = this.renderTemplate(template.id, context);
			if (result) {
				rendered.push(result);
			}
		}

		log.info(`Rendered ${rendered.length} templates for room ${context.roomId}`);
		return rendered;
	}

	/**
	 * Get rendered prompt for a room
	 */
	getRenderedPrompt(roomId: string, templateId: string): RenderedPrompt | null {
		return this.renderedRepo.getRenderedPrompt(roomId, templateId);
	}

	/**
	 * Get all rendered prompts for a room
	 */
	getAllRenderedPrompts(roomId: string): RenderedPrompt[] {
		return this.renderedRepo.getAllRenderedPrompts(roomId);
	}

	/**
	 * Re-render prompts for a room (called when room context changes)
	 */
	reRenderPromptsForRoom(context: RoomPromptContext): RenderedPrompt[] {
		// Delete old rendered prompts
		this.renderedRepo.deleteRenderedPrompts(context.roomId);

		// Re-render all
		return this.renderAllTemplatesForRoom(context);
	}

	/**
	 * Update a rendered prompt with customizations (room agent self-update)
	 */
	async updateRenderedPrompt(
		roomId: string,
		templateId: string,
		customizations: string
	): Promise<RenderedPrompt | null> {
		const existing = this.getRenderedPrompt(roomId, templateId);
		if (!existing) {
			log.warn(`No rendered prompt found for ${templateId} in room ${roomId}`);
			return null;
		}

		const updated: RenderedPrompt = {
			...existing,
			content: customizations,
			customizations,
			renderedAt: Date.now(),
		};

		this.renderedRepo.saveRenderedPrompt(updated);

		// Emit event
		if (this.daemonHub) {
			await this.daemonHub.emit('promptTemplate.roomUpdated', {
				sessionId: `room:${roomId}`,
				roomId,
				templateId,
			});
		}

		log.info(`Updated rendered prompt ${templateId} for room ${roomId}`);
		return updated;
	}

	/**
	 * Check if rendered prompts need updating (template version changed)
	 */
	checkForUpdates(
		roomId: string
	): Array<{ templateId: string; currentVersion: number; latestVersion: number }> {
		const rendered = this.getAllRenderedPrompts(roomId);
		const updates: Array<{ templateId: string; currentVersion: number; latestVersion: number }> =
			[];

		for (const r of rendered) {
			const template = this.getTemplate(r.templateId);
			if (template && template.version > r.templateVersion) {
				updates.push({
					templateId: r.templateId,
					currentVersion: r.templateVersion,
					latestVersion: template.version,
				});
			}
		}

		return updates;
	}
}
