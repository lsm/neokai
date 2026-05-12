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
		if (!extension.sourceId || extension.sourceId.trim().length === 0) {
			throw new Error('External event extension sourceId must be non-empty');
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
		}
	}

	getExtension(sourceId: string): ExternalEventExtension | undefined {
		return this.extensions.get(sourceId);
	}

	registerRoutes(routes: readonly Route[], context: ExternalEventExtensionContext): void {
		for (const route of routes) {
			const extension = this.findExtensionForRoute(route);
			this.routeHandlers.push({
				sourceId: extension?.sourceId,
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
		extension.registerRpcHandlers(trackingHub, context);
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

	private findExtensionForRoute(route: Route): HttpExternalEventExtension | undefined {
		for (const extension of this.extensions.values()) {
			if (!isHttpExtension(extension)) continue;
			if (extension.routes.includes(route)) return extension;
		}
		return undefined;
	}
}

export interface RegisteredRoute {
	readonly sourceId?: string;
	readonly method: Route['method'];
	readonly path: string;
	handle(req: Request): Promise<Response>;
}

function isHttpExtension(
	extension: ExternalEventExtension
): extension is HttpExternalEventExtension {
	return 'routes' in extension && Array.isArray((extension as { routes?: unknown }).routes);
}

function isRpcExtension(extension: ExternalEventExtension): extension is RpcExternalEventExtension {
	return typeof (extension as { registerRpcHandlers?: unknown }).registerRpcHandlers === 'function';
}
