// Reuse the provider's HTTP/WebSocket mock harness without running unrelated suites.
process.env.CODEX_TEST_REASONING_ONLY = '1';
await import('./smokeReasoningEffort.mjs');
await import('./smokeReasoningEffortSession.mjs');
await import('./smokeProviderFallback.mjs');
