/**
 * Settings sections definitions for global and session settings pages
 *
 * This module defines the structure and metadata for all settings sections,
 * providing a centralized configuration that enables easy extensibility.
 */

/**
 * Settings section metadata
 */
export interface SettingsSection {
	id: string;
	label: string;
	icon: SettingsIcon;
	description: string;
	order: number;
}

/**
 * Available icons for settings sections
 */
export type SettingsIcon =
	| 'cog'
	| 'user'
	| 'cpu'
	| 'shield'
	| 'brain'
	| 'layout'
	| 'layers'
	| 'server'
	| 'wrench'
	| 'sliders';

/**
 * Global settings sections
 *
 * These sections appear in the global settings page at /settings
 */
export const GLOBAL_SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{
		id: 'general',
		label: 'General',
		icon: 'cog',
		description: 'Basic application settings',
		order: 0,
	},
	{
		id: 'authentication',
		label: 'Authentication',
		icon: 'user',
		description: 'API keys and OAuth credentials',
		order: 1,
	},
	{
		id: 'model',
		label: 'Model',
		icon: 'cpu',
		description: 'Claude model selection',
		order: 2,
	},
	{
		id: 'permissions',
		label: 'Permissions',
		icon: 'shield',
		description: 'Permission modes and security',
		order: 3,
	},
	{
		id: 'thinking',
		label: 'Thinking',
		icon: 'brain',
		description: 'Thinking budget and level',
		order: 4,
	},
	{
		id: 'ui',
		label: 'Interface',
		icon: 'layout',
		description: 'UI preferences (auto-scroll, coordinator mode)',
		order: 5,
	},
	{
		id: 'sources',
		label: 'Setting Sources',
		icon: 'layers',
		description: 'Configure settings file sources',
		order: 6,
	},
	{
		id: 'mcp',
		label: 'MCP Servers',
		icon: 'server',
		description: 'Model Context Protocol servers',
		order: 7,
	},
	{
		id: 'tools',
		label: 'Tools',
		icon: 'wrench',
		description: 'Global tool permissions and defaults',
		order: 8,
	},
	{
		id: 'output-limiter',
		label: 'Output Limiter',
		icon: 'sliders',
		description: 'Configure tool output limits',
		order: 9,
	},
] as const;

/**
 * Session settings sections
 *
 * These sections appear in the session settings page at /session/:id/settings
 */
export const SESSION_SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{
		id: 'general',
		label: 'General',
		icon: 'cog',
		description: 'Session-specific settings',
		order: 0,
	},
	{
		id: 'tools',
		label: 'Tools',
		icon: 'wrench',
		description: 'Tool configuration for this session',
		order: 1,
	},
	{
		id: 'mcp',
		label: 'MCP Servers',
		icon: 'server',
		description: 'MCP servers for this session',
		order: 2,
	},
] as const;
