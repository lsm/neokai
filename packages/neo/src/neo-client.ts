/**
 * Neo Client Transport
 *
 * Creates an in-process connection between Neo (AI client) and daemon.
 * Uses InProcessTransport for zero-overhead communication.
 */

import { MessageHub, InProcessTransport } from '@neokai/shared';

export interface NeoClientConfig {
	name?: string;
	timeout?: number;
}

export interface NeoClientTransport {
	neoClientHub: MessageHub;
	clientTransport: InProcessTransport;
	serverTransport: InProcessTransport;
}

export function createNeoClientTransport(config: NeoClientConfig = {}): NeoClientTransport {
	const name = config.name || 'neo-client';

	// Create paired transports
	const [clientTransport, serverTransport] = InProcessTransport.createPair({
		name,
	});

	// Create Neo's client MessageHub
	const neoClientHub = new MessageHub({
		defaultSessionId: 'global',
		timeout: config.timeout || 60000, // Longer timeout for AI operations
		debug: false,
	});

	// Register client transport with Neo's hub
	neoClientHub.registerTransport(clientTransport);

	return {
		neoClientHub,
		clientTransport,
		serverTransport, // To be registered with daemon's MessageHub
	};
}
