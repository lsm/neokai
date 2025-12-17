/**
 * MCP Tools Settings Component
 *
 * Comprehensive MCP (Model Context Protocol) tool management:
 * - Loads available MCP servers from .mcp.json
 * - Shows which tools would be available per server
 * - Allows enabling/disabling specific tool patterns
 * - Automatically restarts SDK query when changes are made
 */

import { useComputed, useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { currentSession, currentAgentState } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { borderColors } from '../lib/design-tokens.ts';

export function McpToolsSettings() {
	const loading = useSignal(false);
	const servers = useSignal<Record<string, unknown>>({});

	// Current enabled tools from session config (using new tools format)
	const enabledTools = useComputed(() => {
		return currentSession.value?.config.tools?.enabledMcpPatterns || [];
	});

	// Check if agent is currently processing
	const isAgentProcessing = useComputed(() => {
		return currentAgentState.value.status !== 'idle';
	});

	// Load available MCP servers when component mounts or session changes
	useEffect(() => {
		if (currentSession.value) {
			loadMcpServers();
		}
	}, [currentSession.value?.id]);

	const loadMcpServers = async () => {
		if (!currentSession.value) return;

		try {
			const hub = await connectionManager.getHub();
			const response = await hub.call<{ servers: Record<string, unknown> }>('mcp.listServers', {
				sessionId: currentSession.value.id,
			});
			servers.value = response.servers;
		} catch (error) {
			console.error('Failed to load MCP servers:', error);
			servers.value = {};
		}
	};

	const serverNames = useComputed(() => Object.keys(servers.value));

	// Generate common tool patterns for each server
	const getServerPatterns = (serverName: string) => {
		return [
			{
				pattern: `mcp__${serverName}__*`,
				label: `All ${serverName} tools`,
				description: 'Enable all tools from this server',
			},
		];
	};

	const isPatternEnabled = (pattern: string): boolean => {
		return enabledTools.value.includes(pattern);
	};

	const togglePattern = async (pattern: string) => {
		if (!currentSession.value) return;

		try {
			loading.value = true;

			const currentTools = enabledTools.value;
			const newTools = currentTools.includes(pattern)
				? currentTools.filter((p: string) => p !== pattern)
				: [...currentTools, pattern];

			// Build new tools config
			const currentConfig = currentSession.value.config.tools ?? {};
			const newToolsConfig = {
				...currentConfig,
				loadProjectMcp: newTools.length > 0,
				enabledMcpPatterns: newTools,
			};

			const hub = await connectionManager.getHub();
			// Use tools.save to automatically restart query with new config
			await hub.call('tools.save', {
				sessionId: currentSession.value.id,
				tools: newToolsConfig,
			});

			toast.success(
				`MCP tool ${currentTools.includes(pattern) ? 'disabled' : 'enabled'} - query restarted`
			);
		} catch (error) {
			console.error('Failed to update MCP tools:', error);
			toast.error('Failed to update MCP tools');
		} finally {
			loading.value = false;
		}
	};

	if (!currentSession.value) {
		return (
			<div class="text-gray-400 text-sm">
				No session selected. Create a session to manage MCP tools.
			</div>
		);
	}

	return (
		<div class="space-y-4">
			<div class={`bg-dark-800 rounded-lg p-4 border ${borderColors.ui.secondary}`}>
				<h3 class="text-sm font-medium text-gray-300 mb-3">MCP Tool Permissions</h3>

				<div class="text-xs text-gray-400 mb-4">
					Configure which MCP (Model Context Protocol) tools are available for this session. Tools
					are disabled by default for security (zero-trust). Changes apply immediately by restarting
					the SDK query.
				</div>

				{/* Agent processing warning */}
				{isAgentProcessing.value && (
					<div class="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg flex items-center gap-2">
						<svg class="w-4 h-4 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle
								class="opacity-25"
								cx="12"
								cy="12"
								r="10"
								stroke="currentColor"
								stroke-width="4"
							></circle>
							<path
								class="opacity-75"
								fill="currentColor"
								d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
							></path>
						</svg>
						<span class="text-xs text-blue-300">
							Agent is processing - tool changes are temporarily disabled
						</span>
					</div>
				)}

				{/* No MCP servers found */}
				{serverNames.value.length === 0 && (
					<div class="p-4 bg-dark-700/50 rounded border border-dark-600">
						<div class="text-sm text-gray-400 mb-2">No MCP servers configured</div>
						<div class="text-xs text-gray-500">
							Create a <code class="px-1 py-0.5 bg-dark-800 rounded">.mcp.json</code> file in your
							workspace to configure MCP servers.
						</div>
					</div>
				)}

				{/* MCP servers list */}
				{serverNames.value.length > 0 && (
					<div class="space-y-4">
						<div class="text-xs font-medium text-gray-400">Available MCP Servers</div>

						{serverNames.value.map((serverName) => (
							<div key={serverName} class="space-y-2">
								<div class="flex items-center gap-2">
									<div class="w-2 h-2 bg-blue-500 rounded-full"></div>
									<div class="text-sm font-medium text-gray-300">{serverName}</div>
								</div>

								<div class="ml-4 space-y-1">
									{getServerPatterns(serverName).map((item) => (
										<label
											key={item.pattern}
											class="flex items-start gap-2 cursor-pointer hover:bg-dark-700 p-2 rounded transition-colors"
										>
											<input
												type="checkbox"
												checked={isPatternEnabled(item.pattern)}
												onChange={() => togglePattern(item.pattern)}
												disabled={loading.value || isAgentProcessing.value}
												class="mt-0.5 rounded border-gray-600 text-blue-500 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-dark-900 disabled:opacity-50"
											/>
											<div class="flex-1">
												<div class="text-sm text-gray-300">{item.label}</div>
												<div class="text-xs text-gray-500">{item.description}</div>
												<code class="text-xs text-gray-600 font-mono">{item.pattern}</code>
											</div>
										</label>
									))}
								</div>
							</div>
						))}
					</div>
				)}

				{/* Current enabled tools summary */}
				<div class="mt-4 pt-4 border-t border-dark-700">
					{enabledTools.value.length > 0 ? (
						<>
							<div class="text-xs text-gray-400 mb-2">
								Currently enabled ({enabledTools.value.length} patterns):
							</div>
							<div class="flex flex-wrap gap-1">
								{enabledTools.value.map((pattern: string) => (
									<code
										key={pattern}
										class="text-xs bg-dark-700 text-gray-300 px-2 py-1 rounded font-mono"
									>
										{pattern}
									</code>
								))}
							</div>
						</>
					) : (
						<div class="text-xs text-gray-400">
							<span class="inline-flex items-center gap-1">
								<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
									<path
										fill-rule="evenodd"
										d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
										clip-rule="evenodd"
									/>
								</svg>
								Zero-trust mode: No MCP tools enabled
							</span>
						</div>
					)}
				</div>

				{/* Info footer */}
				<div class="mt-4 pt-4 border-t border-dark-700">
					<div class="text-xs text-gray-500">
						<strong>Note:</strong> Tool patterns use wildcards (e.g.,{' '}
						<code>mcp__chrome-devtools__*</code>). The <code>*</code> matches all tools from that
						server.
					</div>
				</div>
			</div>
		</div>
	);
}
