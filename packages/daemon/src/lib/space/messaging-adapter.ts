import { parseAddress } from '../../../../messaging/src/address';
import type { ParsedAddress, WorkerAddress } from '../../../../messaging/src/address';
import type {
	ActorRef,
	DeliveryRecord,
	DeliveryState,
	MessageRecord,
} from '../../../../messaging/src/types';
import type {
	ActorResolver,
	ResolvedTarget,
	ResolveTargetsResult,
	RouteMessageResult,
	UnresolvedTarget,
} from '../../../../messaging/src/contracts';
import type { PendingAgentMessageRecord } from '../../storage/repositories/pending-agent-message-repository';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type { WorkflowChannel, WorkflowNode } from '@neokai/shared';
import { ChannelResolver } from './runtime/channel-resolver';
import type { SpaceActorRegistryAdapter } from './actor-registry';

export interface SpaceMessageResolverContext {
	spaceId: string;
	workflowRunId?: string;
	nodeId?: string;
	agentName?: string;
}

export interface SpaceMessageResolverConfig {
	actorRegistry: SpaceActorRegistryAdapter;
	workflowRepo: SpaceWorkflowRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
}

export class SpaceMessageResolver implements ActorResolver {
	constructor(
		private readonly config: SpaceMessageResolverConfig,
		private readonly context: SpaceMessageResolverContext
	) {}

	async resolveTargets(message: MessageRecord): Promise<ResolveTargetsResult> {
		const resolved: ResolvedTarget[] = [];
		const unresolved: UnresolvedTarget[] = [];
		const seen = new Set<string>();

		for (const targetRef of message.targets) {
			let address: ParsedAddress;
			try {
				address = parseAddress(targetRef);
			} catch (error) {
				unresolved.push({
					targetRef,
					reason: error instanceof Error ? error.message : String(error),
				});
				continue;
			}

			const result = this.resolveAddress(targetRef, address, message);
			for (const actor of result.actors) {
				const key = `${targetRef}\0${actor.actorId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				resolved.push({ targetRef, address, actor });
			}
			if (result.reason) {
				unresolved.push({ targetRef, address, reason: result.reason });
			}
		}

		return { resolved, unresolved };
	}

	private resolveAddress(
		targetRef: string,
		address: ParsedAddress,
		message: MessageRecord
	): { actors: ActorRef[]; reason?: string } {
		const spaceId = message.spaceId || this.context.spaceId;
		const actors = this.config.actorRegistry.listActors(spaceId);

		switch (address.kind) {
			case 'handle': {
				const handle = `@${address.handle}`;
				const matches = actors.filter((actor) => actor.handle === handle && isRoutable(actor));
				return matches.length > 0
					? { actors: stableActors(matches) }
					: { actors: [], reason: `No routable actor found for handle ${handle}` };
			}
			case 'role': {
				const role = actorRole(address.role);
				const holders = actors.filter(
					(actor) => actor.roles?.includes(address.role) || actor.roles?.includes(role)
				);
				const active = holders.filter((actor) => actor.status === 'active');
				const inactive = holders.filter((actor) => actor.status === 'inactive');
				const routable = active.length > 0 ? active : inactive;
				return routable.length > 0
					? { actors: stableActors(routable) }
					: { actors: [], reason: `No routable actor found for role ${address.role}` };
			}
			case 'session': {
				const actorId = `session:${address.sessionId}`;
				const actor = actors.find(
					(candidate) => candidate.actorId === actorId && isRoutable(candidate)
				);
				return actor
					? { actors: [actor] }
					: { actors: [], reason: `No routable session actor found for ${address.sessionId}` };
			}
			case 'worker':
				return this.resolveWorker(targetRef, address, message, actors);
			case 'channel':
				return {
					actors: [],
					reason: `Channel targets are not enabled in Space messaging v1: #${address.name}`,
				};
		}
	}

	private resolveWorker(
		targetRef: string,
		address: WorkerAddress,
		message: MessageRecord,
		actors: ActorRef[]
	): { actors: ActorRef[]; reason?: string } {
		const workflowRunId =
			address.workflowRunId ?? message.workflowRunId ?? this.context.workflowRunId;
		if (!workflowRunId) {
			return {
				actors: [],
				reason: `Worker target ${targetRef} requires workflowRunId or @worker:<run>/<node>/<agent>`,
			};
		}

		const workflow = this.workflowForRun(workflowRunId);
		const nodeId = decodeAddressComponent(address.nodeId, targetRef);
		if (!nodeId.ok) return { actors: [], reason: nodeId.reason };
		const targetNodeId = workflowNodeId(workflow?.nodes ?? [], nodeId.value) ?? nodeId.value;
		const agentName = address.agentName
			? decodeAddressComponent(address.agentName, targetRef)
			: undefined;
		if (agentName && !agentName.ok) return { actors: [], reason: agentName.reason };
		const workerActors = actors.filter(
			(actor) =>
				actor.kind === 'worker' &&
				parseWorkerActorId(actor.actorId)?.workflowRunId === workflowRunId
		);
		const matches = workerActors.filter((actor) => {
			const parsed = parseWorkerActorId(actor.actorId);
			if (!parsed) return false;
			if (parsed.nodeId !== targetNodeId) return false;
			return agentName ? parsed.agentName === agentName.value : true;
		});
		let routable = matches.filter(isRoutable);
		if (!agentName && this.context.agentName) {
			routable = routable.filter(
				(actor) => parseWorkerActorId(actor.actorId)?.agentName === this.context.agentName
			);
		}
		if (routable.length === 0) {
			return { actors: [], reason: `No routable worker actor found for ${targetRef}` };
		}
		if (!agentName && routable.length > 1) {
			return {
				actors: [],
				reason: `Worker target ${targetRef} is ambiguous; specify @worker:<node>/<agent>`,
			};
		}

		const permitted = routable.filter((actor) =>
			this.canSendToWorker(workflowRunId, actor, address)
		);
		if (permitted.length === 0) {
			return {
				actors: [],
				reason: `Channel topology does not permit worker target ${targetRef}`,
			};
		}
		return { actors: stableActors(permitted) };
	}

