import { useEffect, useState } from 'preact/hooks';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings, listMcpServersFromSources } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import type { SettingSource } from '@neokai/shared';
import { SettingsSection, SettingsToggle } from './SettingsSection.tsx';
import { cn } from '../../lib/utils.ts';

interface McpServerInfo {
	name: string;
	source: SettingSource;
	command?: string;
	args?: string[];
}

export function McpServersSettings() {
	const settings = globalSettings.value;
	const [servers, setServers] = useState<Record<SettingSource, McpServerInfo[]>>({
		user: [],
		project: [],
		local: [],
	});
	const [isLoading, setIsLoading] = useState(true);
	const [updatingServers, setUpdatingServers] = useState<Set<string>>(new Set());

	// Load MCP servers on mount
	useEffect(() => {
		const loadServers = async () => {
			setIsLoading(true);
			try {
				const response = await listMcpServersFromSources();
				setServers(response.servers);
			} catch {
				toast.error('Failed to load MCP servers');
			} finally {
				setIsLoading(false);
			}
		};
		loadServers();
	}, []);

	const isServerEnabled = (serverName: string): boolean => {
		const disabledServers = settings?.disabledMcpServers ?? [];
		return !disabledServers.includes(serverName);
	};

	const handleToggleServer = async (serverName: string, enabled: boolean) => {
		setUpdatingServers((prev) => new Set(prev).add(serverName));

		try {
			const currentDisabled = settings?.disabledMcpServers ?? [];
			let updatedDisabled: string[];

			if (enabled) {
				// Remove from disabled list
				updatedDisabled = currentDisabled.filter((s) => s !== serverName);
			} else {
				// Add to disabled list (if not already there)
				if (!currentDisabled.includes(serverName)) {
					updatedDisabled = [...currentDisabled, serverName];
				} else {
					updatedDisabled = currentDisabled;
				}
			}

			await updateGlobalSettings({ disabledMcpServers: updatedDisabled });
		} catch {
			toast.error(`Failed to ${enabled ? 'enable' : 'disable'} server`);
		} finally {
			setUpdatingServers((prev) => {
				const next = new Set(prev);
				next.delete(serverName);
				return next;
			});
		}
	};

	// Flatten all servers into a single list
	const allServers = [...servers.user, ...servers.project, ...servers.local];

	if (isLoading) {
		return (
			<SettingsSection title="MCP Servers">
				<div class="text-sm text-gray-500 py-2">Loading servers...</div>
			</SettingsSection>
		);
	}

	if (allServers.length === 0) {
		return (
			<SettingsSection title="MCP Servers">
				<div class="text-sm text-gray-500 py-2">
					No MCP servers configured. Add servers to your{' '}
					<code class="text-xs bg-dark-800 px-1 py-0.5 rounded">.mcp.json</code> file.
				</div>
			</SettingsSection>
		);
	}

	return (
		<SettingsSection title="MCP Servers">
			<div class="space-y-2">
				{allServers.map((server) => {
					const isEnabled = isServerEnabled(server.name);
					const isUpdating = updatingServers.has(server.name);

					return (
						<div
							key={`${server.source}-${server.name}`}
							class={cn(
								'flex items-center justify-between gap-3 py-2 px-3',
								'bg-dark-800/50 rounded-lg border border-dark-700'
							)}
						>
							<div class="flex-1 min-w-0">
								<div class="text-sm text-gray-300 truncate">{server.name}</div>
								<div class="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
									<span
										class={cn(
											'px-1.5 py-0.5 rounded text-[10px] uppercase',
											server.source === 'user' && 'bg-purple-500/20 text-purple-400',
											server.source === 'project' && 'bg-blue-500/20 text-blue-400',
											server.source === 'local' && 'bg-green-500/20 text-green-400'
										)}
									>
										{server.source}
									</span>
									{server.command && <span class="truncate font-mono">{server.command}</span>}
								</div>
							</div>
							<SettingsToggle
								checked={isEnabled}
								onChange={(checked) => handleToggleServer(server.name, checked)}
								disabled={isUpdating}
							/>
						</div>
					);
				})}
			</div>
		</SettingsSection>
	);
}
