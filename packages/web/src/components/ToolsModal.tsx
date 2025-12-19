/**
 * Tools Modal Component
 *
 * Configure tools for the current session:
 * - System Prompt: Claude Code preset
 * - Setting Sources: User/Project/Local settings selection
 * - MCP Servers: Dynamic list from selected setting sources
 * - Liuboer Tools: Memory (configurable)
 * - SDK Built-in: Always enabled, shown for information only
 *
 * SDK Terms Reference:
 * - systemPrompt: { type: 'preset', preset: 'claude_code' } - The Claude Code system prompt
 * - settingSources: ['project', 'local', 'user'] - Which config files to load
 */

import { useSignal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { Modal } from './ui/Modal.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import type { Session, ToolsConfig, GlobalToolsConfig, SettingSource } from '@liuboer/shared';
import {
	listMcpServersFromSources,
	type McpServerFromSource,
	type McpServersFromSourcesResponse,
} from '../lib/api-helpers.ts';

interface ToolsModalProps {
	isOpen: boolean;
	onClose: () => void;
	session: Session | null;
}

// Setting source options with descriptions
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

export function ToolsModal({ isOpen, onClose, session }: ToolsModalProps) {
	const saving = useSignal(false);
	const hasChanges = useSignal(false);
	const mcpLoading = useSignal(true);
	const mcpServersData = useSignal<McpServersFromSourcesResponse | null>(null);
	const globalConfig = useSignal<GlobalToolsConfig | null>(null);

	// Local state for editing
	const useClaudeCodePreset = useSignal(true);
	const settingSources = useSignal<SettingSource[]>(['user', 'project', 'local']);
	// List of disabled MCP server names (unchecked servers)
	// This is the inverse of the old enabledMcpPatterns approach
	const disabledMcpServers = useSignal<string[]>([]);
	const memoryEnabled = useSignal(false);

	// Load current config and MCP servers when modal opens
	useEffect(() => {
		if (isOpen && session) {
			loadConfig();
			loadGlobalConfig();
		}
	}, [isOpen, session?.id]);

	// Reload MCP servers when setting sources change
	useEffect(() => {
		if (isOpen) {
			loadMcpServers();
		}
	}, [isOpen, settingSources.value]);

	const loadConfig = () => {
		if (!session) return;

		const tools = session.config.tools;
		// Handle both old and new config format for backward compatibility
		useClaudeCodePreset.value = tools?.useClaudeCodePreset ?? true;
		// New settingSources field or fall back to legacy loadSettingSources behavior
		if (tools?.settingSources) {
			settingSources.value = tools.settingSources;
		} else if (tools?.loadSettingSources !== false) {
			// Legacy: if loadSettingSources was true or undefined, enable all sources
			settingSources.value = ['user', 'project', 'local'];
		} else {
			// Legacy: loadSettingSources was explicitly false
			settingSources.value = [];
		}
		// Load disabled MCP servers (new approach)
		disabledMcpServers.value = tools?.disabledMcpServers ?? [];
		memoryEnabled.value = tools?.liuboerTools?.memory ?? false;
		hasChanges.value = false;
	};

	const loadMcpServers = async () => {
		if (!session) return;

		try {
			mcpLoading.value = true;
			const response = await listMcpServersFromSources(session.id);
			mcpServersData.value = response;
		} catch (error) {
			console.error('Failed to load MCP servers:', error);
			mcpServersData.value = null;
		} finally {
			mcpLoading.value = false;
		}
	};

	const loadGlobalConfig = async () => {
		try {
			const hub = await connectionManager.getHub();
			const response = await hub.call<{ config: GlobalToolsConfig }>('globalTools.getConfig');
			globalConfig.value = response.config;
		} catch (error) {
			console.error('Failed to load global tools config:', error);
		}
	};

	// Check if tools are allowed based on global config
	const isClaudeCodePresetAllowed = useComputed(
		() => globalConfig.value?.systemPrompt?.claudeCodePreset?.allowed ?? true
	);
	const isMcpAllowed = useComputed(() => globalConfig.value?.mcp?.allowProjectMcp ?? true);
	const isMemoryAllowed = useComputed(
		() => globalConfig.value?.liuboerTools?.memory?.allowed ?? true
	);

	// Check if a server is enabled (not in disabled list)
	const isServerEnabled = (serverName: string): boolean => {
		return !disabledMcpServers.value.includes(serverName);
	};

	// Toggle server enabled/disabled state
	const toggleServer = (serverName: string) => {
		if (disabledMcpServers.value.includes(serverName)) {
			// Currently disabled → enable (remove from disabled list)
			disabledMcpServers.value = disabledMcpServers.value.filter((s) => s !== serverName);
		} else {
			// Currently enabled → disable (add to disabled list)
			disabledMcpServers.value = [...disabledMcpServers.value, serverName];
		}
		hasChanges.value = true;
	};

	const toggleClaudeCodePreset = () => {
		useClaudeCodePreset.value = !useClaudeCodePreset.value;
		hasChanges.value = true;
	};

	const toggleSettingSource = (source: SettingSource, enabled: boolean) => {
		if (enabled) {
			if (!settingSources.value.includes(source)) {
				settingSources.value = [...settingSources.value, source];
			}
		} else {
			// Ensure at least one source is enabled
			const newSources = settingSources.value.filter((s) => s !== source);
			if (newSources.length === 0) {
				toast.error('At least one setting source must be enabled');
				return;
			}
			settingSources.value = newSources;
		}
		hasChanges.value = true;
	};

	const toggleMemory = () => {
		memoryEnabled.value = !memoryEnabled.value;
		hasChanges.value = true;
	};

	const handleSave = async () => {
		if (!session || !hasChanges.value) return;

		try {
			saving.value = true;

			// Build tools config with the new file-based approach
			// disabledMcpServers is written to .claude/settings.local.json
			// SDK reads this file and applies server filtering automatically
			const toolsConfig: ToolsConfig = {
				useClaudeCodePreset: useClaudeCodePreset.value,
				settingSources: settingSources.value,
				// List of unchecked servers → written to settings.local.json as disabledMcpjsonServers
				disabledMcpServers: disabledMcpServers.value,
				liuboerTools: {
					memory: memoryEnabled.value,
				},
			};

			const hub = await connectionManager.getHub();
			const result = await hub.call<{ success: boolean; error?: string }>('tools.save', {
				sessionId: session.id,
				tools: toolsConfig,
			});

			if (result.success) {
				hasChanges.value = false;
				toast.success('Tools configuration saved');
				onClose();
			} else {
				toast.error(result.error || 'Failed to save tools configuration');
			}
		} catch (error) {
			console.error('Failed to save tools:', error);
			toast.error('Failed to save tools configuration');
		} finally {
			saving.value = false;
		}
	};

	const handleCancel = () => {
		loadConfig(); // Reset to original values
		onClose();
	};

	if (!session) return null;

	return (
		<Modal isOpen={isOpen} onClose={handleCancel} title="Tools" size="md">
			<div class="space-y-5">
				{/* System Prompt Section */}
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">System Prompt</h3>
					<p class="text-xs text-gray-500 mb-3">Configure the system prompt preset.</p>
					<div class="space-y-2">
						{/* Claude Code Preset Toggle */}
						<label
							class={`flex items-center justify-between p-3 rounded-lg bg-dark-800/50 transition-colors ${
								isClaudeCodePresetAllowed.value
									? 'hover:bg-dark-800 cursor-pointer'
									: 'opacity-50 cursor-not-allowed'
							}`}
						>
							<div class="flex items-center gap-3">
								<svg
									class="w-5 h-5 text-blue-400"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
									/>
								</svg>
								<div>
									<div class="text-sm text-gray-200">Claude Code Preset</div>
									<div class="text-xs text-gray-500">
										Use official Claude Code system prompt with tools
									</div>
								</div>
							</div>
							<input
								type="checkbox"
								checked={useClaudeCodePreset.value}
								onChange={toggleClaudeCodePreset}
								disabled={!isClaudeCodePresetAllowed.value}
								class="w-5 h-5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
							/>
						</label>
					</div>
				</div>

				{/* Divider */}
				<div class={`border-t ${borderColors.ui.secondary}`} />

				{/* Setting Sources Section */}
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">Setting Sources</h3>
					<p class="text-xs text-gray-500 mb-3">
						Choose which configuration sources to load for this session.
					</p>
					<div class="space-y-2">
						{SETTING_SOURCE_OPTIONS.map((option) => {
							const isEnabled = settingSources.value.includes(option.value);
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
											toggleSettingSource(option.value, (e.target as HTMLInputElement).checked)
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

				{/* Divider */}
				<div class={`border-t ${borderColors.ui.secondary}`} />

				{/* MCP Servers Section - Dynamic from setting sources */}
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">MCP Servers</h3>
					<p class="text-xs text-gray-500 mb-3">
						MCP servers from enabled setting sources. Enable servers you want to use in this
						session.
					</p>

					{!isMcpAllowed.value ? (
						<div class="text-sm text-gray-500 py-2 italic">
							MCP servers are disabled in global settings.
						</div>
					) : mcpLoading.value ? (
						<div class="flex items-center gap-2 text-sm text-gray-400 py-2">
							<div class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
							Loading servers...
						</div>
					) : mcpServersData.value ? (
						<div class="space-y-3">
							{/* Group servers by source */}
							{(['user', 'project', 'local'] as SettingSource[])
								.filter((source) => settingSources.value.includes(source))
								.map((source) => {
									const serversForSource = mcpServersData.value?.servers[source] || [];
									if (serversForSource.length === 0) return null;

									return (
										<div key={source} class="space-y-2">
											<div class="text-xs font-medium text-gray-400 uppercase tracking-wider">
												{SOURCE_LABELS[source]}
											</div>
											<div class="space-y-1">
												{serversForSource.map((server: McpServerFromSource) => (
													<label
														key={`${source}-${server.name}`}
														class="flex items-center justify-between p-2 rounded-lg bg-dark-800/50 hover:bg-dark-800 transition-colors cursor-pointer"
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
														<input
															type="checkbox"
															checked={isServerEnabled(server.name)}
															onChange={() => toggleServer(server.name)}
															class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
														/>
													</label>
												))}
											</div>
										</div>
									);
								})}

							{/* No servers message */}
							{(['user', 'project', 'local'] as SettingSource[])
								.filter((source) => settingSources.value.includes(source))
								.every((source) => (mcpServersData.value?.servers[source] || []).length === 0) && (
								<div class="text-xs text-gray-500 py-2 text-center">
									No MCP servers found in enabled setting sources.
								</div>
							)}
						</div>
					) : (
						<div class="text-xs text-gray-500 py-2">Failed to load MCP servers.</div>
					)}
				</div>

				{/* Divider */}
				<div class={`border-t ${borderColors.ui.secondary}`} />

				{/* Liuboer Tools Section */}
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">Liuboer Tools</h3>
					<p class="text-xs text-gray-500 mb-3">Enhanced tools provided by Liuboer.</p>
					<div class="space-y-2">
						{/* Memory Tool */}
						<label
							class={`flex items-center justify-between p-3 rounded-lg bg-dark-800/50 transition-colors ${
								isMemoryAllowed.value
									? 'hover:bg-dark-800 cursor-pointer'
									: 'opacity-50 cursor-not-allowed'
							}`}
						>
							<div class="flex items-center gap-3">
								<svg
									class="w-5 h-5 text-purple-400"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
									/>
								</svg>
								<div>
									<div class="text-sm text-gray-200">Memory</div>
									<div class="text-xs text-gray-500">
										Persistent key-value storage across sessions
									</div>
								</div>
							</div>
							<input
								type="checkbox"
								checked={memoryEnabled.value}
								onChange={toggleMemory}
								disabled={!isMemoryAllowed.value}
								class="w-5 h-5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
							/>
						</label>
					</div>
				</div>

				{/* Divider */}
				<div class={`border-t ${borderColors.ui.secondary}`} />

				{/* SDK Built-in Tools Info (read-only) */}
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">SDK Built-in</h3>
					<p class="text-xs text-gray-500 mb-3">Always available tools from Claude Agent SDK.</p>

					<div class="space-y-1.5 opacity-70">
						<div class="flex items-center gap-3 p-2 rounded-lg bg-dark-700/30">
							<svg
								class="w-4 h-4 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
								/>
							</svg>
							<span class="text-xs text-gray-400">
								Read, Write, Edit, Glob, Grep, Bash, Notebook...
							</span>
						</div>
						<div class="flex items-center gap-3 p-2 rounded-lg bg-dark-700/30">
							<svg
								class="w-4 h-4 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"
								/>
							</svg>
							<span class="text-xs text-gray-400">WebSearch, WebFetch</span>
						</div>
						<div class="flex items-center gap-3 p-2 rounded-lg bg-dark-700/30">
							<svg
								class="w-4 h-4 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
								/>
							</svg>
							<span class="text-xs text-gray-400">
								Task agents (Explore, Plan, general-purpose)
							</span>
						</div>
						<div class="flex items-center gap-3 p-2 rounded-lg bg-dark-700/30">
							<svg
								class="w-4 h-4 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
								/>
							</svg>
							<span class="text-xs text-gray-400">/help, /context, /clear, /bug...</span>
						</div>
					</div>
				</div>

				{/* Footer with Save/Cancel buttons */}
				<div class={`pt-4 border-t ${borderColors.ui.secondary} flex gap-3 justify-end`}>
					<button
						type="button"
						onClick={handleCancel}
						class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSave}
						disabled={!hasChanges.value || saving.value}
						class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
							hasChanges.value && !saving.value
								? 'bg-blue-500 text-white hover:bg-blue-600'
								: 'bg-dark-700 text-gray-500 cursor-not-allowed'
						}`}
					>
						{saving.value ? (
							<span class="flex items-center gap-2">
								<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
								Saving...
							</span>
						) : (
							'Save'
						)}
					</button>
				</div>
			</div>
		</Modal>
	);
}