	private canSendToWorker(workflowRunId: string, actor: ActorRef, address: WorkerAddress): boolean {
		const run = this.config.workflowRunRepo.getRun(workflowRunId);
		if (!run || run.spaceId !== this.context.spaceId) return false;
		const workflow = this.config.workflowRepo.getWorkflow(run.workflowId);
		if (!workflow) return false;
		const parsed = parseWorkerActorId(actor.actorId);
		if (!parsed) return false;

		if (address.workflowRunId && !this.context.nodeId) return true;

		const fromNodeName = workflowNodeName(workflow.nodes, this.context.nodeId);
		const targetNodeName = workflowNodeName(workflow.nodes, parsed.nodeId);
		if (!fromNodeName || !targetNodeName) return false;
		if (!workflow.channels || workflow.channels.length === 0) return false;
		return canSendToWorkerTarget(
			workflow.channels,
			[fromNodeName, this.context.agentName],
			[targetNodeName, parsed.agentName]
		);
	}

	private workflowForRun(workflowRunId: string) {
		const run = this.config.workflowRunRepo.getRun(workflowRunId);
		if (!run || run.spaceId !== this.context.spaceId) return null;
		return this.config.workflowRepo.getWorkflow(run.workflowId) ?? null;
	}
}

export interface SpaceDeliveryFacadeConfig {
	resolver: ActorResolver;
	deliverToSession?: (
		actor: ActorRef,
		message: MessageRecord
	) => Promise<string | null | undefined>;
}

export class SpaceDeliveryFacade {
	constructor(private readonly config: SpaceDeliveryFacadeConfig) {}

	async routeMessage(message: MessageRecord): Promise<RouteMessageResult> {
		const result = await this.config.resolver.resolveTargets(message);
		const deliveries: DeliveryRecord[] = [];

		for (const target of result.resolved) {
			const delivery = createDeliveryFromActor(message, target.targetRef, target.actor);
			if (target.actor.status === 'active' && this.config.deliverToSession) {
				try {
					const deliveredSessionId = await this.config.deliverToSession(target.actor, message);
					delivery.state = 'delivered';
					delivery.deliveredAt = Date.now();
					if (deliveredSessionId) delivery.deliveredSessionId = deliveredSessionId;
				} catch (error) {
					delivery.state = 'failed';
					delivery.attemptCount += 1;
					delivery.lastError = error instanceof Error ? error.message : String(error);
				}
			}
			deliveries.push(delivery);
		}

		for (const target of result.unresolved) {
			deliveries.push(createFailedDelivery(message, target.targetRef, target.reason));
		}

		return { message, deliveries };
	}
}

export function pendingMessageToMessageRecord(row: PendingAgentMessageRecord): MessageRecord {
	return {
		messageId: `msg_legacy_${row.id}`,
		spaceId: row.spaceId,
		senderActorId: legacySenderActorId(row.sourceAgentName, row.workflowRunId),
		targets: [row.targetAgentName],
		body: row.message,
		kind: 'message',
		workflowRunId: row.workflowRunId,
		...(row.taskId ? { taskId: row.taskId } : {}),
		...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
		createdAt: row.createdAt,
	};
}

export function pendingMessageToDeliveryRecords(
	row: PendingAgentMessageRecord,
	actors: ActorRef[]
): DeliveryRecord[] {
	const messageId = `msg_legacy_${row.id}`;
	const state = pendingStatusToDeliveryState(row.status);
	const targetActors = legacyTargetActors(row, actors);
	if (targetActors.length === 0) {
		return [createLegacyDelivery(row, messageId, state)];
	}
	return targetActors.map((actor, index) =>
		createLegacyDelivery(row, messageId, state, actor, index === 0 ? undefined : index)
	);
}

