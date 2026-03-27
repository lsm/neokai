/**
 * Tests for short ID support in URL route patterns.
 *
 * Verifies that ROOM_TASK_ROUTE_PATTERN and SPACE_TASK_ROUTE_PATTERN
 * accept both UUID and short ID formats for the task ID segment.
 */

import { describe, it, expect } from 'vitest';
import { getRoomTaskIdFromPath, getSpaceTaskIdFromPath } from '../router';

const ROOM_UUID = '04062505-780f-4881-a3be-9cb9062790fb';
const SPACE_UUID = '04062505-780f-4881-a3be-9cb9062790fc';
const TASK_UUID = 'd8a578c6-d3cb-4c84-926b-958cbd433d32';

describe('ROOM_TASK_ROUTE_PATTERN — short ID support', () => {
	it('matches short task ID (t-N format)', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/t-42`);
		expect(result).toEqual({ roomId: ROOM_UUID, taskId: 't-42' });
	});

	it('matches short task ID with large counter', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/t-999`);
		expect(result).toEqual({ roomId: ROOM_UUID, taskId: 't-999' });
	});

	it('matches short task ID with single-digit counter', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/t-1`);
		expect(result).toEqual({ roomId: ROOM_UUID, taskId: 't-1' });
	});

	it('matches UUID task ID (backward compatibility)', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/${TASK_UUID}`);
		expect(result).toEqual({ roomId: ROOM_UUID, taskId: TASK_UUID });
	});

	it('returns null for path without task segment', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}`);
		expect(result).toBeNull();
	});

	it('returns null for non-hex, non-short-id task segment', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/Task_42`);
		expect(result).toBeNull();
	});

	it('returns null for invalid short ID format (uppercase prefix)', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/T-42`);
		expect(result).toBeNull();
	});

	it('returns null for extra path segments after task short ID', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/t-42/extra`);
		expect(result).toBeNull();
	});

	it('returns null for zero counter (t-0 is semantically invalid)', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/t-0`);
		expect(result).toBeNull();
	});

	it('returns null for leading-zero counter (t-01)', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/t-01`);
		expect(result).toBeNull();
	});

	it('matches g- prefix short ID (route is intentionally permissive about prefix letter)', () => {
		const result = getRoomTaskIdFromPath(`/room/${ROOM_UUID}/task/g-42`);
		expect(result).toEqual({ roomId: ROOM_UUID, taskId: 'g-42' });
	});
});

describe('SPACE_TASK_ROUTE_PATTERN — short ID support', () => {
	it('matches short task ID (t-N format)', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/t-42`);
		expect(result).toEqual({ spaceId: SPACE_UUID, taskId: 't-42' });
	});

	it('matches short task ID with large counter', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/t-999`);
		expect(result).toEqual({ spaceId: SPACE_UUID, taskId: 't-999' });
	});

	it('matches short task ID with single-digit counter', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/t-1`);
		expect(result).toEqual({ spaceId: SPACE_UUID, taskId: 't-1' });
	});

	it('matches UUID task ID (backward compatibility)', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/${TASK_UUID}`);
		expect(result).toEqual({ spaceId: SPACE_UUID, taskId: TASK_UUID });
	});

	it('returns null for path without task segment', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}`);
		expect(result).toBeNull();
	});

	it('returns null for non-hex, non-short-id task segment', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/Task_42`);
		expect(result).toBeNull();
	});

	it('returns null for invalid short ID format (uppercase prefix)', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/T-42`);
		expect(result).toBeNull();
	});

	it('returns null for extra path segments after task short ID', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/t-42/extra`);
		expect(result).toBeNull();
	});

	it('returns null for zero counter (t-0 is semantically invalid)', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/t-0`);
		expect(result).toBeNull();
	});

	it('returns null for leading-zero counter (t-01)', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/t-01`);
		expect(result).toBeNull();
	});

	it('matches g- prefix short ID (route is intentionally permissive about prefix letter)', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_UUID}/task/g-42`);
		expect(result).toEqual({ spaceId: SPACE_UUID, taskId: 'g-42' });
	});
});
