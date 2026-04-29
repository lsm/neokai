import { afterEach, describe, expect, it } from 'bun:test';
import {
	anthropicMessagesToResponsesInput,
	createOpenAIResponsesBridgeServer,
	type OpenAIResponsesBridgeServer,
} from '../../../../../src/lib/providers/openai-responses-bridge/server';

const models = [
	{
		id: 'gpt-5.3-codex',
		display_name: 'GPT-5.3 Codex',
		created_at: '2025-12-01T00:00:00Z',
		context_window: 272000,
	},
];

function sse(events: Array<{ event: string; data: object }>): Response {
	return new Response(
		events
			.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
			.join(''),
		{ headers: { 'Content-Type': 'text/event-stream' } }
	);
}

async function readSSEEvents(
	body: ReadableStream<Uint8Array> | null
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
	if (!body) return [];
	const text = await new Response(body).text();
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	for (const block of text.split('\n\n')) {
		if (!block.trim()) continue;
		const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
		const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
		if (!eventLine || !dataLine) continue;
		events.push({
			event: eventLine.slice('event: '.length),
			data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
		});
	}
	return events;
}

function textDeltaEvents(
	events: Array<{ event: string; data: Record<string, unknown> }>
): string[] {
	return events
		.filter((event) => event.event === 'content_block_delta')
		.map((event) => event.data.delta as { text?: string })
		.map((delta) => delta.text ?? '')
		.filter(Boolean);
}

function messageStartEvent(
	events: Array<{ event: string; data: Record<string, unknown> }>
): Record<string, unknown> | undefined {
	return events.find((event) => event.event === 'message_start')?.data;
}

function messageDeltaEvent(
	events: Array<{ event: string; data: Record<string, unknown> }>
): Record<string, unknown> | undefined {
	return events.find((event) => event.event === 'message_delta')?.data;
}

