/**
 * Global command palette (Cmd+K).
 *
 * Rendered once at the App root. Visibility is controlled by
 * `commandPaletteOpenSignal`. The list of commands and its fuzzy search are
 * provided by `commandRegistry`.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import {
	Combobox,
	ComboboxInput,
	ComboboxOption,
	ComboboxOptions,
	Dialog,
	DialogBackdrop,
	DialogPanel,
} from '@neokai/ui';
import { commandPaletteOpenSignal } from '../lib/signals.ts';
import {
	commandRegistry,
	categoryLabel,
	type CommandCategory,
	type CommandDescriptor,
	type RankedCommand,
} from '../lib/command-registry.ts';

function groupByCategory(results: readonly RankedCommand[]) {
	const groups = new Map<CommandCategory, CommandDescriptor[]>();
	for (const { command } of results) {
		const list = groups.get(command.category) ?? [];
		list.push(command);
		groups.set(command.category, list);
	}
	return Array.from(groups.entries());
}

export function CommandPalette() {
	const open = commandPaletteOpenSignal.value;
	const [query, setQuery] = useState('');
	// version state forces a recompute of the search result when the registry
	// changes (e.g. defaults are registered after first render).
	const [, setRegistryVersion] = useState(0);

	useEffect(() => {
		// Reset query each time the palette opens.
		if (open) {
			setQuery('');
			setRegistryVersion((v) => v + 1);
		}
	}, [open]);

	const results = useMemo(() => commandRegistry.search(query), [query, open]);
	const groups = useMemo(() => groupByCategory(results), [results]);

	function handleClose() {
		commandPaletteOpenSignal.value = false;
		setQuery('');
	}

	function handleSelect(cmd: CommandDescriptor | null) {
		if (!cmd) return;
		try {
			void cmd.run();
		} finally {
			// run() handlers are expected to close the palette themselves when
			// they navigate; close defensively in case they don't.
			commandPaletteOpenSignal.value = false;
			setQuery('');
		}
	}

	return (
		<Dialog open={open} onClose={handleClose} class="relative z-50">
			<DialogBackdrop class="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity data-[closed]:opacity-0 data-[enter]:duration-200 data-[enter]:ease-out data-[leave]:duration-150 data-[leave]:ease-in" />

			<div class="fixed inset-0 z-10 overflow-y-auto p-4 sm:p-6 md:p-20">
				<DialogPanel class="mx-auto max-w-2xl transform divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-1 shadow-2xl border border-surface-border transition-all data-[closed]:scale-95 data-[closed]:opacity-0 data-[enter]:duration-200 data-[enter]:ease-out data-[leave]:duration-150 data-[leave]:ease-in">
					<Combobox onChange={handleSelect}>
						<div class="grid grid-cols-1">
							<ComboboxInput
								autoFocus
								class="col-start-1 row-start-1 h-14 w-full pr-4 pl-12 text-base text-text-primary bg-transparent outline-none placeholder:text-text-muted"
								placeholder="Search commands..."
								displayValue={() => query}
								onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
							/>
							<span
								class="col-start-1 row-start-1 ml-4 self-center text-text-tertiary pointer-events-none"
								aria-hidden="true"
							>
								<svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
									<path
										fill-rule="evenodd"
										d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
										clip-rule="evenodd"
									/>
								</svg>
							</span>
						</div>

						<ComboboxOptions static class="max-h-80 scroll-py-2 overflow-y-auto">
							{groups.length === 0 ? (
								<li class="px-6 py-14 text-center" data-testid="command-palette-empty">
									<p class="text-sm text-text-secondary">No commands match "{query}"</p>
								</li>
							) : (
								groups.map(([category, commands]) => (
									<li key={category} class="p-2">
										<h2 class="px-3 py-2 text-xs font-semibold text-text-tertiary uppercase tracking-wider">
											{categoryLabel(category)}
										</h2>
										<ul class="text-sm text-text-secondary">
											{commands.map((cmd) => (
												<ComboboxOption
													key={cmd.id}
													value={cmd}
													class="group flex cursor-pointer items-center rounded-lg px-3 py-2.5 select-none data-[focus]:bg-accent-500 data-[focus]:text-white transition-colors"
												>
													<span class="ml-1 flex-auto truncate">
														<span class="block truncate">{cmd.label}</span>
														{cmd.description && (
															<span class="block truncate text-xs text-text-muted group-data-[focus]:text-accent-100">
																{cmd.description}
															</span>
														)}
													</span>
													{cmd.shortcut && (
														<kbd class="ml-3 flex-none px-1.5 py-0.5 text-xs font-mono rounded bg-surface-3 group-data-[focus]:bg-accent-600 text-text-muted group-data-[focus]:text-accent-200 border border-surface-border group-data-[focus]:border-accent-400">
															{cmd.shortcut.display}
														</kbd>
													)}
												</ComboboxOption>
											))}
										</ul>
									</li>
								))
							)}
						</ComboboxOptions>

						<div class="flex items-center justify-between border-t border-surface-border px-4 py-3 text-xs text-text-muted">
							<div class="flex items-center gap-4">
								<span class="flex items-center gap-1">
									<kbd class="px-1 py-0.5 bg-surface-3 border border-surface-border rounded font-mono">
										↑↓
									</kbd>
									<span>Navigate</span>
								</span>
								<span class="flex items-center gap-1">
									<kbd class="px-1 py-0.5 bg-surface-3 border border-surface-border rounded font-mono">
										↵
									</kbd>
									<span>Run</span>
								</span>
								<span class="flex items-center gap-1">
									<kbd class="px-1 py-0.5 bg-surface-3 border border-surface-border rounded font-mono">
										esc
									</kbd>
									<span>Close</span>
								</span>
							</div>
						</div>
					</Combobox>
				</DialogPanel>
			</div>
		</Dialog>
	);
}
