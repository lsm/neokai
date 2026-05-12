import type { MessageHub } from '@neokai/shared/message-hub/message-hub.ts';
import type {
	ExternalEventExtension,
	ExternalEventExtensionContext,
	HttpExternalEventExtension,
	Route,
	RpcExternalEventExtension,
} from './types';

export class ExternalEventExtensionManager {
	private extensions = new Map<string, ExternalEventExtension>();
	private started = new Map<string, ExternalEventExtensionContext>();
	private routeHandlers: RegisteredRoute[] = [];
	private rpcUnsubscribers = new Map<string, (() => void)[]>();

	register(extension: ExternalEventExtension): void {
		if (
			!extension.sourceId ||
			extension.sourceId.trim().length === 0 ||
			extension.sourceId !== extension.sourceId.trim()
		) {
			throw new Error(
				'External event extension sourceId must be non-empty and must not include edge whitespace'
			);
		}
		if (this.extensions.has(extension.sourceId)) {
			throw new Error(`External event extension "${extension.sourceId}" is already registered`);
		}
		this.extensions.set(extension.sourceId, extension);
	}

	unregister(sourceId: string): void {
		if (this.started.has(sourceId)) {
			throw new Error(`Cannot unregister started external event extension "${sourceId}"`);
		}
		this.unregisterRpcHandlers(sourceId);
		this.routeHandlers = this.routeHandlers.filter((route) => route.sourceId !== sourceId);
		this.extensions.delete(sourceId);
	}

	async startExtension(sourceId: string, context: ExternalEventExtensionContext): Promise<void> {
		if (this.started.has(sourceId)) return;
		const extension = this.getRequiredExtension(sourceId);
		const globalConfig = await context.config.getGlobalConfig(sourceId);
		if (!globalConfig.globallyEnabled) return;
		await extension.start(context);
		this.started.set(sourceId, context);
	}

	async stopExtension(sourceId: string): Promise<void> {
		const extension = this.extensions.get(sourceId);
		if (!extension || !this.started.has(sourceId)) return;
		try {
			await extension.stop();
		} finally {
			this.started.delete(sourceId);
			this.unregisterRpcHandlers(sourceId);
			this.unregisterRoutes(sourceId);
		}
	}

	getExtension(sourceId: string): ExternalEventExtension | undefined {
		return this.extensions.get(sourceId);
	}

	registerRoutes(routes: readonly Route[], context: ExternalEventExtensionContext): void {
		const sourceId = this.findSourceIdForRoutes(routes);
		if (sourceId) {
			this.unregisterRoutes(sourceId);
		}
		for (const route of routes) {
			this.routeHandlers.push({
				sourceId,
				method: route.method,
				path: route.path,
				handle: (req) => route.handle(req, context),
			});
		}
	}

	registerRpcHandlers(
		sourceId: string,
		hub: MessageHub,
		context: ExternalEventExtensionContext
	): void {
		this.unregisterRpcHandlers(sourceId);
		const extension = this.getRequiredExtension(sourceId);
		if (!isRpcExtension(extension)) {
			throw new Error(`External event extension "${sourceId}" does not expose RPC handlers`);
		}

		const unsubscribers: (() => void)[] = [];
		const trackingHub = new Proxy(hub, {
			get(target, prop, receiver) {
				if (prop !== 'onRequest') {
					return Reflect.get(target, prop, receiver);
				}
				return (method: string, handler: Parameters<MessageHub['onRequest']>[1]) => {
					const unsubscribe = target.onRequest(method, handler);
					unsubscribers.push(unsubscribe);
					return unsubscribe;
				};
			},
		});
		try {
			extension.registerRpcHandlers(trackingHub, context);
		} catch (error) {
			for (const unsubscribe of unsubscribers) {
				unsubscribe();
			}
			throw error;
		}
		this.rpcUnsubscribers.set(sourceId, unsubscribers);
	}

	getRegisteredRoutes(): readonly RegisteredRoute[] {
		return this.routeHandlers;
	}

	private getRequiredExtension(sourceId: string): ExternalEventExtension {
		const extension = this.extensions.get(sourceId);
		if (!extension) {
			throw new Error(`External event extension "${sourceId}" is not registered`);
		}
		return extension;
	}

	private unregisterRpcHandlers(sourceId: string): void {
		const unsubscribers = this.rpcUnsubscribers.get(sourceId) ?? [];
		for (const unsubscribe of unsubscribers) {
			unsubscribe();
		}
		this.rpcUnsubscribers.delete(sourceId);
	}

	private unregisterRoutes(sourceId: string): void {
		this.routeHandlers = this.routeHandlers.filter((route) => route.sourceId !== sourceId);
	}

	private findSourceIdForRoutes(routes: readonly Route[]): string | undefined {
		for (const extension of this.extensions.values()) {
			if (isHttpExtension(extension) && extension.routes === routes) {
				return extension.sourceId;
			}
		}

		const matchingSourceIds: string[] = [];
		for (const extension of this.extensions.values()) {
			if (!isHttpExtension(extension)) continue;
			if (routesMatch(extension.routes, routes)) {
				matchingSourceIds.push(extension.sourceId);
			}
		}

		if (matchingSourceIds.length > 1) {
			throw new Error(
				`Cannot infer external event route owner: route signatures match multiple sources ` +
					`(${matchingSourceIds.join(', ')}). Pass the registered extension.routes array directly.`
			);
		}
		return matchingSourceIds[0];
	}
}

export interface RegisteredRoute {
	readonly sourceId?: string;
	readonly method: Route['method'];
	readonly path: string;
	handle(req: Request): Promise<Response>;
}

function routesMatch(left: readonly Route[], right: readonly Route[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((route, index) => {
		const other = right[index];
		return Boolean(other) && route.method === other.method && route.path === other.path;
	});
}

function isHttpExtension(
	extension: ExternalEventExtension
): extension is HttpExternalEventExtension {
	return 'routes' in extension && Array.isArray((extension as { routes?: unknown }).routes);
}

function isRpcExtension(extension: ExternalEventExtension): extension is RpcExternalEventExtension {
	return typeof (extension as { registerRpcHandlers?: unknown }).registerRpcHandlers === 'function';
}
