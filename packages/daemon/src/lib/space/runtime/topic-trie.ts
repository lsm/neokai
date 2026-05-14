/**
 * TopicTrie — workflow-runtime utility for external event topic matching.
 *
 * Supports slash-delimited topic patterns with segment-local star wildcards,
 * for example GitHub pull-request review patterns.
 */

class TrieNode<T> {
	exactChildren = new Map<string, TrieNode<T>>();
	globChildren = new Map<string, TrieNode<T>>();
	values: T[] | undefined;
}

const segmentPatternCache = new Map<string, RegExp>();

export class TopicTrie<T> {
	private root = new TrieNode<T>();

	insert(pattern: string, value: T): void {
		const segments = normalizeTopic(pattern);
		let node = this.root;
		for (const segment of segments) {
			const children = segment.includes('*') ? node.globChildren : node.exactChildren;
			let child = children.get(segment);
			if (!child) {
				child = new TrieNode<T>();
				children.set(segment, child);
			}
			node = child;
		}
		(node.values ??= []).push(value);
	}

	lookup(topic: string): T[] {
		const segments = normalizeTopic(topic);
		const results: T[] = [];

		const walk = (node: TrieNode<T>, depth: number): void => {
			if (depth === segments.length) {
				if (node.values) results.push(...node.values);
				return;
			}

			const segment = segments[depth];
			const exact = node.exactChildren.get(segment);
			if (exact) walk(exact, depth + 1);

			for (const [patternSegment, child] of node.globChildren) {
				if (segmentMatches(patternSegment, segment)) {
					walk(child, depth + 1);
				}
			}
		};

		walk(this.root, 0);
		return results;
	}

	remove(predicate: (value: T) => boolean): void {
		const clean = (node: TrieNode<T>): boolean => {
			if (node.values) {
				node.values = node.values.filter((value) => !predicate(value));
				if (node.values.length === 0) node.values = undefined;
			}

			for (const [segment, child] of node.exactChildren) {
				if (clean(child)) node.exactChildren.delete(segment);
			}
			for (const [segment, child] of node.globChildren) {
				if (clean(child)) node.globChildren.delete(segment);
			}

			return !node.values && node.exactChildren.size === 0 && node.globChildren.size === 0;
		};

		clean(this.root);
	}
}

function normalizeTopic(topic: string): string[] {
	return topic
		.trim()
		.toLowerCase()
		.split('/')
		.filter((segment) => segment.length > 0);
}

function segmentMatches(pattern: string, segment: string): boolean {
	if (pattern === '*') return true;
	let regex = segmentPatternCache.get(pattern);
	if (!regex) {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
		regex = new RegExp(`^${escaped}$`);
		segmentPatternCache.set(pattern, regex);
	}
	return regex.test(segment);
}
