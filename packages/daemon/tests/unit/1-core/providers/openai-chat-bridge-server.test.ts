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
	});
});
