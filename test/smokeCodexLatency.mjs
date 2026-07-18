import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-latency-'));
const bundlePath = join(tempDir, 'codexLatency.cjs');
const require = createRequire(import.meta.url);

await build({
  entryPoints: ['src/codexLatency.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath
});

try {
  const { CodexLatencyRecorder } = require(bundlePath);
  const latency = new CodexLatencyRecorder(1_000);
  latency.mark('credentialsResolved', 1_010);
  latency.mark('modelResolved', 1_040);
  latency.mark('messagesConverted', 1_050);
  latency.mark('branchResolved', 1_060);
  latency.mark('identityResolved', 1_070);
  latency.mark('requestReady', 1_080);
  latency.mark('connectionAcquired', 1_090);
  latency.mark('websocketConnected', 1_110);
  latency.mark('prewarmStarted', 1_115);
  latency.mark('prewarmCompleted', 1_130);
  latency.mark('requestSent', 1_135);
  latency.mark('responseCreated', 1_200);
  latency.mark('firstBackendDelta', 1_220);
  latency.mark('firstReasoning', 1_225);
  latency.mark('firstText', 1_240);
  latency.mark('firstToolCallAdded', 1_250);
  latency.mark('firstToolCallArgumentsDelta', 1_260);
  latency.mark('firstToolCallArgumentsDone', 1_290);
  latency.mark('firstToolCallReported', 1_294);
  latency.mark('firstToolCall', 1_294);
  latency.mark('responseCompleted', 1_300);
  latency.recordContext({
    metricVersion: 2,
    connectionOrigin: 'prewarm',
    connectionReused: false,
    previousResponseIdUsed: true,
    incrementalInputCount: 1,
    fullInputCount: 12,
    requestBodyBytes: 456,
    toolCount: 2,
    toolSchemaBytes: 123,
    toolSchemaCacheHit: true,
    requestBuildMs: 4.5,
    modelDiscoveryCacheState: 'stale',
    prewarmResult: 'success',
    transportActual: 'websocket-fresh',
    backendDeltaCount: 12,
    progressReportCount: 4,
    coalescedDeltaCount: 9,
    coalescingDelayP95Ms: 8,
    coalescingDelayMaxMs: 10,
    websocketSerializeMs: 1.5,
    reasoningEffort: 'low',
    serviceTier: 'auto'
  });

  const snapshot = latency.snapshot(1_400);
  assertEqual(snapshot.trace.providerSetupMs, 80, 'provider setup duration');
  assertEqual(snapshot.trace.modelResolutionMs, 30, 'model resolution duration');
  assertEqual(snapshot.trace.messageConversionMs, 10, 'message conversion duration');
  assertEqual(snapshot.trace.branchResolutionMs, 10, 'branch resolution duration');
  assertEqual(snapshot.trace.identityResolutionMs, 10, 'identity resolution duration');
  assertEqual(snapshot.trace.connectionQueueWaitMs, 10, 'connection queue duration');
  assertEqual(snapshot.trace.websocketConnectMs, 20, 'websocket connect duration');
  assertEqual(snapshot.trace.prewarmMs, 15, 'prewarm duration');
  assertEqual(snapshot.trace.requestToCreatedMs, 65, 'request to created duration');
  assertEqual(snapshot.trace.responseCreatedToFirstBackendDeltaMs, 20, 'created to first backend delta duration');
  assertEqual(snapshot.trace.firstBackendDeltaToFirstReportMs, 5, 'backend delta to first report duration');
  assertEqual(snapshot.trace.providerToFirstReportMs, 225, 'provider to first report duration');
  assertEqual(snapshot.trace.createdToFirstVisibleMs, 25, 'created to first visible duration');
  assertEqual(snapshot.trace.providerToFirstVisibleMs, 225, 'provider to first visible duration');
  assertEqual(snapshot.trace.toolCallAddedToFirstArgumentsDeltaMs, 10, 'tool call added to first arguments duration');
  assertEqual(snapshot.trace.toolCallArgumentsToDoneMs, 30, 'tool arguments to done duration');
  assertEqual(snapshot.trace.toolCallDoneToReportedMs, 4, 'tool call done to reported duration');
  assertEqual(snapshot.trace.totalMs, 300, 'total duration');
  assertEqual(snapshot.firstVisibleStage, 'firstReasoning', 'first visible stage');
  assertEqual(snapshot.stageOffsetsMs.responseCompleted, 300, 'completed stage offset');
  assertEqual(snapshot.stageOffsetsMs.firstToolCallAdded, 250, 'tool call added stage offset');
  assertEqual(snapshot.stageOffsetsMs.firstToolCallReported, 294, 'tool call reported stage offset');
  assertEqual(snapshot.context.connectionOrigin, 'prewarm', 'connection origin context');
  assertEqual(snapshot.context.incrementalInputCount, 1, 'incremental input context');
  assertEqual(snapshot.context.modelDiscoveryCacheState, 'stale', 'model cache context');
  assertEqual(snapshot.context.requestBodyBytes, 456, 'request bytes context');
  assertEqual(snapshot.context.toolSchemaBytes, 123, 'tool schema bytes context');
  assertEqual(snapshot.context.toolSchemaCacheHit, true, 'tool schema cache context');
  assertEqual(snapshot.context.requestBuildMs, 4.5, 'request build context');
  assertEqual(snapshot.context.metricVersion, 2, 'metric version context');
  assertEqual(snapshot.context.backendDeltaCount, 12, 'backend delta count context');
  assertEqual(snapshot.context.progressReportCount, 4, 'progress report count context');
  assertEqual(snapshot.context.coalescingDelayP95Ms, 8, 'coalescing delay context');
  assertEqual(snapshot.context.websocketSerializeMs, 1.5, 'WebSocket serialization context');
  console.log('Smoke test passed: latency tracing records redacted stage durations deterministically.');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
