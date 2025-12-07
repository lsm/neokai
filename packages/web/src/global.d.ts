/**
 * Global type augmentations for the web package
 */

import type { MessageHub } from '@liuboer/shared';
import type { Signal } from '@preact/signals';
import type { ConnectionManager } from './lib/connection-manager';
import type { AppState } from './lib/state';

declare global {
	interface Window {
		// MessageHub exposed for testing/debugging
		__messageHub?: MessageHub;
		__messageHubReady?: boolean;

		// App state exposed for testing/debugging
		appState?: typeof AppState;

		// Connection manager exposed for testing
		connectionManager?: ConnectionManager;

		// Current session ID signal for testing
		currentSessionIdSignal?: Signal<string | null>;
	}
}

export {};
