import { useState } from 'preact/hooks';
import { toast } from '../lib/toast.ts';
import { toggleMcpServer } from '../lib/api-helpers.ts';
import { globalSettings } from '../lib/state.ts';
import { borderColors } from '../lib/design-tokens.ts';

export function McpServerList() {
	const [toggling, setToggling] = useState<string | null>(null);
	const [newServerName, setNewServerName] = useState('');
	const settings = globalSettings.value;
	const disabledServers = settings?.disabledMcpServers || [];

	const handleToggle = async (serverName: string, currentlyDisabled: boolean) => {
		try {
			setToggling(serverName);
			const newEnabled = currentlyDisabled; // If currently disabled, we want to enable it
			await toggleMcpServer(serverName, newEnabled);

			toast.success(`${serverName} ${newEnabled ? 'enabled' : 'disabled'}`);
		} catch (error) {
			console.error('Failed to toggle MCP server:', error);
			toast.error('Failed to toggle MCP server');
		} finally {
			setToggling(null);
		}
	};

	const handleAddDisabled = async (e: Event) => {
		e.preventDefault();
		if (!newServerName.trim()) return;

		try {
			await toggleMcpServer(newServerName.trim(), false);
			setNewServerName('');
			toast.success(`${newServerName.trim()} disabled`);
		} catch (error) {
			console.error('Failed to disable MCP server:', error);
			toast.error('Failed to disable MCP server');
		}
	};

	return (
		<div class="space-y-3">
			<div class="text-xs text-gray-400">
				Globally disabled MCP servers. These servers will not be loaded in any session.
			</div>

			{disabledServers.length === 0 ? (
				<div class="text-center py-3">
					<div class="text-gray-500 text-sm">No servers disabled</div>
				</div>
			) : (
				<div class="space-y-2">
					{disabledServers.map((serverName) => {
						const isToggling = toggling === serverName;
						return (
							<div
								key={serverName}
								class={`flex items-center justify-between p-3 rounded-lg border ${borderColors.ui.secondary} bg-dark-900`}
							>
								<div class="flex-1">
									<span class="text-sm font-medium text-gray-200">{serverName}</span>
									<span class="ml-2 text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-300">
										Disabled
									</span>
								</div>
								<button
									type="button"
									onClick={() => handleToggle(serverName, true)}
									disabled={isToggling}
									class={`
										text-xs px-3 py-1 rounded transition-colors
										${isToggling ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'}
									`}
								>
									{isToggling ? 'Enabling...' : 'Enable'}
								</button>
							</div>
						);
					})}
				</div>
			)}

			{/* Add new disabled server */}
			<form onSubmit={handleAddDisabled} class="flex gap-2">
				<input
					type="text"
					value={newServerName}
					onInput={(e) => setNewServerName((e.target as HTMLInputElement).value)}
					placeholder="Server name to disable..."
					class={`flex-1 px-3 py-2 text-sm bg-dark-900 border ${borderColors.ui.secondary} rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500`}
				/>
				<button
					type="submit"
					disabled={!newServerName.trim()}
					class={`px-4 py-2 text-sm rounded transition-colors ${
						newServerName.trim()
							? 'bg-red-600 hover:bg-red-700 text-white'
							: 'bg-gray-700 text-gray-500 cursor-not-allowed'
					}`}
				>
					Disable
				</button>
			</form>
		</div>
	);
}
