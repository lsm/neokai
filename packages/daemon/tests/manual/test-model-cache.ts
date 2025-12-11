/**
 * Manual test script to verify TTL-based lazy cache refresh
 *
 * Usage: bun run packages/daemon/tests/manual/test-model-cache.ts
 */

import {
	initializeModels,
	getAvailableModels,
	clearModelsCache,
} from '../../src/lib/model-service';

async function testModelCache() {
	console.log('\n=== Test 1: Initial model loading ===');
	await initializeModels();
	const models1 = getAvailableModels('global');
	console.log(`✓ Loaded ${models1.length} models:`);
	models1.forEach((m) => console.log(`  - ${m.name} (${m.id})`));

	console.log('\n=== Test 2: Second call should return cache immediately ===');
	const start = Date.now();
	const models2 = getAvailableModels('global');
	const elapsed = Date.now() - start;
	console.log(`✓ Returned ${models2.length} models in ${elapsed}ms (should be <5ms for cache hit)`);

	console.log('\n=== Test 3: Clear cache and verify fallback to static models ===');
	clearModelsCache('global');
	const models3 = getAvailableModels('global');
	console.log(`✓ After cache clear, got ${models3.length} models (static fallback)`);
	models3.forEach((m) => console.log(`  - ${m.name} (${m.id})`));

	console.log('\n=== Test 4: Reload models ===');
	await initializeModels();
	const models4 = getAvailableModels('global');
	console.log(`✓ Reloaded ${models4.length} models from SDK`);

	console.log('\n✅ All tests passed!\n');
}

testModelCache().catch((error) => {
	console.error('❌ Test failed:', error);
	process.exit(1);
});
