import type { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub } from '@neokai/shared';
import { Logger } from '../../logger';
import { verifySignature } from '../../github/webhook-handler';
import type {
	ExternalEventExtensionConfigStore,
	ExternalEventExtensionContext,
	HttpExternalEventExtension,
	RpcExternalEventExtension,
	SpaceExternalEventSourceConfig,
} from '../types';
import {
	normalizeGitHubPollingRow,
	normalizeGitHubWebhook,
	toExternalEvent,
} from './github-normalizer';
import {
	GitHubEventExtensionRepository,
	type GitHubWatchedRepo,
	type PollCursor,
} from './github-repository';

const log = new Logger('github-event-extension');
const DEFAULT_POLL_INTERVAL_MS = 60_000;

interface GitHubEventExtensionOptions {
	githubToken?: string;
	pollIntervalMs?: number;
	onWatchedReposChanged?: () => void;
}

export class GitHubEventExtension implements HttpExternalEventExtension, RpcExternalEventExtension {
	readonly sourceId = 'github';
	readonly routes = [
		{
			method: 'POST',
			path: '/webhook/github/space',
			handle: (req: Request, _context: ExternalEventExtensionContext) => this.handleWebhook(req),
		},
	] as const;

	readonly repo: GitHubEventExtensionRepository;
	private context?: ExternalEventExtensionContext;
	private pollTimer?: ReturnType<typeof setTimeout>;
	private activePollCycle?: Promise<void>;
	private stopped = true;

	constructor(
		dbOrRepo: BunDatabase | GitHubEventExtensionRepository,
		private readonly options: GitHubEventExtensionOptions = {}
	) {
		this.repo =
			dbOrRepo instanceof GitHubEventExtensionRepository
				? dbOrRepo
				: new GitHubEventExtensionRepository(dbOrRepo);
	}

	async start(context: ExternalEventExtensionContext): Promise<void> {
		this.context = context;
		this.stopped = false;
		if (!(await this.isPollingGloballyEnabled())) return;
		this.scheduleNextPoll();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
		await this.activePollCycle;
	}

	registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void {
		hub.onRequest('space.github.enable', async (data) => {
			const params = data as { spaceId: string };
			if (!params.spaceId) throw new Error('spaceId is required');
			this.repo.setRepoEnabled(params.spaceId, true);
			this.options.onWatchedReposChanged?.();
			context.onSourceConfigChanged({
				source: this.sourceId,
				spaceId: params.spaceId,
				kind: 'space_enabled',
			});
			return { spaceId: params.spaceId, source: this.sourceId, enabled: true };
		});

		hub.onRequest('space.github.disable', async (data) => {
			const params = data as { spaceId: string };
			if (!params.spaceId) throw new Error('spaceId is required');
			this.repo.setRepoEnabled(params.spaceId, false);
			this.options.onWatchedReposChanged?.();
			context.onSourceConfigChanged({
				source: this.sourceId,
				spaceId: params.spaceId,
				kind: 'space_disabled',
			});
			return { spaceId: params.spaceId, source: this.sourceId, enabled: false };
		});

		hub.onRequest('space.github.watchRepo', async (data) => {
			const params = data as {
				spaceId: string;
				owner: string;
				repo: string;
				webhookSecret?: string;
				webhookEnabled?: boolean;
				pollingEnabled?: boolean;
				enabled?: boolean;
			};
			if (!params.spaceId || !params.owner || !params.repo) {
				throw new Error('spaceId, owner and repo are required');
			}
			const watchedRepo = this.repo.upsertWatchedRepo({
				spaceId: params.spaceId,
				owner: params.owner,
				repo: params.repo,
				webhookSecret: params.webhookSecret,
				webhookEnabled: params.webhookEnabled,
				pollingEnabled: params.pollingEnabled,
				enabled: params.enabled,
			});
			this.options.onWatchedReposChanged?.();
			context.onSourceConfigChanged({
				source: this.sourceId,
				spaceId: watchedRepo.spaceId,
				kind: 'watched_repo_changed',
			});
			return { watchedRepo, webhookUrl: '/webhook/github/space' };
		});

		hub.onRequest('space.github.listWatchedRepos', async (data) => {
			const params = data as { spaceId?: string };
			if (!params.spaceId) throw new Error('spaceId is required');
			return {
				repositories: this.repo.listWatchedRepos(params.spaceId).map((repo) => ({
					...repo,
					webhookSecret: repo.webhookSecret ? 'configured' : null,
				})),
			};
		});

		hub.onRequest('space.github.pollOnce', async (data) => {
			const params = (data ?? {}) as { spaceId?: string };
			return {
				count: params.spaceId
					? await this.pollSpace(params.spaceId)
					: await this.pollEnabledSpaces(),
			};
		});
	}

