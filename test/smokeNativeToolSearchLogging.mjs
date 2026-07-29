import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/nativeToolSearch/nativeToolLogging.ts', {});
try {
  const { summarizeNativeToolSearchItem } = loaded.exports;
  const searchCall = summarizeNativeToolSearchItem({
    type: 'tool_search_call', execution: 'server', status: 'completed', arguments: { paths: ['vscode_execute'] }
  });
  assertEqual(searchCall.event, 'search_call', 'hosted search calls are logged');
  assertEqual(searchCall.paths.join(','), 'vscode_execute', 'search paths are preserved');

  const searchOutput = summarizeNativeToolSearchItem({
    type: 'tool_search_output', execution: 'server', status: 'completed', tools: [{
      type: 'namespace', name: 'vscode_execute', tools: [
        { type: 'function', name: 'run_in_terminal', parameters: { secret: 'not logged' } },
        { type: 'function', name: 'send_to_terminal' }
      ]
    }]
  });
  assertEqual(searchOutput.event, 'search_output', 'hosted search outputs are logged');
  assertEqual(searchOutput.loadedFunctionCount, 2, 'loaded functions are counted');
  assertEqual(searchOutput.loadedNamespaces[0].functionNames.join(','), 'run_in_terminal,send_to_terminal', 'schemas are excluded from the summary');
  console.log('Smoke test passed: native Tool Search logs only safe search and loaded-tool summaries.');
} finally { await loaded.dispose(); }
