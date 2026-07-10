import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tempDir = await mkdtemp(join(tmpdir(), 'codex-for-copilot-account-'));
const bundlePath = join(tempDir, 'accountUsage.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);

await build({
  entryPoints: ['src/accountUsage.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  external: ['vscode']
});

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }

  return moduleLoad.call(this, request, parent, isMain);
};

const {
  buildCodexAccountUsageDisplay,
  fetchCodexAccountUsage,
  getCodexAccountUsageURLs,
  parseCodexAccountUsage
} = require(bundlePath);

let capturedRequest;
const server = createServer(async (request, response) => {
  capturedRequest = {
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    userAgent: request.headers['user-agent'],
    accountId: request.headers['chatgpt-account-id']
  };

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    plan_type: 'Pro',
    credits: { balance: 25 },
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 36,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600
      },
      secondary_window: {
        used_percent: 18,
        limit_window_seconds: 604800,
        reset_after_seconds: 7200
      }
    },
    additional_rate_limits: [
      {
        limit_name: 'Daily extra',
        metered_feature: 'codex-extra',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 50,
            limit_window_seconds: 86400
          }
        }
      },
      {
        limit_name: 'Model weekly fallback',
        metered_feature: 'codex-model',
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: 604800
          }
        }
      }
    ]
  }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/backend-api/codex/responses`;
  const usageURLs = getCodexAccountUsageURLs(baseURL);
  assertEqual(usageURLs[0], `http://127.0.0.1:${address.port}/backend-api/wham/usage`, 'ChatGPT usage URL');

  const snapshot = await fetchCodexAccountUsage({
    baseURL,
    selectedModel: 'gpt-5.5',
    credentials: {
      apiKey: 'test-access-token',
      headers: {
        'User-Agent': 'local.codex-for-copilot/1.0.0 Codex-Extension',
        'ChatGPT-Account-ID': 'acct-test'
      },
      source: 'codexAuth',
      kind: 'codexAccessToken',
      omitMaxOutputTokens: true
    }
  });

  const display = buildCodexAccountUsageDisplay(snapshot, 'gpt-5.5', snapshot.fetchedAt);
  assertEqual(capturedRequest.method, 'GET', 'method');
  assertEqual(capturedRequest.url, '/backend-api/wham/usage', 'request path');
  assertEqual(capturedRequest.authorization, 'Bearer test-access-token', 'authorization header');
  assertEqual(capturedRequest.userAgent, 'local.codex-for-copilot/1.0.0 Codex-Extension', 'user agent');
  assertEqual(capturedRequest.accountId, 'acct-test', 'ChatGPT account id header');
  assertEqual(display.compactText, 'Codex: 5h 64% · weekly 82% · 25 credits', 'compact display priority');
  assertIncludes(display.tooltip, 'Plan: Pro', 'plan tooltip');
  assertIncludes(display.tooltip, 'Other limits:', 'other limits tooltip');

  const authManager = {
    accessTokenCalls: 0,
    refreshCalls: 0,
    async getAccessToken() {
      this.accessTokenCalls += 1;
      return 'manager-access-token';
    },
    async refreshAfter401() {
      this.refreshCalls += 1;
    }
  };

  await fetchCodexAccountUsage({
    baseURL,
    selectedModel: 'gpt-5.5',
    credentials: {
      apiKey: 'stale-access-token',
      headers: {
        'User-Agent': 'local.codex-for-copilot/1.0.0 Codex-Extension'
      },
      source: 'codexAuth',
      authManager,
      kind: 'codexAccessToken',
      omitMaxOutputTokens: true
    }
  });
  assertEqual(capturedRequest.authorization, 'Bearer manager-access-token', 'authManager authorization header');
  assertEqual(authManager.accessTokenCalls, 1, 'authManager access token calls without retry');
  assertEqual(authManager.refreshCalls, 0, 'authManager no refresh on success');

  const fallbackSnapshot = parseCodexAccountUsage({ credits_balance: 25 }, Date.now(), 'gpt-5.5');
  assertEqual(buildCodexAccountUsageDisplay(fallbackSnapshot, 'gpt-5.5').compactText, 'Codex: 25 credits', 'credits fallback');

  const onePercentSnapshot = parseCodexAccountUsage({
    rate_limit: {
      primary_window: {
        used_percent: 1,
        limit_window_seconds: 18000
      }
    }
  }, Date.now(), 'gpt-5.5');
  assertEqual(buildCodexAccountUsageDisplay(onePercentSnapshot, 'gpt-5.5').compactText, 'Codex: 5h 99%', 'integer one percent parsing');

  await assertRejects(
    fetchCodexAccountUsage({
      baseURL,
      selectedModel: 'gpt-5.5',
      credentials: {
        apiKey: 'sk-test',
        headers: {},
        source: 'secretStorage',
        kind: 'openaiApiKey',
        omitMaxOutputTokens: false
      }
    }),
    'Codex account usage can only be queried',
    'api key credential guard'
  );

  console.log('Smoke test passed: account usage request, parsing, and display priority are correct.');
} finally {
  Module._load = moduleLoad;
  server.close();
  await rm(tempDir, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(actual, expected, label) {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

async function assertRejects(promise, expectedMessage, label) {
  try {
    await promise;
  } catch (error) {
    if (String(error?.message ?? error).includes(expectedMessage)) {
      return;
    }

    throw error;
  }

  throw new Error(`${label}: expected rejection`);
}