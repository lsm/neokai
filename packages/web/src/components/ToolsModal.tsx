/**
 * Tools Modal Component
 *
 * Configure tools for the current session:
 * - Liuboer Tools: Memory, Session Export (configurable)
 * - MCP Tools: Load .mcp.json from workspace (configurable)
 * - SDK Built-in: Always enabled, shown for information only
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
	const loadProjectMcp = useSignal(false);
	const enabledMcpPatterns = useSignal<string[]>([]);
	const memoryEnabled = useSignal(false);
	const sessionExportEnabled = useSignal(false);

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
		loadProjectMcp.value = tools?.loadProjectMcp ?? false;
		enabledMcpPatterns.value = tools?.enabledMcpPatterns ?? [];
		memoryEnabled.value = tools?.liuboerTools?.memory ?? false;
		sessionExportEnabled.value = tools?.liuboerTools?.sessionExport ?? false;
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
	const isMcpAllowed = useComputed(() => globalConfig.value?.mcp.allowProjectMcp ?? true);
	const isMemoryAllowed = useComputed(
		() => globalConfig.value?.liuboerTools.memory.allowed ?? true
	);
	const isSessionExportAllowed = useComputed(
		() => globalConfig.value?.liuboerTools.sessionExport.allowed ?? true
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

	const toggleProjectMcp = () => {
		loadProjectMcp.value = !loadProjectMcp.value;
		hasChanges.value = true;
	};

	const toggleMemory = () => {
		memoryEnabled.value = !memoryEnabled.value;
		hasChanges.value = true;
	};

	const toggleSessionExport = () => {
		sessionExportEnabled.value = !sessionExportEnabled.value;
		hasChanges.value = true;
	};

	const handleSave = async () => {
		if (!session || !hasChanges.value) return;

		try {
			saving.value = true;

			const toolsConfig: ToolsConfig = {
				loadProjectMcp: loadProjectMcp.value,
				enabledMcpPatterns: enabledMcpPatterns.value,
				liuboerTools: {
					memory: memoryEnabled.value,
					sessionExport: sessionExportEnabled.value,
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

						{/* Session Export Tool */}
						<label
							class={`flex items-center justify-between p-3 rounded-lg bg-dark-800/50 transition-colors ${
								isSessionExportAllowed.value
									? 'hover:bg-dark-800 cursor-pointer'
									: 'opacity-50 cursor-not-allowed'
							}`}
						>
							<div class="flex items-center gap-3">
								<svg
									class="w-5 h-5 text-cyan-400"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
									/>
								</svg>
								<div>
									<div class="text-sm text-gray-200">Session Export</div>
									<div class="text-xs text-gray-500">Export conversation to markdown/JSON</div>
								</div>
							</div>
							<input
								type="checkbox"
								checked={sessionExportEnabled.value}
								onChange={toggleSessionExport}
								disabled={!isSessionExportAllowed.value}
								class="w-5 h-5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
							/>
						</label>
					</div>
				</div>

				{/* Divider */}
				<div class={`border-t ${borderColors.ui.secondary}`} />

				{/* MCP Tools Section */}
				<div>
					<h3 class="text-sm font-medium text-gray-300 mb-2">MCP Tools</h3>
					<p class="text-xs text-gray-500 mb-3">External tool servers from .mcp.json</p>

					{/* Project MCP Toggle */}
					<label
						class={`flex items-center justify-between p-3 rounded-lg bg-dark-800/50 transition-colors mb-3 ${
							isMcpAllowed.value
								? 'hover:bg-dark-800 cursor-pointer'
								: 'opacity-50 cursor-not-allowed'
						}`}
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
									d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
								/>
							</svg>
							<div>
								<div class="text-sm text-gray-200">Load Project MCP</div>
								<div class="text-xs text-gray-500">Load .mcp.json from workspace</div>
							</div>
						</div>
						<input
							type="checkbox"
							checked={loadProjectMcp.value}
							onChange={toggleProjectMcp}
							disabled={!isMcpAllowed.value}
							class="w-5 h-5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
						/>
					</label>

					{/* MCP Servers List (only shown when project MCP is enabled) */}
					{loadProjectMcp.value && (
						<div class="ml-4 space-y-2">
							{loading.value ? (
								<div class="flex items-center gap-2 text-sm text-gray-400 py-2">
									<div class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
									Loading servers...
								</div>
							) : serverNames.value.length === 0 ? (
								<div class="text-sm text-gray-500 py-2">No MCP servers found in .mcp.json</div>
							) : (
								serverNames.value.map((serverName) => (
									<label
										key={serverName}
										class="flex items-center justify-between p-2.5 rounded-lg bg-dark-700/50 hover:bg-dark-700 transition-colors cursor-pointer"
									>
										<div class="flex items-center gap-2">
											<div class="w-2 h-2 bg-blue-500 rounded-full" />
											<span class="text-sm text-gray-300">{serverName}</span>
										</div>
										<input
											type="checkbox"
											checked={isPatternEnabled(`mcp__${serverName}__*`)}
											onChange={() => togglePattern(`mcp__${serverName}__*`)}
											class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
										/>
									</label>
								))
							)}
						</div>
					)}
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
