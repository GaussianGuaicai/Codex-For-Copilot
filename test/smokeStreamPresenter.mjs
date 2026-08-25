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
      const timer = {
        callback() {
          if (scheduled === timer) {
            scheduled = undefined;
          }
          callback();
        },
        delayMs,
        dueAt: now + delayMs
      };
      scheduled = timer;
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
    {
      now: () => now,
      minReportIntervalMs: 64,
      maxReportIntervalMs: 256,
      maxReportCharacters: 4,
      timerApi: timers
    }
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
  assertEqual(scheduled?.dueAt, 1_256, 'small deltas use the maximum presentation latency');
  assertEqual(emitted.length, 1, 'small adjacent deltas are buffered');

  now = 1_256;
  scheduled.callback();
  assertEqual(JSON.stringify(emitted), JSON.stringify([
    { kind: 'text', text: 'a' },
    { kind: 'text', text: 'bc' }
  ]), 'timer flush preserves text order');

  now = 1_257;
  text('de');
  now = 1_258;
  text('fg');
  assertEqual(scheduled?.dueAt, 1_320, 'a full chunk advances to the minimum presentation interval');
  now = 1_320;
  scheduled.callback();
  assertEqual(emitted.at(-1)?.text, 'defg', 'a full chunk is emitted without exceeding its bound');

  now = 1_321;
  text('h');
  presenter.flushBoundary();
  now = 1_322;
  text('i');
  assertEqual(emitted.at(-2)?.text, 'h', 'a semantic boundary flushes pending text');
  assertEqual(emitted.at(-1)?.text, 'i', 'a new semantic phase starts immediately');

  const metrics = presenter.metrics();
  assertEqual(metrics.backendDeltaCount, 7, 'all backend deltas are counted');
  assertEqual(metrics.progressReportCount, 5, 'report count reflects coalescing');
  assertEqual(metrics.coalescedDeltaCount, 2, 'collapsed backend deltas are counted');
  assertEqual(metrics.largestReportCharacters, 4, 'reported text never exceeds the configured bound');
  assertEqual(metrics.firstBackendDeltaAt, 1_000, 'first backend delta timestamp');
  assertEqual(metrics.firstReportAt, 1_000, 'first report timestamp');
  assertEqual(metrics.coalescingDelayP95Ms, 255, 'coalescing delay uses the deterministic clock');
  assertEqual(backend.length, 7, 'backend callback retains every delta');
  assertEqual(reported[0].at, 1_000, 'first report remains synchronous');

  let boundedScheduled;
  const boundedEmitted = [];
  const boundedTimers = {
    set(callback, delayMs) {
      const timer = {
        callback() {
          if (boundedScheduled === timer) {
            boundedScheduled = undefined;
          }
          callback();
        },
        delayMs,
        dueAt: now + delayMs
      };
      boundedScheduled = timer;
      return boundedScheduled;
    },
    clear(timer) {
      if (boundedScheduled === timer) {
        boundedScheduled = undefined;
      }
    }
  };
  const boundedPresenter = new StreamPresenter(undefined, undefined, {
    now: () => now,
    minReportIntervalMs: 250,
    maxReportIntervalMs: 2_000,
    maxReportCharacters: 512,
    timerApi: boundedTimers
  });
  const boundedText = (value) => boundedPresenter.push({
    kind: 'text',
    identity: 'text',
    text: value,
    emit: (presented) => boundedEmitted.push(presented)
  });
  now = 10_000;
  const streamEndsAt = now + 60_000;
  let nextDeltaAt = now;
  let boundedCharacters = 0;
  while (nextDeltaAt <= streamEndsAt) {
    while (boundedScheduled && boundedScheduled.dueAt <= nextDeltaAt) {
      now = boundedScheduled.dueAt;
      boundedScheduled.callback();
    }
    now = nextDeltaAt;
    boundedText('x');
    boundedCharacters += 1;
    nextDeltaAt += 10;
  }
  now = streamEndsAt;
  boundedPresenter.flushBoundary();
  assertEqual(boundedEmitted.join('').length, boundedCharacters, 'a one-minute dense stream preserves every character');
  assertEqual(boundedEmitted.length <= 32, true, 'a one-minute dense stream keeps UI updates bounded');
  assertEqual(boundedPresenter.metrics().largestReportCharacters <= 512, true, 'a dense stream never creates a large tail block');

  let drainScheduled;
  const drained = [];
  const drainTimers = {
    set(callback, delayMs) {
      const timer = {
        callback() {
          if (drainScheduled === timer) {
            drainScheduled = undefined;
          }
          callback();
        },
        delayMs,
        dueAt: now + delayMs
      };
      drainScheduled = timer;
      return drainScheduled;
    },
    clear(timer) {
      if (drainScheduled === timer) {
        drainScheduled = undefined;
      }
    }
  };
  const drainPresenter = new StreamPresenter(undefined, undefined, {
    now: () => now,
    minReportIntervalMs: 250,
    maxReportIntervalMs: 2_000,
    maxReportCharacters: 512,
    timerApi: drainTimers
  });
  now = 100_000;
  for (let index = 0; index < 1_000; index += 1) {
    drainPresenter.push({
      kind: 'text',
      identity: 'text',
      text: 'ab',
      emit: (presented) => drained.push(presented)
    });
  }
  assertEqual(drainPresenter.pendingCharacters, 1_998, 'a burst remains queued instead of flooding the UI');
  const drainPromise = drainPresenter.drainBoundary();
  while (drainPresenter.pendingCharacters > 0) {
    while (!drainScheduled && drainPresenter.pendingCharacters > 0) {
      await Promise.resolve();
    }
    if (drainPresenter.pendingCharacters === 0) {
      break;
    }
    const current = drainScheduled;
    now = current.dueAt;
    current.callback();
  }
  await drainPromise;
  const drainMetrics = drainPresenter.metrics();
  assertEqual(drained.join('').length, 2_000, 'completion drain preserves every buffered character');
  assertEqual(drained.length, 5, 'completion drain uses bounded chunks');
  assertEqual(drainMetrics.largestReportCharacters, 512, 'completion drain has a strict chunk-size ceiling');
  assertEqual(drainMetrics.boundaryDrainReportCount, 4, 'completion drain reports its paced tail work');
  assertEqual(drainMetrics.boundaryDrainDurationMs, 1_000, 'completion waits for paced tail delivery');

  const unicode = [];
  const unicodePresenter = new StreamPresenter(undefined, undefined, {
    now: () => now,
    minReportIntervalMs: 0,
    maxReportIntervalMs: 0,
    maxReportCharacters: 2,
    timerApi: { set: () => ({ unref() {} }), clear() {} }
  });
  unicodePresenter.push({
    kind: 'text',
    identity: 'text',
    text: 'a😀b',
    emit: (presented) => unicode.push(presented)
  });
  unicodePresenter.flushBoundary();
  assertEqual(unicode.join(''), 'a😀b', 'bounded chunks do not split a Unicode surrogate pair');

  console.log('Smoke test passed: stream presentation uses a paced bounded queue and drains completion backlog.');
} finally {
  await loaded.dispose();
}
