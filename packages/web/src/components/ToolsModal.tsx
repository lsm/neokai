/**
 * Tools Modal Component
 *
 * Configure tools for the current session:
 * - System Prompt: Claude Code preset
 * - Setting Sources: Project settings (CLAUDE.md, .claude/settings.json)
 * - MCP Tools: Individual MCP servers from .mcp.json
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
import type { Session, ToolsConfig, GlobalToolsConfig } from '@liuboer/shared';

interface ToolsModalProps {
	isOpen: boolean;
	onClose: () => void;
	session: Session | null;
}

export function ToolsModal({ isOpen, onClose, session }: ToolsModalProps) {
	const loading = useSignal(false);
	const saving = useSignal(false);
	const hasChanges = useSignal(false);
	const mcpServers = useSignal<Record<string, unknown>>({});
	const globalConfig = useSignal<GlobalToolsConfig | null>(null);

	// Local state for editing
	const useClaudeCodePreset = useSignal(true);
	const loadSettingSources = useSignal(true);
	const loadProjectMcp = useSignal(false);
	const enabledMcpPatterns = useSignal<string[]>([]);
	const memoryEnabled = useSignal(false);

	// Load current config and MCP servers when modal opens
	useEffect(() => {
		if (isOpen && session) {
			loadConfig();
			loadMcpServers();
			loadGlobalConfig();
		}
	}, [isOpen, session?.id]);

	const loadConfig = () => {
		if (!session) return;

		const tools = session.config.tools;
		// Handle both old and new config format for backward compatibility
		useClaudeCodePreset.value = tools?.useClaudeCodePreset ?? true;
		// Support old loadProjectSettings for backward compat, prefer new loadSettingSources
		const oldLoadProjectSettings = (tools as Record<string, unknown> | undefined)
			?.loadProjectSettings as boolean | undefined;
		loadSettingSources.value = tools?.loadSettingSources ?? oldLoadProjectSettings ?? true;
		loadProjectMcp.value = tools?.loadProjectMcp ?? false;
		enabledMcpPatterns.value = tools?.enabledMcpPatterns ?? [];
		memoryEnabled.value = tools?.liuboerTools?.memory ?? false;
		hasChanges.value = false;
	};

	const loadMcpServers = async () => {
		if (!session) return;

		try {
			loading.value = true;
			const hub = await connectionManager.getHub();
			const response = await hub.call<{ servers: Record<string, unknown> }>('mcp.listServers', {
				sessionId: session.id,
			});
			mcpServers.value = response.servers;
		} catch (error) {
			console.error('Failed to load MCP servers:', error);
			mcpServers.value = {};
		} finally {
			loading.value = false;
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

	const serverNames = useComputed(() => Object.keys(mcpServers.value));

	// Check if tools are allowed based on global config
	const isClaudeCodePresetAllowed = useComputed(
		() => globalConfig.value?.systemPrompt?.claudeCodePreset?.allowed ?? true
	);
	const isSettingSourcesAllowed = useComputed(
		() => globalConfig.value?.settingSources?.project?.allowed ?? true
	);
	const isMcpAllowed = useComputed(() => globalConfig.value?.mcp?.allowProjectMcp ?? true);
	const isMemoryAllowed = useComputed(
		() => globalConfig.value?.liuboerTools?.memory?.allowed ?? true
	);

	const isPatternEnabled = (pattern: string): boolean => {
		return enabledMcpPatterns.value.includes(pattern);
	};

	const togglePattern = (pattern: string) => {
		if (enabledMcpPatterns.value.includes(pattern)) {
			enabledMcpPatterns.value = enabledMcpPatterns.value.filter((p) => p !== pattern);
		} else {
			enabledMcpPatterns.value = [...enabledMcpPatterns.value, pattern];
		}
		hasChanges.value = true;
	};

	const toggleClaudeCodePreset = () => {
		useClaudeCodePreset.value = !useClaudeCodePreset.value;
		hasChanges.value = true;
	};

	const toggleSettingSources = () => {
		loadSettingSources.value = !loadSettingSources.value;
		hasChanges.value = true;
	};

	const _toggleProjectMcp = () => {
		loadProjectMcp.value = !loadProjectMcp.value;
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

			const toolsConfig: ToolsConfig = {
				useClaudeCodePreset: useClaudeCodePreset.value,
				loadSettingSources: loadSettingSources.value,
				loadProjectMcp: loadProjectMcp.value,
				enabledMcpPatterns: enabledMcpPatterns.value,
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
					<p class="text-xs text-gray-500 mb-3">Load configuration files from the workspace.</p>
					<div class="space-y-2">
						{/* Project Settings Toggle */}
						<label
							class={`flex items-center justify-between p-3 rounded-lg bg-dark-800/50 transition-colors ${
								isSettingSourcesAllowed.value
									? 'hover:bg-dark-800 cursor-pointer'
									: 'opacity-50 cursor-not-allowed'
							}`}
						>
							<div class="flex items-center gap-3">
								<svg
									class="w-5 h-5 text-orange-400"
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
								<div>
									<div class="text-sm text-gray-200">Project Settings</div>
									<div class="text-xs text-gray-500">
										Load CLAUDE.md, .claude/settings.json from workspace
									</div>
								</div>
							</div>
							<input
								type="checkbox"
								checked={loadSettingSources.value}
								onChange={toggleSettingSources}
								disabled={!isSettingSourcesAllowed.value}
								class="w-5 h-5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
							/>
						</label>
					</div>
				</div>

				{/* Divider */}
				<div class={`border-t ${borderColors.ui.secondary}`} />

				{/* MCP Tools Section */}
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">MCP Servers</h3>
					<p class="text-xs text-gray-500 mb-3">External tool servers from .mcp.json</p>

					{/* MCP Servers List (always visible when MCP allowed) */}
					{!isMcpAllowed.value ? (
						<div class="text-sm text-gray-500 py-2 italic">
							MCP servers are disabled in global settings.
						</div>
					) : loading.value ? (
						<div class="flex items-center gap-2 text-sm text-gray-400 py-2">
							<div class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
							Loading servers...
						</div>
					) : serverNames.value.length === 0 ? (
						<div class="text-sm text-gray-500 py-2">No MCP servers found in .mcp.json</div>
					) : (
						<div class="space-y-2">
							{serverNames.value.map((serverName) => (
								<label
									key={serverName}
									class="flex items-center justify-between p-3 rounded-lg bg-dark-800/50 hover:bg-dark-800 transition-colors cursor-pointer"
								>
									<div class="flex items-center gap-3">
										<svg
											class="w-5 h-5 text-green-400"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"
											/>
										</svg>
										<div>
											<div class="text-sm text-gray-200">{serverName}</div>
										</div>
									</div>
									<input
										type="checkbox"
										checked={isPatternEnabled(`mcp__${serverName}__*`)}
										onChange={() => togglePattern(`mcp__${serverName}__*`)}
										class="w-5 h-5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
									/>
								</label>
							))}
						</div>
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
