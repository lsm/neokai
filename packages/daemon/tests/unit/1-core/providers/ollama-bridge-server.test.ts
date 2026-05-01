import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
	createOllamaAnthropicBridgeServer,
	type OllamaBridgeServer,
} from '../../../../src/lib/providers/ollama-bridge-server';

describe('Ollama Anthropic bridge server', () => {
	const servers: OllamaBridgeServer[] = [];

	afterEach(() => {
		for (const server of servers.splice(0)) server.stop();
	});

	it('translates Anthropic messages to Ollama /api/chat and streams Anthropic SSE', async () => {
		let capturedRequest: unknown;
		const fetchMock = mock(async (_url: string, init?: RequestInit) => {
			capturedRequest = JSON.parse(String(init?.body));
			const body = [
				JSON.stringify({
					model: 'llama3.2',
					message: { role: 'assistant', content: 'Hello' },
					done: false,
				}),
				JSON.stringify({
					model: 'llama3.2',
					message: { role: 'assistant', content: ' there' },
					done: false,
				}),
				JSON.stringify({ model: 'llama3.2', done: true, prompt_eval_count: 9, eval_count: 2 }),
			].join('\n');
			return new Response(body, { status: 200 });
		});
		const server = createOllamaAnthropicBridgeServer({
			baseUrl: 'http://ollama.test',
			apiKey: 'cloud-key',
			fetchImpl: fetchMock as typeof fetch,
		});
		servers.push(server);

		const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'llama3.2',
				system: 'You are helpful.',
				messages: [{ role: 'user', content: 'Say hello' }],
				max_tokens: 32,
				stream: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/event-stream');
		expect(fetchMock).toHaveBeenCalledWith('http://ollama.test/api/chat', expect.any(Object));
		expect(capturedRequest).toEqual({
			model: 'llama3.2',
			messages: [
				{ role: 'system', content: 'You are helpful.' },
				{ role: 'user', content: 'Say hello' },
			],
			stream: true,
			options: { num_predict: 32 },
		});
		const text = await response.text();
		expect(text).toContain('event: message_start');
		expect(text).toContain('"text":"Hello"');
		expect(text).toContain('"text":" there"');
		expect(text).toContain('event: message_stop');
	});

	it('maps upstream failures to Anthropic JSON errors', async () => {
		const fetchMock = mock(async () => new Response('Unauthorized', { status: 401 }));
		const server = createOllamaAnthropicBridgeServer({
			baseUrl: 'https://ollama.com',
			apiKey: 'bad-key',
			fetchImpl: fetchMock as typeof fetch,
		});
		servers.push(server);

		const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'gpt-oss:120b-cloud',
				messages: [{ role: 'user', content: 'Hi' }],
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(401);
		expect(body.error.type).toBe('authentication_error');
		expect(body.error.message).toContain('Unauthorized');
	});
});
