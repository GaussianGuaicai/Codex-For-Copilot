import { loadBundled, assertEqual } from './testBundleHelper.mjs';

const loaded = await loadBundled('src/streamPresenter.ts');
try {
  const { StreamPresenter } = loaded.exports;
  let now = 1_000;
  let scheduled;
  const emitted = [];
  const backend = [];
  const reported = [];
  const timers = {
    set(callback, delayMs) {
      scheduled = { callback, delayMs };
      return scheduled;
    },
    clear(timer) {
      if (scheduled === timer) {
        scheduled = undefined;
      }
    }
  };
  const presenter = new StreamPresenter(
    (kind, at) => backend.push({ kind, at }),
    (kind, at) => reported.push({ kind, at }),
    () => now,
    32,
    768,
    timers
  );
  const text = (value) => presenter.push({
    kind: 'text',
    identity: 'text',
    text: value,
    emit: (presented) => emitted.push({ kind: 'text', text: presented })
  });

  text('a');
  assertEqual(JSON.stringify(emitted), JSON.stringify([{ kind: 'text', text: 'a' }]), 'first delta is immediate');
  assertEqual(scheduled, undefined, 'first delta does not arm a timer');

  now = 1_001;
  text('b');
  now = 1_003;
  text('c');
  assertEqual(scheduled?.delayMs, 32, 'later delta aligns with the Extension Host batching interval');
  assertEqual(emitted.length, 1, 'small adjacent deltas are buffered');

  now = 1_033;
  scheduled.callback();
  assertEqual(JSON.stringify(emitted), JSON.stringify([
    { kind: 'text', text: 'a' },
    { kind: 'text', text: 'bc' }
  ]), 'timer flush preserves text order');

  now = 1_010;
  text('d');
  presenter.flushBoundary();
  now = 1_011;
  text('e');
  assertEqual(JSON.stringify(emitted), JSON.stringify([
    { kind: 'text', text: 'a' },
    { kind: 'text', text: 'bc' },
    { kind: 'text', text: 'd' },
    { kind: 'text', text: 'e' }
  ]), 'a boundary flushes and makes the next logical stream immediate');

  const metrics = presenter.metrics();
  assertEqual(metrics.backendDeltaCount, 5, 'all backend deltas are counted');
  assertEqual(metrics.progressReportCount, 4, 'report count reflects coalescing');
  assertEqual(metrics.coalescedDeltaCount, 1, 'only collapsed delta reports are counted');
  assertEqual(metrics.firstBackendDeltaAt, 1_000, 'first backend delta timestamp');
  assertEqual(metrics.firstReportAt, 1_000, 'first report timestamp');
  assertEqual(metrics.coalescingDelayP95Ms, 32, 'coalescing delay uses the deterministic clock');
  assertEqual(JSON.stringify(backend), JSON.stringify([
    { kind: 'text', at: 1_000 },
    { kind: 'text', at: 1_001 },
    { kind: 'text', at: 1_003 },
    { kind: 'text', at: 1_010 },
    { kind: 'text', at: 1_011 }
  ]), 'backend callbacks retain every delta');
  assertEqual(reported[0].at, 1_000, 'first report remains synchronous');

  const thresholdEmitted = [];
  const thresholdPresenter = new StreamPresenter(
    undefined,
    undefined,
    () => now,
    32,
    3,
    { set: () => ({ unref() {} }), clear() {} }
  );
  const thresholdText = (value) => thresholdPresenter.push({
    kind: 'text',
    identity: 'text',
    text: value,
    emit: (presented) => thresholdEmitted.push(presented)
  });
  thresholdText('a');
  thresholdText('b');
  thresholdText('cd');
  assertEqual(JSON.stringify(thresholdEmitted), JSON.stringify(['a', 'bcd']), 'character threshold flushes without waiting for a timer');

  const backpressureEmitted = [];
  const backpressurePresenter = new StreamPresenter(
    undefined,
    undefined,
    () => now,
    32,
    768,
    { set: () => ({ unref() {} }), clear() {} }
  );
  for (let index = 0; index < 1_000; index += 1) {
    backpressurePresenter.push({
      kind: 'text',
      identity: 'text',
      text: 'ab',
      emit: (presented) => backpressureEmitted.push(presented)
    });
  }
  assertEqual(
    backpressurePresenter.metrics().pendingPresentationCharacters,
    462,
    'backpressure metrics expose characters waiting at a semantic boundary'
  );
  backpressurePresenter.flushBoundary();
  assertEqual(backpressureEmitted.join('').length, 2_000, 'a tiny-delta burst preserves all streamed text');
  assertEqual(backpressureEmitted.length, 4, 'a tiny-delta burst is downsampled before reaching Chat UI');
  console.log('Smoke test passed: stream presentation coalesces adjacent deltas without delaying a new logical stream.');
} finally {
  await loaded.dispose();
}
