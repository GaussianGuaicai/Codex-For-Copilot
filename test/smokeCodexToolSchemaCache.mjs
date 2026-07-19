import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/codexToolSchemaCache.ts', {});

try {
  const { resetCodexToolSchemaCache, resolveCodexToolSchemas } = loaded.exports;
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      filePath: { type: 'string' }
    },
    required: ['filePath']
  };
  const tools = [
    { name: 'read_file', description: 'Read a workspace file.', inputSchema: schema },
    { name: 'list_files', description: 'List workspace files.', inputSchema: schema }
  ];

  resetCodexToolSchemaCache();
  const first = resolveCodexToolSchemas(tools);
  const second = resolveCodexToolSchemas(tools);
  const reordered = resolveCodexToolSchemas([...tools].reverse());

  assertEqual(first.cacheHit, false, 'first schema resolution misses cache');
  assertEqual(second.cacheHit, true, 'same tool schema resolution hits cache');
  assertEqual(reordered.cacheHit, false, 'tool order is part of cache identity');
  assertEqual(first.toolSchemaBytes > 0, true, 'schema byte count is recorded');
  assertEqual(first.responseTools[0].parameters === schema, false, 'cached response schema is isolated from source schema mutation');
  assertEqual(Object.isFrozen(first.responseTools[0].parameters), true, 'cached response schema is frozen');
  assertEqual(Object.isFrozen(first.responseTools[0].parameters.properties), true, 'cached response schema properties are frozen');
  assertEqual(first.toolSignatures.read_file, second.toolSignatures.read_file, 'tool signature remains stable across cache hits');

  schema.properties.filePath.description = 'Mutated source schema after caching.';
  assertEqual(first.responseTools[0].parameters.properties.filePath.description, undefined, 'cached response schema stays immutable after source mutation');
  const mutated = resolveCodexToolSchemas(tools);
  assertEqual(mutated.cacheHit, false, 'nested source schema mutation invalidates the schema-set cache');
  assertEqual(mutated.responseTools[0].parameters.properties.filePath.description, 'Mutated source schema after caching.', 'mutated source schema is rebuilt into the next request definition');
  assertEqual(mutated.toolSignatures.read_file === first.toolSignatures.read_file, false, 'nested source schema mutation changes the branch tool signature');
  console.log('Smoke test passed: tool schema conversion is bounded, order-aware, mutation-sensitive, and isolated from source mutation.');
} finally {
  await loaded.dispose();
}