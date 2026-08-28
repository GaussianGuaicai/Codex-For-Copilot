import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const planModule = await loadBundled('src/hostedTools/hostedToolPlan.ts');
const eventModule = await loadBundled('src/hostedTools/hostedToolEvents.ts');

try {
  const {
    CODEX_WEB_SEARCH_TOOL_NAME,
    resolveHostedToolPlan
  } = planModule.exports;
  const {
    extractWebSearchSources,
    formatWebSearchSources,
    projectHostedToolLifecycleEvent,
    projectWebSearchReplayItem
  } = eventModule.exports;

  const clientTool = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } };
  const markerTool = { name: CODEX_WEB_SEARCH_TOOL_NAME, description: 'Search the web', inputSchema: { type: 'object' } };
  const plan = resolveHostedToolPlan([clientTool, markerTool]);

  assertEqual(plan.clientTools.length, 1, 'marker is removed from client tools');
  assertEqual(plan.clientTools[0].name, 'read_file', 'ordinary VS Code tool is preserved');
  assertEqual(plan.responseTools.length, 1, 'one hosted tool is planned');
  assertEqual(plan.responseTools[0].type, 'web_search', 'hosted tool uses OpenAI SDK web search shape');
  assertEqual(plan.responseTools[0].external_web_access, true, 'hosted tool explicitly enables live web access');
  assertEqual(plan.webSearchEnabled, true, 'web search selection is recorded');

  const lifecycle = projectHostedToolLifecycleEvent({
    type: 'response.web_search_call.searching',
    item_id: 'ws_test',
    output_index: 1,
    sequence_number: 4
  });
  assertEqual(lifecycle.phase, 'searching', 'web search lifecycle is normalized');
  assertEqual(lifecycle.itemId, 'ws_test', 'web search lifecycle keeps item identity');

  const callSources = extractWebSearchSources({
    type: 'web_search_call',
    action: {
      type: 'search',
      sources: [
        { type: 'url', url: 'https://example.com/one' },
        { type: 'url', url: 'file:///not-allowed' }
      ]
    }
  });
  const citationSources = extractWebSearchSources({
    type: 'message',
    content: [{
      type: 'output_text',
      annotations: [{
        type: 'url_citation',
        url: 'https://example.com/one',
        title: 'Example [One]',
        start_index: 0,
        end_index: 1
      }]
    }]
  });
  assertEqual(callSources.length, 1, 'unsafe web search source URLs are discarded');
  assertEqual(citationSources[0].title, 'Example [One]', 'citation title is retained');
  assertEqual(
    formatWebSearchSources([...callSources, ...citationSources]),
    '\n\nSources:\n- [Example \\[One\\]](<https://example.com/one>)',
    'sources are deduplicated, titled, escaped, and clickable'
  );

  const replay = projectWebSearchReplayItem({
    type: 'web_search_call',
    id: 'ws_test',
    status: 'completed',
    action: { type: 'search', queries: ['OpenAI SDK'] }
  });
  assertEqual(replay?.id, 'ws_test', 'completed web search call is safe to replay');
  assertEqual(
    projectWebSearchReplayItem({
      type: 'web_search_call',
      id: 'ws_bad',
      status: 'completed',
      action: { type: 'open_page', url: 'javascript:alert(1)' }
    }),
    undefined,
    'unsafe replay URLs are rejected'
  );

  console.log('Smoke test passed: hosted Web Search remains independent from client and Native Tool Search tools.');
} finally {
  await planModule.dispose();
  await eventModule.dispose();
}
