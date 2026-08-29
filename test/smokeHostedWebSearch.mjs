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
    formatWebSearchActivity,
    projectHostedToolLifecycleEvent,
    projectWebSearchActivity,
    projectWebSearchReplayItem,
    WebSearchStatusPresenter
  } = eventModule.exports;

  const clientTool = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } };
  const markerTool = { name: CODEX_WEB_SEARCH_TOOL_NAME, description: 'Search the web', inputSchema: { type: 'object' } };
  const plan = resolveHostedToolPlan([clientTool, markerTool], {
    externalWebAccess: false,
    contextSize: 'high',
    allowedDomains: ['example.com']
  });

  assertEqual(plan.clientTools.length, 1, 'marker is removed from client tools');
  assertEqual(plan.clientTools[0].name, 'read_file', 'ordinary VS Code tool is preserved');
  assertEqual(plan.responseTools.length, 1, 'one hosted tool is planned');
  assertEqual(plan.responseTools[0].type, 'web_search', 'hosted tool uses OpenAI SDK web search shape');
  assertEqual(plan.responseTools[0].external_web_access, false, 'hosted tool respects live-access configuration');
  assertEqual(plan.responseTools[0].search_context_size, 'high', 'hosted tool respects search context size');
  assertEqual(plan.responseTools[0].filters.allowed_domains[0], 'example.com', 'hosted tool applies allowed domains');
  assertEqual(plan.webSearchEnabled, true, 'web search selection is recorded');

  const lifecycle = projectHostedToolLifecycleEvent({
    type: 'response.web_search_call.searching',
    item_id: 'ws_test',
    output_index: 1,
    sequence_number: 4
  });
  assertEqual(lifecycle.phase, 'searching', 'web search lifecycle is normalized');
  assertEqual(lifecycle.itemId, 'ws_test', 'web search lifecycle keeps item identity');
  const completedItems = [
    {
      type: 'web_search_call', id: 'ws_first', status: 'completed',
      action: { type: 'search', queries: ['OpenAI web search'], sources: [{ type: 'url', url: 'https://example.com/one' }] }
    },
    {
      type: 'web_search_call', id: 'ws_second', status: 'completed',
      action: { type: 'open_page', url: 'https://example.com/article' }
    },
    {
      type: 'web_search_call', id: 'ws_third', status: 'completed',
      action: { type: 'find_in_page', pattern: 'pricing', url: 'https://example.com/article' }
    }
  ];
  const firstActivity = projectWebSearchActivity(completedItems[0]);
  assertEqual(firstActivity.action.queries[0], 'OpenAI web search', 'completed activity retains search queries');
  assertEqual(
    formatWebSearchActivity(firstActivity, { statusDetail: 'actionsAndSources', statusMaxSources: 3 }),
    '**Searched the web** · “OpenAI web search” · [example\\.com/one](<https://example.com/one>)',
    'detailed status displays the query and clickable source page on one line'
  );
  const statusPresenter = new WebSearchStatusPresenter({ statusDetail: 'actions', statusMaxSources: 3 });
  assertEqual(
    JSON.stringify([...completedItems, completedItems[0]].flatMap((item) => statusPresenter.present(item)?.value ?? [])),
    JSON.stringify([
      '**Searched the web** · “OpenAI web search”',
      '**Opened a web page** · [example\\.com/article](<https://example.com/article>)',
      '**Searched within a web page** · “pricing” · [example\\.com/article](<https://example.com/article>)'
    ]),
    'search, open-page, and find-in-page calls each produce one informative deduplicated status'
  );
  const lifecycleFallbackPresenter = new WebSearchStatusPresenter({ statusDetail: 'actionsAndSources', statusMaxSources: 3 });
  assertEqual(lifecycleFallbackPresenter.noteCompletedLifecycle({
    tool: 'web_search', phase: 'completed', itemId: 'ws_lifecycle_only', outputIndex: 2, sequenceNumber: 70
  }), true, 'a completed lifecycle event schedules one fallback status');
  assertEqual(lifecycleFallbackPresenter.noteCompletedLifecycle({
    tool: 'web_search', phase: 'completed', itemId: 'ws_first', outputIndex: 3, sequenceNumber: 71
  }), true, 'a second completed lifecycle event has its own status identity');
  lifecycleFallbackPresenter.present(completedItems[0]);
  assertEqual(
    lifecycleFallbackPresenter.presentLifecycleFallback('ws_lifecycle_only')?.value,
    '**Searched the web**',
    'a completed lifecycle event immediately falls back to one compact status when no detailed raw item arrives'
  );
  assertEqual(
    lifecycleFallbackPresenter.presentLifecycleFallback('ws_first'),
    undefined,
    'a detailed raw item cancels only its matching lifecycle fallback'
  );

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
