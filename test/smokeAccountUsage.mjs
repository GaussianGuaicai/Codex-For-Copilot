import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-account-'));
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
        'User-Agent': 'local.codex-for-copilot Codex for Copilot',
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
  assertEqual(capturedRequest.userAgent, 'local.codex-for-copilot Codex for Copilot', 'user agent');
  assertEqual(capturedRequest.accountId, 'acct-test', 'ChatGPT account id header');
  assertEqual(display.compactText, 'Codex: 5h 64% · Weekly 82%', 'rate windows compact display');
  assertIncludes(display.tooltip, 'Plan: Pro', 'plan tooltip');
  assertIncludes(display.tooltip, 'Credits balance: 25 credits', 'credits balance tooltip');
  assertIncludes(display.tooltip, 'Other rate limits:', 'other rate limits tooltip');

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
        'User-Agent': 'local.codex-for-copilot Codex for Copilot'
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

  const workspaceCreditsSnapshot = parseCodexAccountUsage({
    plan_type: 'self_serve_business_usage_based',
    rate_limits_by_limit_id: {
      codex: {
        primary_window: {
          used_percent: 36,
          limit_window_seconds: 18000
        },
        secondary_window: {
          used_percent: 18,
          limit_window_seconds: 604800
        },
        individual_limit: {
          limit: '900',
          used: '580',
          remaining_percent: 35.5555555556,
          resets_at: 1800000000
        }
      },
      other: {
        individualLimit: {
          limit: '1000',
          used: '100',
          remainingPercent: 90,
          resetsAt: 1800000000000
        }
      }
    }
  }, Date.now(), 'gpt-5.5');
  const workspaceCreditsDisplay = buildCodexAccountUsageDisplay(workspaceCreditsSnapshot, 'gpt-5.5');
  assertEqual(workspaceCreditsDisplay.compactText, 'Codex: Credits 36% · 320/900', 'credit budget compact display');
  assertIncludes(workspaceCreditsDisplay.tooltip, 'Credit budget: 320 / 900 credits remaining', 'credit budget tooltip');
  assertIncludes(workspaceCreditsDisplay.tooltip, 'resets ', 'credit budget reset tooltip');
  assertIncludes(workspaceCreditsDisplay.tooltip, 'Other credit budgets:', 'other credit budgets tooltip');
  assertIncludes(workspaceCreditsDisplay.tooltip, 'Other rate limits:', 'credit budget keeps rate limits in details');
  assertIncludes(workspaceCreditsDisplay.tooltip, '- 5h:', 'credit budget keeps five-hour limit in details');
  assertIncludes(workspaceCreditsDisplay.tooltip, '- Weekly:', 'credit budget keeps weekly limit in details');

  const dailyOnlySnapshot = parseCodexAccountUsage({
    rate_limit: {
      primary_window: {
        used_percent: 50,
        limit_window_seconds: 86400
      }
    }
  }, Date.now(), 'gpt-5.5');
  assertEqual(buildCodexAccountUsageDisplay(dailyOnlySnapshot, 'gpt-5.5').compactText, 'Codex: Daily 50%', 'daily window compact display');

  const incompleteBudgetSnapshot = parseCodexAccountUsage({
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 18000
      },
      individual_limit: {
        limit: '0',
        used: '0'
      }
    }
  }, Date.now(), 'gpt-5.5');
  assertEqual(buildCodexAccountUsageDisplay(incompleteBudgetSnapshot, 'gpt-5.5').compactText, 'Codex: 5h 75%', 'invalid budget fallback');

  const businessSpendControlSnapshot = parseCodexAccountUsage({
    plan_type: 'business',
    rate_limit: null,
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark-Preview',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 18000
          },
          secondary_window: {
            used_percent: 0,
            limit_window_seconds: 604800
          }
        }
      }
    ],
    credits: {
      has_credits: true,
      unlimited: false,
      balance: null
    },
    spend_control: {
      reached: false,
      individual_limit: {
        source: 'group_based_spend_controls',
        limit: 15000,
        used: 9025.19190955162,
        remaining: 5974.8080904483795,
        used_percent: 60,
        remaining_percent: 40,
        reset_after_seconds: 838515,
        reset_at: 1800000000
      }
    }
  }, Date.now(), 'gpt-5.5');
  const businessSpendControlDisplay = buildCodexAccountUsageDisplay(businessSpendControlSnapshot, 'gpt-5.5');
  assertEqual(businessSpendControlDisplay.compactText, 'Codex: Credits 40% · 5974.8/15000', 'root spend-control budget priority');
  assertIncludes(businessSpendControlDisplay.tooltip, 'Other rate limits:', 'root spend-control keeps model limits in details');
  assertIncludes(businessSpendControlDisplay.tooltip, 'GPT-5.3-Codex-Spark-Preview', 'root spend-control identifies additional model limit');

  const overdrawnSpendControlSnapshot = parseCodexAccountUsage({
    plan_type: 'business',
    spend_control: {
      reached: true,
      individual_limit: {
        source: 'group_based_spend_controls',
        limit: 100,
        used: 101,
        remaining: 0,
        remaining_percent: 1
      }
    }
  }, Date.now(), 'gpt-5.5');
  const overdrawnSpendControlDisplay = buildCodexAccountUsageDisplay(overdrawnSpendControlSnapshot, 'gpt-5.5');
  assertEqual(overdrawnSpendControlDisplay.compactText, 'Codex: Credits 0% · 0/100', 'overdrawn spend-control budget remains visible');
  assertIncludes(overdrawnSpendControlDisplay.tooltip, '101 credits used', 'overdrawn spend-control retains actual usage');

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
