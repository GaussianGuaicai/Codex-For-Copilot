import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/reasoningStreamPresenter.ts');
try {
  const { ReasoningStreamPresenter } = loaded.exports;
  const emitted = [];
  const presenter = new ReasoningStreamPresenter((update) => emitted.push(update));
  const raw = (text) => presenter.push({
    source: 'reasoning-text', text, itemId: 'rs_1', partIndex: 0, outputIndex: 0
  });
  const summary = (text, presentationId) => presenter.push({
    source: 'summary', text, itemId: 'rs_1', partIndex: 0, outputIndex: 0, presentationId
  });

  raw('Raw ');
  raw('reasoning');
  summary('Summary', 'summary-part:1');
  summary('Next summary part', 'summary-part:2');
  presenter.startNextPhase();
  summary('Post-tool plan', 'summary-part:2');
  presenter.close();
  summary(' late');

  assertEqual(JSON.stringify(emitted.map(({ value, id, source }) => ({ value, id, source }))), JSON.stringify([
    { value: 'Summary', id: 'rs_1:reasoning:summary:summary-part:1:phase:0', source: 'summary' },
    { value: '\n\nNext summary part', id: 'rs_1:reasoning:summary:summary-part:2:phase:0', source: 'summary' },
    { value: 'Post-tool plan', id: 'rs_1:reasoning:summary:summary-part:2:phase:1', source: 'summary' }
  ]), 'summary is streamed immediately and replaces unreported raw reasoning');
  assertEqual(
    aggregateAdjacentThinking(emitted.slice(0, 2)),
    'Summary\n\nNext summary part',
    'VS Code-style adjacent Thinking aggregation keeps distinct summary parts readable'
  );
  assertEqual(presenter.metrics().backendDeltaCount, 5, 'raw and summary backend deltas are included in metrics');
  assertEqual(presenter.metrics().progressReportCount, 3, 'only visible summary reports are counted');
  assertEqual(presenter.presentationMode, 'closed', 'close seals one response reasoning stream');

  const rawOnly = [];
  const rawOnlyPresenter = new ReasoningStreamPresenter((update) => rawOnly.push(update));
  rawOnlyPresenter.push({
    source: 'reasoning-text', text: 'No summary was returned.', itemId: 'rs_raw', partIndex: 0, outputIndex: 0
  });
  rawOnlyPresenter.close();
  assertEqual(
    JSON.stringify(rawOnly.map(({ value, id }) => ({ value, id }))),
    JSON.stringify([{
      value: 'No summary was returned.',
      id: 'rs_raw:reasoning:reasoning-text:0:phase:0'
    }]),
    'raw reasoning is emitted only as the bounded no-summary fallback'
  );

  const toolBoundary = [];
  const toolBoundaryPresenter = new ReasoningStreamPresenter((update) => toolBoundary.push(update));
  toolBoundaryPresenter.push({
    source: 'reasoning-text', text: 'raw reasoning before a tool', itemId: 'rs_tool', partIndex: 0, outputIndex: 0
  });
  const boundaryMetrics = toolBoundaryPresenter.startNextPhase({ rawFallback: 'discard' });
  assertEqual(toolBoundary.length, 0, 'a tool boundary does not enqueue raw reasoning ahead of the tool loop');
  assertEqual(boundaryMetrics.rawFallbackCharacters, 27, 'tool-boundary telemetry records buffered reasoning size');
  assertEqual(boundaryMetrics.rawFallbackDiscarded, true, 'tool-boundary telemetry records fallback suppression');
  console.log('Smoke test passed: reasoning summary streaming uses VS Code-safe aggregation and bounded raw fallback.');
} finally {
  await loaded.dispose();
}

// Mirrors VS Code's relevant renderer contract: adjacent non-empty Thinking
// parts concatenate even when their IDs and metadata differ.
function aggregateAdjacentThinking(parts) {
  return parts.map((part) => part.value).join('');
}