function createDeliveryFromActor(
	message: MessageRecord,
	targetRef: string,
	actor: ActorRef
): DeliveryRecord {
	return {
		deliveryId: `delivery_${message.messageId}_${encodeURIComponent(targetRef)}_${encodeURIComponent(actor.actorId)}`,
		messageId: message.messageId,
		targetActorId: actor.actorId,
		targetRef,
		state: 'queued',
		attemptCount: 0,
		maxAttempts: 5,
		createdAt: Date.now(),
	};
}

function createFailedDelivery(
	message: MessageRecord,
	targetRef: string,
	lastError: string
): DeliveryRecord {
	return {
		deliveryId: `delivery_${message.messageId}_${encodeURIComponent(targetRef)}_failed`,
		messageId: message.messageId,
		targetRef,
		state: 'failed',
		attemptCount: 0,
		maxAttempts: 0,
		createdAt: Date.now(),
		lastError,
	};
}

function createLegacyDelivery(
	row: PendingAgentMessageRecord,
	messageId: string,
	state: DeliveryState,
	actor?: ActorRef,
	fanoutIndex?: number
): DeliveryRecord {
	return {
		deliveryId: `delivery_legacy_${row.id}${fanoutIndex === undefined ? '' : `_${fanoutIndex}`}`,
		messageId,
		targetActorId: actor?.actorId,
		targetRef: row.targetAgentName,
		state,
		attemptCount: row.attempts,
		maxAttempts: row.maxAttempts,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		...(row.lastError ? { lastError: row.lastError } : {}),
		...(row.deliveredSessionId ? { deliveredSessionId: row.deliveredSessionId } : {}),
		...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {}),
	};
}

function legacyTargetActors(row: PendingAgentMessageRecord, actors: ActorRef[]): ActorRef[] {
	if (row.targetKind === 'space_agent') {
		return actors.filter((actor) => actor.handle === '@coordinator' && isRoutable(actor));
	}
	const matches = actors.filter((actor) => {
		if (actor.kind !== 'worker' || !isRoutable(actor)) return false;
		const parsed = parseWorkerActorId(actor.actorId);
		return parsed?.workflowRunId === row.workflowRunId && parsed.agentName === row.targetAgentName;
	});
	if (row.status === 'pending') return stableActors(matches);
	return stableActors(matches).slice(0, 1);
}

function pendingStatusToDeliveryState(status: PendingAgentMessageRecord['status']): DeliveryState {
	switch (status) {
		case 'pending':
			return 'queued';
		case 'delivered':
			return 'delivered';
		case 'failed':
			return 'failed';
		case 'expired':
			return 'expired';
	}
}

function legacySenderActorId(sourceAgentName: string, workflowRunId: string): string {
	if (sourceAgentName === 'human') return 'human:legacy';
	if (
		sourceAgentName === 'coordinator' ||
		sourceAgentName === 'space-agent' ||
		sourceAgentName === 'task-agent'
	) {
		return 'agent:coordinator:legacy';
	}
	return `worker:${encodeURIComponent(workflowRunId)}:unknown:${encodeURIComponent(sourceAgentName)}`;
}

function isRoutable(actor: ActorRef): boolean {
	return actor.status === 'active' || actor.status === 'inactive';
}

function stableActors(actors: ActorRef[]): ActorRef[] {
	return [...actors].sort((left, right) => left.actorId.localeCompare(right.actorId));
}

function actorRole(role: string): string {
	return `actor-role:${encodeURIComponent(role)}`;
}

function workflowNodeId(nodes: WorkflowNode[], nodeRef: string): string | null {
	const node = nodes.find((candidate) => candidate.id === nodeRef || candidate.name === nodeRef);
	return node?.id ?? null;
}

function workflowNodeName(nodes: WorkflowNode[], nodeId: string | undefined): string | null {
	if (!nodeId) return null;
	const node = nodes.find((candidate) => candidate.id === nodeId || candidate.name === nodeId);
	return node?.name ?? null;
}

function canSendToWorkerTarget(
	channels: WorkflowChannel[],
	fromRefs: Array<string | undefined>,
	toRefs: Array<string | undefined>
): boolean {
	const resolver = new ChannelResolver(channels);
	for (const from of uniqueStrings(fromRefs)) {
		for (const to of uniqueStrings(toRefs)) {
			if (resolver.canSend(from, to)) return true;
		}
	}
	return false;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function decodeAddressComponent(
	component: string,
	targetRef: string
): { ok: true; value: string } | { ok: false; reason: string } {
	try {
		return { ok: true, value: decodeURIComponent(component) };
	} catch (error) {
		if (error instanceof URIError) {
			return { ok: false, reason: `Invalid worker target escape in ${targetRef}` };
		}
		throw error;
	}
}

function parseWorkerActorId(
	actorId: string
): { workflowRunId: string; nodeId: string; agentName: string } | null {
	if (!actorId.startsWith('worker:')) return null;
	const parts = actorId.slice('worker:'.length).split(':');
	if (parts.length !== 3) return null;
	return {
		workflowRunId: decodeURIComponent(parts[0]),
		nodeId: decodeURIComponent(parts[1]),
		agentName: decodeURIComponent(parts[2]),
	};
}
