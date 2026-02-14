/**
 * Neo In-Process Communication Tests
 *
 * Tests the in-process communication between Neo (AI client) and daemon
 * using InProcessTransport for zero-overhead messaging.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { createNeoClientTransport } from '@neokai/neo';

describe('Neo In-Process Communication', () => {
	let daemonHub: MessageHub;
	let neoTransport: ReturnType<typeof createNeoClientTransport>;

	beforeEach(async () => {
		// Create Neo client transport
		neoTransport = createNeoClientTransport({ name: 'neo-test' });

		// Create daemon MessageHub
		daemonHub = new MessageHub({ defaultSessionId: 'global' });

		// Register Neo's server transport with daemon
		daemonHub.registerTransport(neoTransport.serverTransport);

		// Initialize Neo's client transport
		await neoTransport.clientTransport.initialize();

		// Register test RPC handlers on daemon
		daemonHub.onRequest('test.echo', async (data) => {
			return { echoed: data };
		});

		daemonHub.onRequest('room.get', async (data) => {
			return {
				room: {
					id: (data as { roomId: string }).roomId,
					name: 'Test Room',
					status: 'active',
				},
			};
		});
	});

	afterEach(async () => {
		neoTransport.neoClientHub.cleanup();
		daemonHub.cleanup();
		await neoTransport.clientTransport.close();
		await neoTransport.serverTransport.close();
	});

	test('should make RPC calls from Neo to daemon', async () => {
		const result = await neoTransport.neoClientHub.request('test.echo', { message: 'hello' });
		expect((result as { echoed: { message: string } }).echoed.message).toBe('hello');
	});

	test('should handle room.get RPC', async () => {
		const result = await neoTransport.neoClientHub.request('room.get', { roomId: 'room-123' });
		const room = (result as { channel: { id: string; name: string; status: string } }).room;
		expect(room.id).toBe('room-123');
		expect(room.name).toBe('Test Room');
	});

	test('should handle multiple sequential RPC calls', async () => {
		const result1 = await neoTransport.neoClientHub.request('test.echo', { count: 1 });
		expect((result1 as { echoed: { count: number } }).echoed.count).toBe(1);

		const result2 = await neoTransport.neoClientHub.request('test.echo', { count: 2 });
		expect((result2 as { echoed: { count: number } }).echoed.count).toBe(2);
	});
});
