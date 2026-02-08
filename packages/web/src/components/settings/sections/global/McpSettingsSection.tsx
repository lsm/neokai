/**
 * McpSettingsSection - MCP server settings
 *
 * Configure Model Context Protocol servers.
 *
 * TODO: Extract MCP server logic from GlobalSettingsEditor
 */

import type { GlobalSettings } from '@neokai/shared';

export interface McpSettingsSectionProps {
	settings: GlobalSettings | null;
}

export function McpSettingsSection({ settings }: McpSettingsSectionProps) {
	// Placeholder implementation - will be populated with MCP server logic from GlobalSettingsEditor
	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">MCP Servers</h3>
				<p class="text-sm text-gray-400">
					MCP server configuration will be migrated from the existing settings modal.
				</p>
				<p class="mt-2 text-xs text-gray-500">
					Current sources enabled: {settings?.settingSources.join(', ') ?? 'user, project, local'}
				</p>
			</div>
		</div>
	);
}
