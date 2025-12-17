#!/usr/bin/env bun
/**
 * Database Recovery Script
 *
 * Recovers SDK messages from a corrupted or data-lost database by scanning
 * the raw database file for JSON message remnants in free pages.
 *
 * Usage:
 *   bun packages/daemon/scripts/recover-messages.ts <db-path>
 *
 * Example:
 *   bun packages/daemon/scripts/recover-messages.ts ./tmp/self-dev/daemon.db
 *
 * This script will:
 * 1. Scan the raw database file for SDK message JSON objects
 * 2. Extract workspace paths and titles from message content
 * 3. Create missing session records
 * 4. Restore all recoverable messages
 */

import { readFileSync } from 'fs';
import { Database } from 'bun:sqlite';

const dbPath = process.argv[2];

if (!dbPath) {
	console.error('Usage: bun recover-messages.ts <db-path>');
	console.error('Example: bun recover-messages.ts ./tmp/self-dev/daemon.db');
	process.exit(1);
}

console.log(`\n🔍 Recovering messages from: ${dbPath}\n`);

// Step 1: Extract messages from raw database file
console.log('Step 1: Scanning raw database for message remnants...');

const raw = readFileSync(dbPath);
const content = raw.toString('utf8', 0, raw.length);

interface RecoveredMessage {
	type: string;
	uuid: string;
	session_id?: string;
	raw: string;
}

const messages: RecoveredMessage[] = [];
const seen = new Set<string>();

let pos = 0;
while (pos < raw.length) {
	const idx = content.indexOf('{"type":"', pos);
	if (idx === -1) break;

	let depth = 0;
	const start = idx;
	let end = idx;

	for (let i = idx; i < Math.min(idx + 100000, raw.length); i++) {
		const char = content[i];
		if (char === '{') depth++;
		else if (char === '}') {
			depth--;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
	}

	if (end > start && depth === 0) {
		const jsonStr = content.slice(start, end);
		try {
			const obj = JSON.parse(jsonStr);
			if (obj.type && obj.uuid && !seen.has(obj.uuid)) {
				seen.add(obj.uuid);
				messages.push({
					type: obj.type,
					uuid: obj.uuid,
					session_id: obj.session_id,
					raw: jsonStr,
				});
			}
		} catch {
			// Invalid JSON, skip
		}
	}

	pos = idx + 1;
}

console.log(`   Found ${messages.length} unique messages`);

// Step 2: Open database and check existing state
console.log('\nStep 2: Checking database state...');

const db = new Database(dbPath);

const existingSessionIds = new Set(
	db
		.query('SELECT id FROM sessions')
		.all()
		.map((r: unknown) => (r as { id: string }).id)
);

const existingMessageIds = new Set(
	db
		.query('SELECT id FROM sdk_messages')
		.all()
		.map((r: unknown) => (r as { id: string }).id)
);

console.log(`   Existing sessions: ${existingSessionIds.size}`);
console.log(`   Existing messages: ${existingMessageIds.size}`);

// Step 3: Group messages by session and identify orphans
console.log('\nStep 3: Analyzing message ownership...');

const messagesBySession = new Map<string, RecoveredMessage[]>();
for (const msg of messages) {
	if (msg.session_id) {
		if (!messagesBySession.has(msg.session_id)) {
			messagesBySession.set(msg.session_id, []);
		}
		messagesBySession.get(msg.session_id)!.push(msg);
	}
}

const orphanSessions = new Map<string, RecoveredMessage[]>();
for (const [sessionId, msgs] of messagesBySession.entries()) {
	if (!existingSessionIds.has(sessionId)) {
		orphanSessions.set(sessionId, msgs);
	}
}

console.log(`   Sessions with messages: ${messagesBySession.size}`);
console.log(`   Orphan sessions (need recreation): ${orphanSessions.size}`);

// Step 4: Create missing sessions
console.log('\nStep 4: Creating missing sessions...');

const insertSession = db.prepare(`
  INSERT INTO sessions (
    id, title, workspace_path, created_at, last_active_at, status,
    config, metadata, is_worktree, worktree_path, main_repo_path,
    worktree_branch, git_branch, sdk_session_id, available_commands,
    processing_state, archived_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let sessionsCreated = 0;

for (const [sessionId, msgs] of orphanSessions.entries()) {
	// Extract metadata from messages
	let workspacePath = '/tmp/recovered';
	let title = 'Recovered Session';
	let sdkSessionId: string | null = null;

	for (const msg of msgs) {
		try {
			const parsed = JSON.parse(msg.raw);

			// System init messages contain workspace path
			if (parsed.type === 'system' && parsed.subtype === 'init') {
				if (parsed.cwd) workspacePath = parsed.cwd;
				if (parsed.session_id) sdkSessionId = parsed.session_id;
			}

			// Get title from first user message
			if (parsed.type === 'user' && title === 'Recovered Session') {
				const msgContent = parsed.message?.content;
				let text = '';
				if (typeof msgContent === 'string') {
					text = msgContent;
				} else if (Array.isArray(msgContent)) {
					const textBlock = msgContent.find(
						(b: unknown) => (b as { type: string }).type === 'text'
					);
					if (textBlock) text = (textBlock as { text: string }).text;
				}
				if (text) {
					title = text.slice(0, 50).replace(/\n/g, ' ').trim();
					if (text.length > 50) title += '...';
				}
			}
		} catch {
			// Skip parse errors
		}
	}

	try {
		const config = JSON.stringify({
			model: 'claude-sonnet-4-20250514',
			maxTokens: 16000,
			temperature: 1,
		});
		const metadata = JSON.stringify({
			messageCount: msgs.length,
			recovered: true,
			recoveredAt: new Date().toISOString(),
		});
		const now = new Date().toISOString();

		insertSession.run(
			sessionId,
			title,
			workspacePath,
			now,
			now,
			'active',
			config,
			metadata,
			0,
			null,
			null,
			null,
			null,
			sdkSessionId,
			null,
			null,
			null
		);
		sessionsCreated++;
	} catch (e) {
		console.error(`   Failed to create session ${sessionId}:`, e);
	}
}

console.log(`   Sessions created: ${sessionsCreated}`);

// Step 5: Insert missing messages
console.log('\nStep 5: Restoring messages...');

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`);

let messagesInserted = 0;

for (const msg of messages) {
	if (!msg.session_id) continue;
	if (existingMessageIds.has(msg.uuid)) continue;

	// Check if session exists (either originally or just created)
	if (!existingSessionIds.has(msg.session_id) && !orphanSessions.has(msg.session_id)) {
		continue;
	}

	try {
		const parsed = JSON.parse(msg.raw);
		const result = insertMessage.run(
			msg.uuid,
			msg.session_id,
			msg.type,
			parsed.subtype || null,
			msg.raw,
			new Date().toISOString()
		);
		if (result.changes > 0) messagesInserted++;
	} catch {
		// Skip insert errors
	}
}

console.log(`   Messages restored: ${messagesInserted}`);

// Final summary
const finalSessions = db.query('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
const finalMessages = db.query('SELECT COUNT(*) as count FROM sdk_messages').get() as {
	count: number;
};

console.log('\n✅ Recovery complete!');
console.log(`   Total sessions: ${finalSessions.count}`);
console.log(`   Total messages: ${finalMessages.count}`);

db.close();
