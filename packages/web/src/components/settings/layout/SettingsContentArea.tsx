/**
 * SettingsContentArea - Content area for settings pages
 *
 * Wraps the settings section content with proper layout and scrolling.
 */

import { type ComponentChildren } from 'preact';

export interface SettingsContentAreaProps {
	children: ComponentChildren;
}

export function SettingsContentArea({ children }: SettingsContentAreaProps) {
	return (
		<main class="flex-1 overflow-y-auto">
			<div class="mx-auto max-w-4xl p-6">{children}</div>
		</main>
	);
}
