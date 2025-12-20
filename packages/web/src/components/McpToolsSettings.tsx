/**
 * MCP Tools Settings Component
 *
 * Comprehensive MCP (Model Context Protocol) tool management:
 * - Loads available MCP servers from .mcp.json
 * - Shows which servers are available
 * - Allows enabling/disabling specific servers
 * - Automatically restarts SDK query when changes are made
 *
 * Architecture: Uses disabledMcpServers (not enabled patterns)
 * - Empty disabledMcpServers = all servers enabled
 * - Server name in disabledMcpServers = that server disabled
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

	// Current disabled servers from session config
	const disabledServers = useComputed(() => {
		return currentSession.value?.config.tools?.disabledMcpServers || [];
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

	// Check if a server is enabled (not in disabled list)
	const isServerEnabled = (serverName: string): boolean => {
		return !disabledServers.value.includes(serverName);
	};

	const toggleServer = async (serverName: string) => {
		if (!currentSession.value) return;

		try {
			loading.value = true;

			const currentDisabled = disabledServers.value;
			const isCurrentlyDisabled = currentDisabled.includes(serverName);

			// Toggle: if disabled, remove from list (enable); if enabled, add to list (disable)
			const newDisabled = isCurrentlyDisabled
				? currentDisabled.filter((s: string) => s !== serverName)
				: [...currentDisabled, serverName];

			// Build new tools config
			const currentConfig = currentSession.value.config.tools ?? {};
			const newToolsConfig = {
				...currentConfig,
				disabledMcpServers: newDisabled,
			};

			const hub = await connectionManager.getHub();
			// Use tools.save to automatically restart query with new config
			await hub.call('tools.save', {
				sessionId: currentSession.value.id,
				tools: newToolsConfig,
			});

			toast.success(
				`${serverName} ${isCurrentlyDisabled ? 'enabled' : 'disabled'} - query restarted`
			);
		} catch (error) {
			console.error('Failed to update MCP server:', error);
			toast.error('Failed to update MCP server');
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
					Configure which MCP (Model Context Protocol) servers are available for this session. All
					servers are enabled by default. Disable servers you don't want to use. Changes apply
					immediately by restarting the SDK query.
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
							<label
								key={serverName}
								class="flex items-center justify-between p-3 rounded-lg bg-dark-700/50 hover:bg-dark-700 transition-colors cursor-pointer"
							>
								<div class="flex items-center gap-3">
									<div
										class={`w-2 h-2 rounded-full ${isServerEnabled(serverName) ? 'bg-green-500' : 'bg-gray-500'}`}
									></div>
									<div class="text-sm font-medium text-gray-300">{serverName}</div>
								</div>
								<input
									type="checkbox"
									checked={isServerEnabled(serverName)}
									onChange={() => toggleServer(serverName)}
									disabled={loading.value || isAgentProcessing.value}
									class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-2 focus:ring-blue-500 focus:ring-offset-dark-900 disabled:opacity-50"
								/>
							</label>
						))}
					</div>
				)}

				{/* Current status summary */}
				<div class="mt-4 pt-4 border-t border-dark-700">
					{disabledServers.value.length > 0 ? (
						<>
							<div class="text-xs text-gray-400 mb-2">
								Disabled servers ({disabledServers.value.length}):
							</div>
							<div class="flex flex-wrap gap-1">
								{disabledServers.value.map((serverName: string) => (
									<code
										key={serverName}
										class="text-xs bg-red-900/30 text-red-300 px-2 py-1 rounded font-mono"
									>
										{serverName}
									</code>
								))}
							</div>
						</>
					) : (
						<div class="text-xs text-gray-400">
							<span class="inline-flex items-center gap-1">
								<svg class="w-3 h-3 text-green-400" fill="currentColor" viewBox="0 0 20 20">
									<path
										fill-rule="evenodd"
										d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
										clip-rule="evenodd"
									/>
								</svg>
								All MCP servers enabled
							</span>
						</div>
					)}
				</div>

				{/* Info footer */}
				<div class="mt-4 pt-4 border-t border-dark-700">
					<div class="text-xs text-gray-500">
						<strong>Note:</strong> Unchecked servers will be disabled and their tools won't be
						available in the session.
					</div>
				</div>
			</div>
		</div>
	);
}