describe('openai-responses-bridge server', () => {
	let server: OpenAIResponsesBridgeServer | undefined;

	afterEach(() => {
		server?.stop();
		server = undefined;
	});

	it('translates Anthropic tool_use/tool_result blocks into Responses function items', () => {
		const input = anthropicMessagesToResponsesInput([
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Checking.' },
					{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'codex' } },
				],
			},
			{
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }],
			},
		]);

		expect(input).toEqual([
			{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'Checking.', annotations: [] }],
			},
			{
				type: 'function_call',
				call_id: 'call_1',
				name: 'lookup',
				arguments: '{"q":"codex"}',
				status: 'completed',
			},
			{ type: 'function_call_output', call_id: 'call_1', output: 'found' },
		]);
	});

	it('streams OpenAI text deltas as Anthropic text SSE', async () => {
		let capturedBody: Record<string, unknown> | undefined;
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async (_url, init) => {
				capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return sse([
					{
						event: 'response.created',
						data: { type: 'response.created', response: { id: 'resp_1' } },
					},
					{
						event: 'response.output_text.delta',
						data: { type: 'response.output_text.delta', delta: 'hel' },
					},
					{
						event: 'response.output_text.delta',
						data: { type: 'response.output_text.delta', delta: 'lo' },
					},
					{
						event: 'response.completed',
						data: {
							type: 'response.completed',
							response: { usage: { input_tokens: 9, output_tokens: 2 }, output: [] },
						},
					},
				]);
			},
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				system: 'Be concise.',
				messages: [{ role: 'user', content: 'Say hello.' }],
				tools: [
					{
						name: 'lookup',
						description: 'Look up data',
						input_schema: { type: 'object', properties: {} },
					},
				],
			}),
		});

		expect(resp.status).toBe(200);
		expect(capturedBody?.model).toBe('gpt-5.3-codex');
		expect(capturedBody?.instructions).toBe('Be concise.');
		expect(capturedBody?.stream).toBe(true);
		expect(capturedBody?.tools).toEqual([
			{
				type: 'function',
				name: 'lookup',
				description: 'Look up data',
				parameters: { type: 'object', properties: {} },
			},
		]);
		const events = await readSSEEvents(resp.body);
		expect(textDeltaEvents(events).join('')).toBe('hello');
		expect(messageDeltaEvent(events)).toMatchObject({
			type: 'message_delta',
			delta: { stop_reason: 'end_turn' },
		});
	});

	it('streams OpenAI function calls as Anthropic tool_use blocks', async () => {
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async () =>
				sse([
					{
						event: 'response.created',
						data: { type: 'response.created', response: { id: 'resp_2' } },
					},
					{
						event: 'response.output_item.added',
						data: {
							type: 'response.output_item.added',
							item: {
								type: 'function_call',
								call_id: 'call_abc',
								name: 'lookup',
								arguments: '',
							},
						},
					},
					{
						event: 'response.function_call_arguments.done',
						data: {
							type: 'response.function_call_arguments.done',
							call_id: 'call_abc',
							name: 'lookup',
							arguments: '{"q":"weather"}',
						},
					},
					{
						event: 'response.completed',
						data: {
							type: 'response.completed',
							response: { usage: { input_tokens: 10, output_tokens: 4 }, output: [] },
						},
					},
				]),
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'Use the tool.' }],
				tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
			}),
		});

		const events = await readSSEEvents(resp.body);
		const start = events.find((event) => event.event === 'content_block_start');
		expect(start?.data).toMatchObject({
			content_block: { type: 'tool_use', id: 'call_abc', name: 'lookup' },
		});
		const delta = events.find((event) => event.event === 'content_block_delta');
		expect(delta?.data).toMatchObject({
			delta: { type: 'input_json_delta', partial_json: '{"q":"weather"}' },
		});
		expect(messageDeltaEvent(events)).toMatchObject({
			type: 'message_delta',
			delta: { stop_reason: 'tool_use' },
		});
	});

	it('continues tool_result turns with previous_response_id', async () => {
		const capturedBodies: Record<string, unknown>[] = [];
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				capturedBodies.push(body);
				if (capturedBodies.length === 1) {
					return sse([
						{
							event: 'response.function_call_arguments.done',
							data: {
								type: 'response.function_call_arguments.done',
								call_id: 'call_abc',
								name: 'lookup',
								arguments: '{"q":"weather"}',
							},
						},
						{
							event: 'response.completed',
							data: {
								type: 'response.completed',
								response: {
									id: 'resp_tool',
									usage: { input_tokens: 10, output_tokens: 4 },
									output: [],
								},
							},
						},
					]);
				}
				return sse([
					{
						event: 'response.output_text.delta',
						data: { type: 'response.output_text.delta', delta: 'done' },
					},
					{
						event: 'response.completed',
						data: {
							type: 'response.completed',
							response: {
								id: 'resp_done',
								usage: { input_tokens: 2, output_tokens: 1 },
								output: [],
							},
						},
					},
				]);
			},
		});

		const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'Use the tool.' }],
				tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
			}),
		});
		await readSSEEvents(first.body);

		const continuationPayload = {
			model: 'gpt-5.3-codex',
			max_tokens: 128,
			system: 'Follow the system guidance. '.repeat(100),
			messages: [
				{ role: 'user', content: 'Use the tool. '.repeat(1000) },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'call_abc',
							name: 'lookup',
							input: { q: 'weather' },
						},
					],
				},
				{
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'call_abc', content: 'found' },
						{ type: 'text', text: 'Summarize this briefly.' },
					],
				},
			],
			tools: [
				{
					name: 'lookup',
					description: 'Search the local index. '.repeat(50),
					input_schema: {
						type: 'object',
						properties: {
							q: { type: 'string', description: 'Detailed lookup query. '.repeat(50) },
						},
					},
				},
			],
		};
		const continuationBody = JSON.stringify(continuationPayload);
		const countResp = await fetch(`http://127.0.0.1:${server.port}/v1/messages/count_tokens`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: continuationBody,
		});
		const count = (await countResp.json()) as { input_tokens: number };
		expect(count.input_tokens).toBeGreaterThan(500);
		expect(count.input_tokens).toBeLessThan(1500);

		const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: continuationBody,
		});
		const events = await readSSEEvents(second.body);

		expect(events.find((event) => event.event === 'content_block_delta')?.data).toMatchObject({
			delta: { text: 'done' },
		});
		const messageStart = messageStartEvent(events);
		const messageStartMessage = messageStart?.message as
			| { usage?: { input_tokens?: number } }
			| undefined;
		expect(messageStartMessage?.usage?.input_tokens).toBeGreaterThan(500);
		expect(messageStartMessage?.usage?.input_tokens).toBeLessThan(1500);
		expect(capturedBodies[1]?.previous_response_id).toBe('resp_tool');
		expect(capturedBodies[1]?.input).toEqual([
			{ type: 'function_call_output', call_id: 'call_abc', output: 'found' },
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Summarize this briefly.' }],
			},
		]);

		const third = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: continuationBody,
		});
		await readSSEEvents(third.body);

		expect(capturedBodies[2]?.previous_response_id).toBeUndefined();
	});

	it('keeps continuation mappings isolated by bridge session', async () => {
		const capturedBodies: Record<string, unknown>[] = [];
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				capturedBodies.push(body);
				if (capturedBodies.length === 1) {
					return sse([
						{
							event: 'response.function_call_arguments.done',
							data: {
								type: 'response.function_call_arguments.done',
								call_id: 'call_shared',
								name: 'lookup',
								arguments: '{"q":"weather"}',
							},
						},
						{
							event: 'response.completed',
							data: {
								type: 'response.completed',
								response: {
									id: 'resp_session_a',
									usage: { input_tokens: 10, output_tokens: 4 },
									output: [],
								},
							},
						},
					]);
				}
				return sse([
					{
						event: 'response.completed',
						data: {
							type: 'response.completed',
							response: {
								id: 'resp_done',
								usage: { input_tokens: 2, output_tokens: 0 },
								output: [],
							},
						},
					},
				]);
			},
		});

		const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer codex-bridge-session-a',
			},
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'Use the tool.' }],
				tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
			}),
		});
		await readSSEEvents(first.body);

		const continuationBody = JSON.stringify({
			model: 'gpt-5.3-codex',
			max_tokens: 128,
			messages: [
				{ role: 'user', content: 'Use the tool.' },
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'call_shared',
							name: 'lookup',
							input: { q: 'weather' },
						},
					],
				},
				{
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'call_shared', content: 'found' }],
				},
			],
			tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
		});
		const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer codex-bridge-session-b',
			},
			body: continuationBody,
		});
		await readSSEEvents(second.body);

		const third = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer codex-bridge-session-a',
			},
			body: continuationBody,
		});
		await readSSEEvents(third.body);

		expect(capturedBodies[1]?.previous_response_id).toBeUndefined();
		const fallbackInput = capturedBodies[1]?.input as Array<Record<string, unknown>>;
		expect(fallbackInput.some((item) => item.type === 'function_call')).toBe(true);
		expect(fallbackInput.some((item) => item.type === 'function_call_output')).toBe(true);
		expect(capturedBodies[2]?.previous_response_id).toBe('resp_session_a');
	});

	it('evicts stale tool_result continuations after the TTL', async () => {
		const capturedBodies: Record<string, unknown>[] = [];
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			continuationTtlMs: 10,
			fetchImpl: async (_url, init) => {
				capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				if (capturedBodies.length === 1) {
					return sse([
						{
							event: 'response.function_call_arguments.done',
							data: {
								type: 'response.function_call_arguments.done',
								call_id: 'call_expired',
								name: 'lookup',
								arguments: '{}',
							},
						},
						{
							event: 'response.completed',
							data: {
								type: 'response.completed',
								response: {
									id: 'resp_expired',
									usage: { input_tokens: 10, output_tokens: 4 },
									output: [],
								},
							},
						},
					]);
				}
				return sse([
					{
						event: 'response.completed',
						data: {
							type: 'response.completed',
							response: {
								id: 'resp_done',
								usage: { input_tokens: 2, output_tokens: 0 },
								output: [],
							},
						},
					},
				]);
			},
		});

		const first = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'Use the tool.' }],
				tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
			}),
		});
		await readSSEEvents(first.body);
		await new Promise((resolve) => setTimeout(resolve, 25));

		const second = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [
					{ role: 'user', content: 'Use the tool.' },
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'call_expired', name: 'lookup', input: {} }],
					},
					{
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 'call_expired', content: 'found' }],
					},
				],
				tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
			}),
		});
		await readSSEEvents(second.body);

		expect(capturedBodies[1]?.previous_response_id).toBeUndefined();
		const fallbackInput = capturedBodies[1]?.input as Array<Record<string, unknown>>;
		expect(fallbackInput.some((item) => item.type === 'function_call')).toBe(true);
		expect(fallbackInput.some((item) => item.type === 'function_call_output')).toBe(true);
	});

	it('maps OpenAI incomplete responses to Anthropic max_tokens stop reason', async () => {
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async () =>
				sse([
					{
						event: 'response.output_text.delta',
						data: { type: 'response.output_text.delta', delta: 'partial' },
					},
					{
						event: 'response.incomplete',
						data: {
							type: 'response.incomplete',
							response: { usage: { input_tokens: 3, output_tokens: 1 } },
						},
					},
				]),
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 1,
				messages: [{ role: 'user', content: 'Say something.' }],
			}),
		});

		const events = await readSSEEvents(resp.body);
		expect(textDeltaEvents(events).join('')).toBe('partial');
		expect(messageDeltaEvent(events)).toMatchObject({
			type: 'message_delta',
			delta: { stop_reason: 'max_tokens' },
		});
	});

	it('returns an Anthropic 502 error when the upstream request fails', async () => {
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async () => {
				throw new Error('network down');
			},
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hi' }],
			}),
		});

		const body = (await resp.json()) as { error: { type: string; message: string } };
		expect(resp.status).toBe(502);
		expect(body.error.type).toBe('api_error');
		expect(body.error.message).toBe('network down');
	});

	it('skips malformed upstream SSE blocks and preserves valid partial trailing data', async () => {
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async () =>
				new Response(
					[
						'event: response.output_text.delta',
						'data: not-json',
						'',
						'event: response.output_text.delta',
						'data: {"type":"response.output_text.delta","delta":"ok"}',
					].join('\n'),
					{ headers: { 'Content-Type': 'text/event-stream' } }
				),
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hi' }],
			}),
		});

		const events = await readSSEEvents(resp.body);
		expect(resp.status).toBe(200);
		expect(textDeltaEvents(events).join('')).toBe('ok');
		expect(messageDeltaEvent(events)).toMatchObject({
			type: 'message_delta',
			delta: { stop_reason: 'end_turn' },
		});
	});

	it('maps upstream streaming failures to Anthropic SSE errors', async () => {
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async () =>
				sse([
					{
						event: 'response.output_text.delta',
						data: { type: 'response.output_text.delta', delta: 'partial' },
					},
					{
						event: 'response.failed',
						data: {
							type: 'response.failed',
							response: {
								id: 'resp_failed',
								error: { message: 'stream failed upstream' },
							},
						},
					},
				]),
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hi' }],
			}),
		});

		const events = await readSSEEvents(resp.body);
		expect(resp.status).toBe(200);
		expect(textDeltaEvents(events).join('')).toBe('partial');
		expect(events.find((event) => event.event === 'error')?.data).toMatchObject({
			type: 'error',
			error: { type: 'api_error', message: 'stream failed upstream' },
		});
		expect(events.at(-1)?.event).toBe('message_stop');
		expect(messageDeltaEvent(events)).toBeUndefined();
	});

	it('maps upstream streaming error events to Anthropic SSE errors', async () => {
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async () =>
				sse([
					{
						event: 'error',
						data: {
							type: 'error',
							error: { message: 'invalid stream request' },
						},
					},
				]),
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hi' }],
			}),
		});

		const events = await readSSEEvents(resp.body);
		expect(resp.status).toBe(200);
		expect(events.find((event) => event.event === 'error')?.data).toMatchObject({
			type: 'error',
			error: { type: 'api_error', message: 'invalid stream request' },
		});
		expect(events.at(-1)?.event).toBe('message_stop');
		expect(messageDeltaEvent(events)).toBeUndefined();
	});

	it('maps upstream 429 responses to Anthropic rate_limit_error', async () => {
		server = createOpenAIResponsesBridgeServer({
			auth: { source: 'api_key', apiKey: 'sk-test' },
			models,
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: { message: 'slow down' } }), {
					status: 429,
					headers: { 'Content-Type': 'application/json' },
				}),
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hi' }],
			}),
		});

		const body = (await resp.json()) as { error: { type: string; message: string } };
		expect(resp.status).toBe(429);
		expect(body.error.type).toBe('rate_limit_error');
		expect(body.error.message).toBe('slow down');
	});

	it('uses Codex ChatGPT OAuth endpoint and account header for OAuth auth', async () => {
		let capturedUrl = '';
		let capturedHeaders: Headers | undefined;
		server = createOpenAIResponsesBridgeServer({
			auth: {
				source: 'chatgpt_oauth',
				apiKey: 'oauth-token',
				accountId: 'acct_123',
				isFedrampAccount: true,
			},
			models,
			fetchImpl: async (url, init) => {
				capturedUrl = String(url);
				capturedHeaders = new Headers(init?.headers);
				return sse([
					{
						event: 'response.completed',
						data: {
							type: 'response.completed',
							response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
						},
					},
				]);
			},
		});

		await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hi' }],
			}),
		});

		expect(capturedUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
		expect(capturedHeaders?.get('authorization')).toBe('Bearer oauth-token');
		expect(capturedHeaders?.get('chatgpt-account-id')).toBe('acct_123');
		expect(capturedHeaders?.get('x-openai-fedramp')).toBe('true');
	});

	it('refreshes ChatGPT OAuth auth once after an upstream 401 and reuses it', async () => {
		const seenAuthHeaders: string[] = [];
		server = createOpenAIResponsesBridgeServer({
			auth: {
				source: 'chatgpt_oauth',
				apiKey: 'expired-token',
				accountId: 'acct_old',
				refreshAuthTokens: async () => ({
					accessToken: 'fresh-token',
					accountId: 'acct_new',
				}),
			},
			models,
			fetchImpl: async (_url, init) => {
				const headers = new Headers(init?.headers);
				seenAuthHeaders.push(
					`${headers.get('authorization')}:${headers.get('chatgpt-account-id')}`
				);
				if (seenAuthHeaders.length === 1) {
					return new Response(JSON.stringify({ error: { message: 'expired' } }), {
						status: 401,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return sse([
					{
						event: 'response.completed',
						data: {
							type: 'response.completed',
							response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
						},
					},
				]);
			},
		});

		const body = JSON.stringify({
			model: 'gpt-5.3-codex',
			max_tokens: 128,
			messages: [{ role: 'user', content: 'hi' }],
		});
		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});
		const secondResp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});

		expect(resp.status).toBe(200);
		expect(secondResp.status).toBe(200);
		expect(seenAuthHeaders).toEqual([
			'Bearer expired-token:acct_old',
			'Bearer fresh-token:acct_new',
			'Bearer fresh-token:acct_new',
		]);
	});

	it('propagates the original 401 when ChatGPT OAuth refresh is unavailable', async () => {
		let refreshAttempts = 0;
		server = createOpenAIResponsesBridgeServer({
			auth: {
				source: 'chatgpt_oauth',
				apiKey: 'expired-token',
				accountId: 'acct_old',
				refreshAuthTokens: async () => {
					refreshAttempts += 1;
					return null;
				},
			},
			models,
			fetchImpl: async () =>
				new Response(JSON.stringify({ error: { message: 'expired' } }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				}),
		});

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-5.3-codex',
				max_tokens: 128,
				messages: [{ role: 'user', content: 'hi' }],
			}),
		});

		const body = (await resp.json()) as { error: { type: string; message: string } };
		expect(refreshAttempts).toBe(1);
		expect(resp.status).toBe(401);
		expect(body.error.type).toBe('authentication_error');
		expect(body.error.message).toBe('expired');
	});
});
