/**
 * Lobby Agent Tools - MCP tools for Lobby orchestration
 *
 * These tools are exposed to the LobbyAgent when it runs as an active agent,
 * allowing it to:
 * - List and manage rooms
 * - Route external messages to rooms
 * - Manage inbox items
 * - Interact with humans
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Room, TaskPriority } from '@neokai/shared';

/**
 * Parameters for lobby_create_room tool
 */
export interface LobbyCreateRoomParams {
	name: string;
	description?: string;
	repositories?: string[];
	defaultPath?: string;
	allowedPaths?: string[];
	instructions?: string;
}

/**
 * Parameters for lobby_route_message tool
 */
export interface LobbyRouteMessageParams {
	messageId: string;
	roomId: string;
	reason: string;
}

/**
 * Parameters for lobby_send_to_inbox tool
 */
export interface LobbySendToInboxParams {
	messageId: string;
	reason: string;
}

/**
 * Configuration for creating the Lobby Agent Tools MCP server
 */
export interface LobbyAgentToolsConfig {
	/** ID of the session using these tools */
	sessionId: string;
	/** Callback to list all rooms */
	onListRooms: () => Promise<Room[]>;
	/** Callback to get a specific room */
	onGetRoom: (roomId: string) => Promise<Room | null>;
	/** Callback to create a new room */
	onCreateRoom: (params: LobbyCreateRoomParams) => Promise<{ roomId: string; room: Room }>;
	/** Callback to route a message to a room */
	onRouteMessage: (params: LobbyRouteMessageParams) => Promise<void>;
	/** Callback to send a message to inbox */
	onSendToInbox: (params: LobbySendToInboxParams) => Promise<void>;
	/** Callback to list inbox items */
	onListInbox: () => Promise<
		Array<{ id: string; source: string; title?: string; preview: string; timestamp: number }>
	>;
	/** Callback to create a task in a room */
	onCreateTask?: (params: {
		roomId: string;
		title: string;
		description: string;
		priority?: TaskPriority;
	}) => Promise<{ taskId: string }>;
}

/**
 * Create an MCP server with lobby agent tools
 *
 * This server provides tools that allow the LobbyAgent to:
 * - List and manage rooms
 * - Route external messages to appropriate rooms
 * - Manage inbox items
 * - Create tasks in rooms
 */
export function createLobbyAgentMcpServer(config: LobbyAgentToolsConfig) {
	const baseTools = [
		tool('lobby_list_rooms', 'List all available rooms in the system', {}, async () => {
			const rooms = await config.onListRooms();

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							success: true,
							rooms: rooms.map((r) => ({
								id: r.id,
								name: r.name,
								background: r.background,
								status: r.status,
							})),
						}),
					},
				],
			};
		}),

		tool(
			'lobby_get_room',
			'Get details about a specific room',
			{
				room_id: z.string().describe('ID of the room to get'),
			},
			async (args) => {
				const room = await config.onGetRoom(args.room_id);

				if (!room) {
					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									success: false,
									error: 'Room not found',
								}),
							},
						],
					};
				}

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								room: {
									id: room.id,
									name: room.name,
									background: room.background,
									status: room.status,
									instructions: room.instructions,
									allowedPaths: room.allowedPaths,
									defaultPath: room.defaultPath,
								},
							}),
						},
					],
				};
			}
		),

		tool(
			'lobby_create_room',
			'Create a new room for managing a project or topic',
			{
				name: z.string().describe('Name for the new room'),
				description: z.string().optional().describe('Description of the room purpose'),
				repositories: z
					.array(z.string())
					.optional()
					.describe('GitHub repositories to link (format: owner/repo)'),
				default_path: z.string().optional().describe('Default workspace path'),
				allowed_paths: z.array(z.string()).optional().describe('Allowed filesystem paths'),
				instructions: z.string().optional().describe('Custom instructions for the room agent'),
			},
			async (args) => {
				const result = await config.onCreateRoom({
					name: args.name,
					description: args.description,
					repositories: args.repositories,
					defaultPath: args.default_path,
					allowedPaths: args.allowed_paths,
					instructions: args.instructions,
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								roomId: result.roomId,
								message: `Room "${args.name}" created successfully`,
							}),
						},
					],
				};
			}
		),

		tool(
			'lobby_route_message',
			'Route an external message to a specific room',
			{
				message_id: z.string().describe('ID of the message to route'),
				room_id: z.string().describe('ID of the target room'),
				reason: z.string().describe('Why this room was chosen'),
			},
			async (args) => {
				await config.onRouteMessage({
					messageId: args.message_id,
					roomId: args.room_id,
					reason: args.reason,
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								message: `Message routed to room ${args.room_id}`,
							}),
						},
					],
				};
			}
		),

		tool(
			'lobby_send_to_inbox',
			'Send a message to the inbox for manual triage',
			{
				message_id: z.string().describe('ID of the message to send to inbox'),
				reason: z.string().describe('Why this message needs manual triage'),
			},
			async (args) => {
				await config.onSendToInbox({
					messageId: args.message_id,
					reason: args.reason,
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								success: true,
								message: 'Message sent to inbox for manual review',
							}),
						},
					],
				};
			}
		),

		tool('lobby_list_inbox', 'List items in the inbox awaiting triage', {}, async () => {
			const items = await config.onListInbox();

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							success: true,
							items,
						}),
					},
				],
			};
		}),
	];

	// Optional task creation tool
	const createTaskTool = config.onCreateTask
		? [
				tool(
					'lobby_create_task',
					'Create a task in a specific room',
					{
						room_id: z.string().describe('ID of the room to create the task in'),
						title: z.string().describe('Task title'),
						description: z.string().describe('Detailed task description'),
						priority: z
							.enum(['low', 'normal', 'high', 'urgent'])
							.optional()
							.default('normal')
							.describe('Task priority'),
					},
					async (args) => {
						const result = await config.onCreateTask!({
							roomId: args.room_id,
							title: args.title,
							description: args.description,
							priority: args.priority as TaskPriority | undefined,
						});

						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({
										success: true,
										taskId: result.taskId,
										message: 'Task created successfully',
									}),
								},
							],
						};
					}
				),
			]
		: [];

	const tools = [...baseTools, ...createTaskTool];

	return createSdkMcpServer({
		name: 'lobby-agent',
		tools,
	});
}

export type LobbyAgentMcpServer = ReturnType<typeof createLobbyAgentMcpServer>;
