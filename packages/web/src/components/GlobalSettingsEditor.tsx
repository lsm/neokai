import { useState, useEffect } from 'preact/hooks';
import type { PermissionMode, SettingSource } from '@liuboer/shared';
import { toast } from '../lib/toast.ts';
import {
	updateGlobalSettings,
	listMcpServersFromSources,
	updateMcpServerSettings,
	type McpServerFromSource,
	type McpServersFromSourcesResponse,
} from '../lib/api-helpers.ts';
import { globalSettings } from '../lib/state.ts';
import { borderColors } from '../lib/design-tokens.ts';

// Model options with human-readable names
const MODEL_OPTIONS = [
	{ value: '', label: 'Default (Sonnet)' },
	{ value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
	{ value: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
	{ value: 'claude-haiku-3-5-20241022', label: 'Haiku 3.5' },
] as const;

// Permission mode options with descriptions
const PERMISSION_MODE_OPTIONS: Array<{
	value: PermissionMode;
	label: string;
	description: string;
}> = [
	{
		value: 'default',
		label: 'Default',
		description: 'Ask for permission on potentially dangerous actions',
	},
	{
		value: 'acceptEdits',
		label: 'Accept Edits',
		description: 'Auto-accept file edits, ask for other actions',
	},
	{
		value: 'bypassPermissions',
		label: 'Bypass All',
		description: 'Skip all permission prompts (use with caution)',
	},
	{ value: 'plan', label: 'Plan Mode', description: 'Plan changes without executing them' },
	{
		value: 'dontAsk',
		label: "Don't Ask",
		description: 'Never ask for permission (most permissive)',
	},
];

// Setting source options
const SETTING_SOURCE_OPTIONS: Array<{ value: SettingSource; label: string; description: string }> =
	[
		{ value: 'user', label: 'User', description: 'Load settings from ~/.claude/' },
		{ value: 'project', label: 'Project', description: 'Load settings from .claude/ in workspace' },
		{
			value: 'local',
			label: 'Local',
			description: 'Load settings from .claude/settings.local.json',
		},
	];

// Source label mapping
const SOURCE_LABELS: Record<SettingSource, string> = {
	user: 'User (~/.claude/)',
	project: 'Project (.claude/)',
	local: 'Local (.claude/settings.local.json)',
};

export function GlobalSettingsEditor() {
	const [saving, setSaving] = useState(false);
	const [lastSaved, setLastSaved] = useState<string | null>(null);
	const [mcpLoading, setMcpLoading] = useState(true);
	const [mcpServers, setMcpServers] = useState<McpServersFromSourcesResponse | null>(null);
	const settings = globalSettings.value;

	// Show brief "Saved" indicator then fade out
	const showSavedIndicator = (field: string) => {
		setLastSaved(field);
		setTimeout(() => setLastSaved(null), 2000);
	};

	// Load MCP servers from enabled sources
	const loadMcpServers = async () => {
		try {
			setMcpLoading(true);
			const response = await listMcpServersFromSources();
			setMcpServers(response);
		} catch (error) {
			console.error('Failed to load MCP servers:', error);
		} finally {
			setMcpLoading(false);
		}
	};

	// Load MCP servers on mount and when setting sources change
	useEffect(() => {
		loadMcpServers();
	}, [settings?.settingSources]);

	const handleModelChange = async (value: string) => {
		try {
			setSaving(true);
			await updateGlobalSettings({ model: value || undefined });
			showSavedIndicator('model');
		} catch (error) {
			console.error('Failed to update model:', error);
			toast.error('Failed to update model');
		} finally {
			setSaving(false);
		}
	};

	const handlePermissionModeChange = async (value: PermissionMode) => {
		try {
			setSaving(true);
			await updateGlobalSettings({ permissionMode: value });
			showSavedIndicator('permission');
		} catch (error) {
			console.error('Failed to update permission mode:', error);
			toast.error('Failed to update permission mode');
		} finally {
			setSaving(false);
		}
	};

	const handleSettingSourceToggle = async (source: SettingSource, enabled: boolean) => {
		try {
			setSaving(true);
			const currentSources = settings?.settingSources || ['user', 'project', 'local'];
			let newSources: SettingSource[];

			if (enabled) {
				// Add source if not present
				newSources = currentSources.includes(source) ? currentSources : [...currentSources, source];
			} else {
				// Remove source
				newSources = currentSources.filter((s) => s !== source);
			}

			// Ensure at least one source is enabled
			if (newSources.length === 0) {
				toast.error('At least one setting source must be enabled');
				return;
			}

			await updateGlobalSettings({ settingSources: newSources });
			showSavedIndicator('sources');
			// Reload MCP servers after source change
			loadMcpServers();
		} catch (error) {
			console.error('Failed to update setting sources:', error);
			toast.error('Failed to update setting sources');
		} finally {
			setSaving(false);
		}
	};

	const handleMcpServerSettingChange = async (
		serverName: string,
		key: 'allowed' | 'defaultOn',
		value: boolean
	) => {
		try {
			setSaving(true);
			const currentSettings = mcpServers?.serverSettings[serverName] || {};
			const newSettings = { ...currentSettings, [key]: value };

			// If disabling allowed, also disable defaultOn
			if (key === 'allowed' && !value) {
				newSettings.defaultOn = false;
			}

			await updateMcpServerSettings(serverName, newSettings);

			// Update local state
			if (mcpServers) {
				setMcpServers({
					...mcpServers,
					serverSettings: {
						...mcpServers.serverSettings,
						[serverName]: newSettings,
					},
				});
			}
			showSavedIndicator(`mcp-${serverName}`);
		} catch (error) {
			console.error('Failed to update MCP server settings:', error);
			toast.error('Failed to update MCP server settings');
		} finally {
			setSaving(false);
		}
	};

	if (!settings) {
		return <div class="text-gray-400 text-sm">Loading settings...</div>;
	}

	const currentModel = settings.model || '';
	const currentPermissionMode = settings.permissionMode || 'default';
	const currentSources = settings.settingSources || ['user', 'project', 'local'];

	// Saved checkmark component
	const SavedIndicator = ({ field }: { field: string }) => (
		<span
			class={`inline-flex items-center gap-1 text-xs text-green-400 transition-opacity duration-300 ${
				lastSaved === field ? 'opacity-100' : 'opacity-0'
			}`}
		>
			<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
				<path
					fill-rule="evenodd"
					d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
					clip-rule="evenodd"
				/>
			</svg>
			Saved
		</span>
	);

	return (
		<div class={`space-y-4 ${saving ? 'opacity-50 pointer-events-none' : ''}`}>
			{/* Auto-save notice */}
			<div class="flex items-center gap-2 text-xs text-gray-500">
				<svg class="w-3.5 h-3.5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
					<path
						fill-rule="evenodd"
						d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
						clip-rule="evenodd"
					/>
				</svg>
				<span>Changes are saved automatically</span>
			</div>

			{/* Model Selection */}
			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<label class="text-sm text-gray-400">Model</label>
					<SavedIndicator field="model" />
				</div>
				<select
					value={currentModel}
					onChange={(e) => handleModelChange((e.target as HTMLSelectElement).value)}
					class={`w-full px-3 py-2 bg-dark-900 border ${borderColors.ui.secondary} rounded text-gray-200 text-sm focus:outline-none focus:border-blue-500`}
				>
					{MODEL_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>

			{/* Permission Mode Selection */}
			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<label class="text-sm text-gray-400">Permission Mode</label>
					<SavedIndicator field="permission" />
				</div>
				<select
					value={currentPermissionMode}
					onChange={(e) =>
						handlePermissionModeChange((e.target as HTMLSelectElement).value as PermissionMode)
					}
					class={`w-full px-3 py-2 bg-dark-900 border ${borderColors.ui.secondary} rounded text-gray-200 text-sm focus:outline-none focus:border-blue-500`}
				>
					{PERMISSION_MODE_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				<p class="text-xs text-gray-500">
					{PERMISSION_MODE_OPTIONS.find((o) => o.value === currentPermissionMode)?.description}
				</p>
			</div>

			{/* Setting Sources Checkboxes */}
			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<label class="text-sm text-gray-400">Setting Sources</label>
					<SavedIndicator field="sources" />
				</div>
				<div class="space-y-2">
					{SETTING_SOURCE_OPTIONS.map((option) => {
						const isEnabled = currentSources.includes(option.value);
						return (
							<label
								key={option.value}
								class={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
									isEnabled
										? `${borderColors.ui.secondary} bg-dark-800`
										: 'border-dark-700 bg-dark-900 opacity-60'
								}`}
							>
								<input
									type="checkbox"
									checked={isEnabled}
									onChange={(e) =>
										handleSettingSourceToggle(option.value, (e.target as HTMLInputElement).checked)
									}
									class="mt-0.5 w-4 h-4 rounded border-gray-600 bg-dark-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
								/>
								<div class="flex-1">
									<div class="text-sm text-gray-200 font-medium">{option.label}</div>
									<div class="text-xs text-gray-500">{option.description}</div>
								</div>
							</label>
						);
					})}
				</div>
			</div>

			{/* MCP Servers (from enabled sources) */}
			<div class="space-y-2">
				<label class="text-sm text-gray-400">MCP Servers</label>
				<p class="text-xs text-gray-500">
					MCP servers from enabled setting sources. Configure which servers are allowed and enabled
					by default.
				</p>

				{mcpLoading ? (
					<div class="text-xs text-gray-500 py-2">Loading MCP servers...</div>
				) : mcpServers ? (
					<div class="space-y-3 mt-2">
						{/* Group servers by source */}
						{(['user', 'project', 'local'] as SettingSource[])
							.filter((source) => currentSources.includes(source))
							.map((source) => {
								const serversForSource = mcpServers.servers[source] || [];
								if (serversForSource.length === 0) return null;

								return (
									<div key={source} class="space-y-2">
										<div class="text-xs font-medium text-gray-400 uppercase tracking-wider">
											{SOURCE_LABELS[source]}
										</div>
										<div class="space-y-1">
											{serversForSource.map((server: McpServerFromSource) => {
												const serverSettings = mcpServers.serverSettings[server.name] || {};
												const isAllowed = serverSettings.allowed !== false; // Default to true
												const isDefaultOn = serverSettings.defaultOn === true; // Default to false

												return (
													<div
														key={`${source}-${server.name}`}
														class={`flex items-center justify-between p-2 rounded-lg border ${borderColors.ui.secondary} bg-dark-800/50`}
													>
														<div class="flex items-center gap-2 flex-1 min-w-0">
															<svg
																class="w-4 h-4 text-purple-400 flex-shrink-0"
																fill="none"
																viewBox="0 0 24 24"
																stroke="currentColor"
															>
																<path
																	stroke-linecap="round"
																	stroke-linejoin="round"
																	stroke-width={2}
																	d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2"
																/>
															</svg>
															<div class="flex-1 min-w-0">
																<div class="text-sm text-gray-200 truncate">{server.name}</div>
																{server.command && (
																	<div class="text-xs text-gray-500 truncate">{server.command}</div>
																)}
															</div>
														</div>
														<div class="flex items-center gap-3 flex-shrink-0 ml-2">
															<SavedIndicator field={`mcp-${server.name}`} />
															<label class="flex items-center gap-1.5 cursor-pointer">
																<span class="text-xs text-gray-400">Allowed</span>
																<input
																	type="checkbox"
																	checked={isAllowed}
																	onChange={(e) =>
																		handleMcpServerSettingChange(
																			server.name,
																			'allowed',
																			(e.target as HTMLInputElement).checked
																		)
																	}
																	disabled={saving}
																	class="w-3.5 h-3.5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
																/>
															</label>
															<label
																class={`flex items-center gap-1.5 ${isAllowed ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
															>
																<span class="text-xs text-gray-400">Default ON</span>
																<input
																	type="checkbox"
																	checked={isDefaultOn}
																	onChange={(e) =>
																		handleMcpServerSettingChange(
																			server.name,
																			'defaultOn',
																			(e.target as HTMLInputElement).checked
																		)
																	}
																	disabled={saving || !isAllowed}
																	class="w-3.5 h-3.5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
																/>
															</label>
														</div>
													</div>
												);
											})}
										</div>
									</div>
								);
							})}

						{/* No servers message */}
						{(['user', 'project', 'local'] as SettingSource[])
							.filter((source) => currentSources.includes(source))
							.every((source) => (mcpServers.servers[source] || []).length === 0) && (
							<div class="text-xs text-gray-500 py-2 text-center">
								No MCP servers found in enabled setting sources.
							</div>
						)}
					</div>
				) : (
					<div class="text-xs text-gray-500 py-2">Failed to load MCP servers.</div>
				)}
			</div>
		</div>
	);
}