	private async handleWebhook(req: Request): Promise<Response> {
		if (!this.context)
			return Response.json({ error: 'GitHub extension not started' }, { status: 503 });
		const global = await this.context.config.getGlobalConfig(this.sourceId);
		if (!global.globallyEnabled || global.capabilities.webhooks === false) {
			return Response.json(
				{ message: 'Event ignored', reason: 'github_extension_disabled' },
				{ status: 202 }
			);
		}

		const signature = req.headers.get('X-Hub-Signature-256');
		const eventType = req.headers.get('X-GitHub-Event');
		const deliveryId = req.headers.get('X-GitHub-Delivery');
		if (!signature) return Response.json({ error: 'Missing signature header' }, { status: 401 });
		if (!eventType || !deliveryId)
			return Response.json({ error: 'Missing GitHub event headers' }, { status: 400 });

		const raw = await req.text();
		const signatureMatchedRepos: GitHubWatchedRepo[] = [];
		for (const repo of this.repo.listEnabledWebhookRepos()) {
			if (repo.webhookSecret && (await verifySignature(raw, signature, repo.webhookSecret))) {
				signatureMatchedRepos.push(repo);
			}
		}
		if (signatureMatchedRepos.length === 0) {
			return Response.json({ error: 'Invalid signature' }, { status: 401 });
		}

		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
		}

		const normalized = normalizeGitHubWebhook(eventType, deliveryId, payload);
		if (!normalized)
			return Response.json({ message: 'Event ignored', deliveryId }, { status: 202 });

		const validForRepo = signatureMatchedRepos.filter(
			(r) =>
				r.owner.toLowerCase() === normalized.repoOwner.toLowerCase() &&
				r.repo.toLowerCase() === normalized.repoName.toLowerCase()
		);
		if (validForRepo.length === 0)
			return Response.json({ error: 'Repository is not watched' }, { status: 404 });

		let published = 0;
		for (const repo of validForRepo) {
			const spaceConfig = await this.context.config.getSpaceConfig(repo.spaceId, this.sourceId);
			if (spaceConfig && !spaceConfig.enabled) continue;
			await this.publishNormalizedEvent(repo.spaceId, normalized);
			this.repo.markWebhookReceived(repo.id);
			published++;
		}

