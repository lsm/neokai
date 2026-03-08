/**
 * Template RPC Handlers
 *
 * RPC handlers for session/room template operations:
 * - template.list - List templates (optionally filtered by scope)
 * - template.get - Get a single template
 * - template.create - Create a user template
 * - template.update - Update a user template
 * - template.delete - Delete a user template
 */

import type {
	MessageHub,
	TemplateScope,
	TemplateConfig,
	TemplateRoomConfig,
	SessionTemplateVariable,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import { TemplateRepository } from '../../storage/repositories/template-repository';
import { BUILT_IN_TEMPLATES } from '../templates/built-in-templates';

export function setupTemplateHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	db: Database
): void {
	const templateRepo = new TemplateRepository(db.getDatabase());

	// Seed built-in templates on startup
	for (const template of BUILT_IN_TEMPLATES) {
		templateRepo.createBuiltIn(template);
	}

	// template.list - List all templates
	messageHub.onRequest('template.list', async (data) => {
		const params = data as { scope?: TemplateScope } | undefined;
		const templates = templateRepo.listTemplates(params?.scope);
		return { templates };
	});

	// template.get - Get a single template
	messageHub.onRequest('template.get', async (data) => {
		const params = data as { templateId: string };
		if (!params.templateId) throw new Error('Template ID is required');

		const template = templateRepo.getTemplate(params.templateId);
		if (!template) throw new Error(`Template not found: ${params.templateId}`);

		return { template };
	});

	// template.create - Create a user template
	messageHub.onRequest('template.create', async (data) => {
		const params = data as {
			name: string;
			description?: string;
			scope: TemplateScope;
			config: TemplateConfig;
			roomConfig?: TemplateRoomConfig;
			variables?: SessionTemplateVariable[];
		};

		if (!params.name) throw new Error('Template name is required');
		if (!params.scope) throw new Error('Template scope is required');

		const template = templateRepo.createTemplate({
			name: params.name,
			description: params.description,
			scope: params.scope,
			config: params.config ?? {},
			roomConfig: params.roomConfig,
			variables: params.variables,
		});

		daemonHub.emit('template.created', { sessionId: 'global', template }).catch(() => {});

		return { template };
	});

	// template.update - Update a user template
	messageHub.onRequest('template.update', async (data) => {
		const params = data as {
			templateId: string;
			name?: string;
			description?: string;
			config?: TemplateConfig;
			roomConfig?: TemplateRoomConfig;
			variables?: SessionTemplateVariable[];
		};

		if (!params.templateId) throw new Error('Template ID is required');

		const template = templateRepo.updateTemplate(params.templateId, {
			name: params.name,
			description: params.description,
			config: params.config,
			roomConfig: params.roomConfig,
			variables: params.variables,
		});

		if (!template) throw new Error(`Template not found or is built-in: ${params.templateId}`);

		daemonHub.emit('template.updated', { sessionId: 'global', template }).catch(() => {});

		return { template };
	});

	// template.delete - Delete a user template
	messageHub.onRequest('template.delete', async (data) => {
		const params = data as { templateId: string };
		if (!params.templateId) throw new Error('Template ID is required');

		const deleted = templateRepo.deleteTemplate(params.templateId);
		if (!deleted) throw new Error(`Template not found or is built-in: ${params.templateId}`);

		daemonHub
			.emit('template.deleted', { sessionId: 'global', templateId: params.templateId })
			.catch(() => {});

		return { success: true };
	});
}
