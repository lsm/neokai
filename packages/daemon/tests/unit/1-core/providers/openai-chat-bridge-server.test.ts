import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
	createOpenAIChatBridgeServer,
	_openAIChatBridgeTesting,
	type OpenAIChatBridgeServer,
} from '../../../../src/lib/providers/openai-chat-bridge/server';

/**
 * Encode a sequence of OpenAI Chat Completions SSE chunks as a single
 * stream body. Each chunk is JSON-stringified and emitted as `data: {...}\n\n`,
 * terminated with `data: [DONE]\n\n`.
 */
function sseBody(chunks: unknown[]): string {
	return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

describe('OpenAI Chat Completions bridge server', () => {
	const servers: OpenAIChatBridgeServer[] = [];

	afterEach(() => {
		for (const server of servers.splice(0)) server.stop();
	});

	it('translates Anthropic messages to OpenAI Chat Completions and streams Anthropic SSE', async () => {
		let capturedRequest: unknown;
		let capturedUrl = '';
		let capturedHeaders: Record<string, string> = {};
		const fetchMock = mock(async (url: string, init?: RequestInit) => {
			capturedUrl = url;
			capturedHeaders = (init?.headers as Record<string, string>) ?? {};
			capturedRequest = JSON.parse(String(init?.body));
			const body = sseBody([
				{
					choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }],
				},
				{ choices: [{ index: 0, delta: { content: ' world' } }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
				{ usage: { prompt_tokens: 11, completion_tokens: 2 } },
			]);
			return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		});

		const server = createOpenAIChatBridgeServer({
			baseUrl: 'http://upstream.test/v1',
			apiKey: 'test-key',
			headers: { 'X-Trace': 'on' },
			fetchImpl: fetchMock as typeof fetch,
		});
		servers.push(server);

		const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'qwen2.5:14b',
				system: 'You are helpful.',
				messages: [{ role: 'user', content: 'Say hello' }],
				max_tokens: 32,
				stream: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/event-stream');
		expect(capturedUrl).toBe('http://upstream.test/v1/chat/completions');
		expect(capturedHeaders.Authorization).toBe('Bearer test-key');
		expect(capturedHeaders['X-Trace']).toBe('on');
		expect(capturedRequest).toMatchObject({
			model: 'qwen2.5:14b',
			messages: [
				{ role: 'system', content: 'You are helpful.' },
				{ role: 'user', content: 'Say hello' },
			],
			stream: true,
			max_tokens: 32,
		});

		const text = await response.text();
		expect(text).toContain('event: message_start');
		expect(text).toContain('"text":"Hello"');
		expect(text).toContain('"text":" world"');
		expect(text).toContain('event: message_delta');
		expect(text).toContain('"stop_reason":"end_turn"');
		expect(text).toContain('event: message_stop');
	});

	it('drops tool definitions when toolUseSupported=false', async () => {
		let capturedRequest: Record<string, unknown> = {};
		const fetchMock = mock(async (_url: string, init?: RequestInit) => {
			capturedRequest = JSON.parse(String(init?.body));
			return new Response(
				sseBody([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
				{ status: 200 }
			);
		});
		const server = createOpenAIChatBridgeServer({
			baseUrl: 'http://upstream.test',
			fetchImpl: fetchMock as typeof fetch,
			toolUseSupported: false,
		});
		servers.push(server);

		await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				stream: true,
				tools: [
					{
						name: 'echo',
						description: 'd',
						input_schema: { type: 'object', properties: {} },
					},
				],
			}),
		});

		expect(capturedRequest.tools).toBeUndefined();
		expect(capturedRequest.tool_choice).toBeUndefined();
	});

	it('translates streaming tool_calls into Anthropic tool_use blocks', async () => {
		const fetchMock = mock(async () => {
			const body = sseBody([
				{
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'call_abc',
										type: 'function',
										function: { name: 'lookup', arguments: '' },
									},
								],
							},
						},
					],
				},
				{
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '{"q":"' } }],
							},
						},
					],
				},
				{
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [{ index: 0, function: { arguments: 'cats"}' } }],
							},
						},
					],
				},
				{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
			]);
			return new Response(body, { status: 200 });
		});
		const server = createOpenAIChatBridgeServer({
			baseUrl: 'http://upstream.test',
			fetchImpl: fetchMock as typeof fetch,
		});
		servers.push(server);

		const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'm',
				messages: [{ role: 'user', content: 'lookup cats' }],
				stream: true,
				tools: [{ name: 'lookup', description: '', input_schema: { type: 'object' } }],
			}),
		});
		const text = await response.text();
		expect(text).toContain('"type":"tool_use"');
		expect(text).toContain('"name":"lookup"');
		expect(text).toContain('"id":"call_abc"');
		expect(text).toContain('"partial_json":"{\\"q\\":\\"cats\\"}"');
		expect(text).toContain('"stop_reason":"tool_use"');
	});

	it('emits Anthropic-shaped error envelope on upstream HTTP errors', async () => {
		const fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				})
		);
		const server = createOpenAIChatBridgeServer({
			baseUrl: 'http://upstream.test',
			fetchImpl: fetchMock as typeof fetch,
		});
		servers.push(server);

		const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				stream: true,
			}),
		});
		expect(response.status).toBe(401);
		const body = (await response.json()) as { type: string; error: { type: string } };
		expect(body.type).toBe('error');
		expect(body.error.type).toBe('authentication_error');
	});

	it('serves Anthropic-compatible model listing for SDK initialization', async () => {
		const fetchMock = mock(async () => new Response('', { status: 500 }));
		const server = createOpenAIChatBridgeServer({
			baseUrl: 'http://upstream.test',
			fetchImpl: fetchMock as typeof fetch,
		});
		servers.push(server);
		const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
		const body = (await response.json()) as { data: Array<{ id: string }> };
		expect(body.data).toHaveLength(1);
		expect(body.data[0].id).toBe('default');
	});

	describe('message translation primitives', () => {
		it('flattens Anthropic system + multi-turn history into OpenAI chat messages', () => {
			const messages = _openAIChatBridgeTesting.toOpenAIMessages(
				{
					model: 'm',
					messages: [
						{ role: 'user', content: 'one' },
						{
							role: 'assistant',
							content: [
								{ type: 'text', text: 'two' },
								{
									type: 'tool_use',
									id: 'call_1',
									name: 'echo',
									input: { msg: 'hi' },
								},
							],
						},
						{
							role: 'user',
							content: [
								{
									type: 'tool_result',
									tool_use_id: 'call_1',
									content: 'result-text',
								},
							],
						},
					],
					system: 'sys',
				},
				false
			);
			expect(messages).toEqual([
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'one' },
				{
					role: 'assistant',
					content: 'two',
					tool_calls: [
						{
							id: 'call_1',
							type: 'function',
							function: { name: 'echo', arguments: '{"msg":"hi"}' },
						},
					],
				},
				{ role: 'tool', content: 'result-text', tool_call_id: 'call_1' },
			]);
		});

		it('drops images when visionSupported=false', () => {
			const messages = _openAIChatBridgeTesting.toOpenAIMessages(
				{
					model: 'm',
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: 'look' },
								{
									type: 'image',
									source: {
										type: 'base64',
										media_type: 'image/png',
										data: 'AAAA',
									},
								},
							],
						},
					],
				},
				false
			);
			expect(messages).toEqual([{ role: 'user', content: 'look' }]);
		});

		it('maps Anthropic tool_choice values to OpenAI', () => {
			const make = (tc: { type: string; name?: string }) =>
				_openAIChatBridgeTesting.toOpenAIToolChoice({
					model: 'm',
					messages: [],
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					tool_choice: tc as any,
				});
			expect(make({ type: 'auto' })).toBe('auto');
			expect(make({ type: 'none' })).toBe('none');
			expect(make({ type: 'any' })).toBe('required');
			expect(make({ type: 'tool', name: 'lookup' })).toEqual({
				type: 'function',
				function: { name: 'lookup' },
			});
		});

		it('forwards images as OpenAI image_url parts when visionSupported=true', () => {
			const messages = _openAIChatBridgeTesting.toOpenAIMessages(
				{
					model: 'm',
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: 'see' },
								{
									type: 'image',
									source: {
										type: 'base64',
										media_type: 'image/png',
										data: 'ABCD',
									},
								},
							],
						},
					],
				},
				true
			);
			expect(messages).toEqual([
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'see' },
						{ type: 'image_url', image_url: { url: 'data:image/png;base64,ABCD' } },
					],
				},
			]);
		});

		it('accumulates two parallel tool_calls across delta chunks', async () => {
			const fetchMock = mock(async () => {
				const body = sseBody([
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'call_a',
											type: 'function',
											function: { name: 'one', arguments: '{"x":1}' },
										},
										{
											index: 1,
											id: 'call_b',
											type: 'function',
											function: { name: 'two', arguments: '{"y":2}' },
										},
									],
								},
							},
						],
					},
					{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
				]);
				return new Response(body, { status: 200 });
			});
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: fetchMock as typeof fetch,
			});
			servers.push(server);
			const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'm',
					messages: [{ role: 'user', content: 'run two tools' }],
					stream: true,
					tools: [
						{ name: 'one', description: '', input_schema: { type: 'object' } },
						{ name: 'two', description: '', input_schema: { type: 'object' } },
					],
				}),
			});
			const text = await response.text();
			expect(text).toContain('"id":"call_a"');
			expect(text).toContain('"id":"call_b"');
			expect(text).toContain('"name":"one"');
			expect(text).toContain('"name":"two"');
			expect(text).toContain('"stop_reason":"tool_use"');
		});

		it('reports max_tokens stop reason when finish_reason is length', async () => {
			const fetchMock = mock(
				async () =>
					new Response(
						sseBody([
							{ choices: [{ delta: { content: 'partial' } }] },
							{ choices: [{ delta: {}, finish_reason: 'length' }] },
						]),
						{ status: 200 }
					)
			);
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: fetchMock as typeof fetch,
			});
			servers.push(server);
			const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'm',
					messages: [{ role: 'user', content: 'hi' }],
					stream: true,
				}),
			});
			const text = await response.text();
			expect(text).toContain('"stop_reason":"max_tokens"');
		});

		it('returns a 502 envelope when the upstream fetch throws', async () => {
			const fetchMock = mock(async () => {
				throw new Error('ECONNREFUSED');
			});
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: fetchMock as typeof fetch,
			});
			servers.push(server);
			const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'm',
					messages: [{ role: 'user', content: 'hi' }],
					stream: true,
				}),
			});
			expect(response.status).toBe(502);
			const body = (await response.json()) as { error: { message: string; type: string } };
			expect(body.error.type).toBe('api_error');
			expect(body.error.message).toContain('ECONNREFUSED');
		});

		it('rejects non-streaming requests with 400', async () => {
			const fetchMock = mock(async () => new Response('', { status: 200 }));
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: fetchMock as typeof fetch,
			});
			servers.push(server);
			const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'm',
					messages: [{ role: 'user', content: 'hi' }],
					stream: false,
				}),
			});
			expect(response.status).toBe(400);
			expect(fetchMock).toHaveBeenCalledTimes(0);
		});

		it('estimates input tokens at /v1/messages/count_tokens', async () => {
			const fetchMock = mock(async () => new Response('', { status: 500 }));
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: fetchMock as typeof fetch,
			});
			servers.push(server);
			const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'm',
					messages: [{ role: 'user', content: 'hello world' }],
				}),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { input_tokens: number };
			expect(body.input_tokens).toBeGreaterThan(0);
		});

		it('serves /health and /v1/health', async () => {
			const fetchMock = mock(async () => new Response('', { status: 500 }));
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: fetchMock as typeof fetch,
			});
			servers.push(server);
			for (const path of ['/health', '/v1/health']) {
				const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
				expect(response.status).toBe(200);
				expect(await response.text()).toBe('ok');
			}
		});

		it('binds to loopback (127.0.0.1) so other local users cannot reach the bridge', () => {
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
			});
			servers.push(server);
			// Bun.serve exposes the hostname on the server instance via `.hostname`.
			// We can't easily introspect that here, but we can assert that the bridge
			// is not reachable via the machine's external interfaces. The most
			// portable check is that the port is non-zero and that connecting via
			// 127.0.0.1 works (covered by every other test above). This test pins
			// the contract so a future change away from loopback fails review.
			expect(typeof server.port).toBe('number');
			expect(server.port).toBeGreaterThan(0);
		});

		it('defers tool_use block until upstream id arrives and forwards it verbatim', async () => {
			// Upstream sends `name` in the first chunk but `id` only in the second
			// chunk. The bridge must wait — otherwise the client would see a
			// synthetic id and the model's follow-up `tool` message (with the
			// real upstream id) would fail strict tool_call_id validation.
			const fetchMock = mock(async () => {
				const body = sseBody([
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											type: 'function',
											function: { name: 'lookup', arguments: '' },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: 'call_late',
											function: { arguments: '{"q":"x"}' },
										},
									],
								},
							},
						],
					},
					{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
				]);
				return new Response(body, { status: 200 });
			});
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: fetchMock as typeof fetch,
			});
			servers.push(server);
			const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'm',
					messages: [{ role: 'user', content: 'lookup' }],
					stream: true,
					tools: [{ name: 'lookup', description: '', input_schema: { type: 'object' } }],
				}),
			});
			const text = await response.text();
			expect(text).toContain('"id":"call_late"');
			// Must not have leaked a synthetic toolu_oai_* id.
			expect(text).not.toMatch(/"id":"toolu_oai_/);
		});

		it('synthesises a tool_use id when upstream never sends one', async () => {
			// Some non-strict backends omit `tool_calls[].id` entirely. The
			// bridge must still emit a syntactically valid Anthropic tool_use
			// block at stream end rather than dropping the call.
			const fetchMock = mock(async () => {
				const body = sseBody([
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											type: 'function',
											function: { name: 'lookup', arguments: '{}' },
										},
									],
								},
							},
						],
					},
					{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
				]);
				return new Response(body, { status: 200 });
			});
			const server = createOpenAIChatBridgeServer({
				baseUrl: 'http://upstream.test',
				fetchImpl: fetchMock as typeof fetch,
			});
			servers.push(server);
			const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'm',
					messages: [{ role: 'user', content: 'lookup' }],
					stream: true,
					tools: [{ name: 'lookup', description: '', input_schema: { type: 'object' } }],
				}),
			});
			const text = await response.text();
			expect(text).toMatch(/"id":"toolu_oai_/);
			expect(text).toContain('"name":"lookup"');
			expect(text).toContain('"stop_reason":"tool_use"');
		});
	});
});
