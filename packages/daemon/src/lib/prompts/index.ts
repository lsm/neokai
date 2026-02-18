/**
 * Prompt Package
 *
 * Centralized prompt template management for NeoKai:
 * - Types for templates and rendered prompts
 * - Built-in templates for all agent types
 * - PromptTemplateManager for template lifecycle
 */

export { PromptTemplateManager } from './prompt-template-manager';
export { BUILTIN_TEMPLATES, getBuiltinTemplate, getTemplatesByCategory } from './builtin-templates';
export type {
	PromptTemplate,
	RenderedPrompt,
	RoomPromptContext,
	TemplateVariable,
	PromptTemplateCategory,
	BuiltinJobDefinition,
} from './types';
export { BUILTIN_TEMPLATE_IDS, BUILTIN_JOBS } from './types';