		return Response.json({ message: 'Webhook received', deliveryId, spaces: published });
	}

	private async pollEnabledSpaces(): Promise<number> {
		if (!this.context) return 0;
		if (!(await this.isPollingGloballyEnabled())) return 0;
		const enabledSpaces = await this.context.config.listEnabledSpaces(this.sourceId);
		if (enabledSpaces.length > 0) {
			let count = 0;
			for (const space of enabledSpaces) count += await this.pollSpace(space.spaceId);
			return count;
		}
		let count = 0;
		for (const repo of this.repo.listPollingRepos()) count += await this.pollWatchedRepo(repo);
		return count;
	}

	private async pollSpace(spaceId: string): Promise<number> {
		if (!this.context) return 0;
		if (!(await this.isPollingGloballyEnabled())) return 0;
		const spaceConfig = await this.context.config.getSpaceConfig(spaceId, this.sourceId);
		if (spaceConfig && !spaceConfig.enabled) return 0;
		let count = 0;
		for (const repo of this.repo.listPollingRepos(spaceId))
			count += await this.pollWatchedRepo(repo);
		return count;
	}

	private async isPollingGloballyEnabled(): Promise<boolean> {
		if (!this.context) return false;
		const global = await this.context.config.getGlobalConfig(this.sourceId);
		return global.globallyEnabled && global.capabilities.polling !== false;
	}

	private scheduleNextPoll(): void {
		if (this.stopped) return;
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(() => {
			this.activePollCycle = this.runPollCycle().finally(() => {
				this.activePollCycle = undefined;
			});
		}, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		this.pollTimer.unref?.();
	}

	private async runPollCycle(): Promise<void> {
		try {
			await this.pollEnabledSpaces();
		} catch (error) {
			log.warn('GitHub polling cycle failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (!this.stopped) this.scheduleNextPoll();
		}
	}

	private async publishNormalizedEvent(
		spaceId: string,
		event: import('./github-normalizer').NormalizedGitHubEvent
	): Promise<void> {
		if (!this.context) return;
		await this.context.publisher.publish(toExternalEvent(spaceId, event));
	}

	async pollWatchedRepo(
		watched: GitHubWatchedRepo,
		fetchImpl: typeof fetch = fetch
	): Promise<number> {
		if (!this.context) return 0;
		let count = 0;
		const cursor = watched.pollCursor ?? {};
		const etags = cursor.etags ?? {};
		const processedPages = cursor.processedPages ?? {};
		const watermarks = {
			committed: cursor.lastSeenAt ?? watched.lastPollAt ?? 0,
			pending: cursor.pendingLastSeenAt ?? cursor.lastSeenAt ?? watched.lastPollAt ?? 0,
		};
		const since = watermarks.committed ? new Date(watermarks.committed).toISOString() : undefined;
		const base = `https://api.github.com/repos/${watched.owner}/${watched.repo}`;
		const endpoints = [
			{ key: 'issue_comments', path: '/issues/comments' },
			{ key: 'review_comments', path: '/pulls/comments' },
			{ key: 'pulls', path: '/pulls', extra: 'state=all&sort=updated&direction=desc' },
		];

		for (const endpoint of endpoints) {
			const page = processedPages[endpoint.key] ?? 1;
			const query = new URLSearchParams();
			if (endpoint.extra) {
				for (const part of endpoint.extra.split('&')) {
					const [key, value = ''] = part.split('=');
					query.set(key, value);
				}
			}
			if (since) query.set('since', since);
			query.set('per_page', '100');
			query.set('page', String(page));
			const url = `${base}${endpoint.path}?${query.toString()}`;
			const headers: Record<string, string> = {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'NeoKai-Space-GitHub/1.0',
				'X-GitHub-Api-Version': '2022-11-28',
			};
			if (this.options.githubToken) headers.Authorization = `Bearer ${this.options.githubToken}`;
			if (page === 1 && etags[endpoint.key]) headers['If-None-Match'] = etags[endpoint.key];
			const response = await fetchImpl(url, { headers });
			if (response.status === 304) continue;
			if (!response.ok) continue;
			const etag = response.headers.get('ETag');
			if (etag && page === 1) etags[endpoint.key] = etag;
			const rows = (await response.json()) as unknown[];
			for (const row of rows) {
				const event = normalizeGitHubPollingRow(watched, row, endpoint.key);
				if (event) {
					await this.publishNormalizedEvent(watched.spaceId, event);
					watermarks.pending = Math.max(watermarks.pending, event.occurredAt);
					count++;
				}
			}
			processedPages[endpoint.key] = rows.length >= 100 ? page + 1 : 1;
		}
		const hasBacklog = Object.values(processedPages).some((page) => page > 1);
		const cursorPayload: PollCursor = {
			lastSeenAt: hasBacklog ? watermarks.committed : watermarks.pending,
			pendingLastSeenAt: hasBacklog ? watermarks.pending : undefined,
			etags,
			processedPages,
		};
		this.repo.updatePollCursor(watched.id, cursorPayload);
		return count;
	}
}

export class StaticExternalEventExtensionConfigStore implements ExternalEventExtensionConfigStore {
	constructor(
		private readonly options: { globallyEnabled?: boolean; webhooks?: boolean; polling?: boolean }
	) {}

	async getGlobalConfig(source: string) {
		return {
			source,
			globallyEnabled: this.options.globallyEnabled ?? true,
			capabilities: {
				webhooks: this.options.webhooks ?? true,
				polling: this.options.polling ?? true,
				rpcConfig: true,
			},
			settings: {},
		};
	}

	async getSpaceConfig(
		spaceId: string,
		source: string
	): Promise<SpaceExternalEventSourceConfig | null> {
		return { spaceId, source, enabled: true, settings: {} };
	}

	async listEnabledSpaces(_source: string): Promise<SpaceExternalEventSourceConfig[]> {
		// The static store has no DB-backed per-space source table yet. Returning an
		// empty list intentionally lets GitHubEventExtension fall back to watched-repo
		// rows as the source of enabled spaces for the migration period.
		return [];
	}

	async setGlobalConfig(
		_source: string,
		_config: Awaited<ReturnType<ExternalEventExtensionConfigStore['getGlobalConfig']>>
	): Promise<void> {}

	async setSpaceConfig(
		_spaceId: string,
		_source: string,
		_config: SpaceExternalEventSourceConfig
	): Promise<void> {}
}
