import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { resolveTestTempDirectory } from './testTempDirectory.mjs';

const tempDir = await mkdtemp(join(resolveTestTempDirectory(), 'codex-for-copilot-reasoning-effort-'));
const reasoningBundlePath = join(tempDir, 'reasoningEffort.cjs');
const modelsBundlePath = join(tempDir, 'models.cjs');
const moduleLoad = Module._load;
const require = createRequire(import.meta.url);

await build({
  entryPoints: ['src/reasoningEffort.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: reasoningBundlePath
});

await build({
  entryPoints: ['src/models.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: modelsBundlePath,
  external: ['vscode']
});

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }

  return moduleLoad.call(this, request, parent, isMain);
};

const {
  getReasoningEffortDescription,
  getReasoningEffortLabel,
  normalizeKnownReasoningEffort,
  normalizeReasoningEffort,
  resolveReasoningEffort,
  buildResponsesReasoning,
  toResponsesReasoning
} = require(reasoningBundlePath);
const { buildProviderModels } = require(modelsBundlePath);

try {
  const model = buildProviderModels(createConfig(), [createCatalogModel()], 'codexAccessToken')[0];
  const schema = model.info.configurationSchema?.properties?.reasoningEffort;
  if (!schema) {
    throw new Error('Expected a reasoning effort configuration schema.');
  }

  assertEqual(
    schema.enum.join(','),
    'low,max,ultra,future_effort',
    'catalog reasoning efforts remain ordered and forward-compatible'
  );
  assertEqual(
    schema.enumItemLabels.join(','),
    'Low,Maximum,Ultra,Future Effort',
    'known and custom reasoning efforts receive readable labels'
  );
  assertEqual(schema.default, 'low', 'catalog default reasoning effort');
  assertEqual(
    schema.enumDescriptions[3],
    'Use the Future Effort reasoning effort advertised by the selected model.',
    'custom effort receives a truthful fallback description'
  );
  assertEqual(
    model.info.detail?.includes('Thinking: Low, Maximum, Ultra, Future Effort (default: Low)'),
    true,
    'model detail exposes the full catalog reasoning range'
  );

  assertEqual(normalizeReasoningEffort(' future_effort '), 'future_effort', 'custom effort normalization');
  assertEqual(normalizeReasoningEffort('   '), undefined, 'blank effort rejection');
  assertEqual(normalizeKnownReasoningEffort('max'), 'max', 'known max setting normalization');
  assertEqual(normalizeKnownReasoningEffort('ultra'), 'ultra', 'known ultra setting normalization');
  assertEqual(normalizeKnownReasoningEffort('future_effort'), undefined, 'settings reject unknown effort values');
  assertEqual(getReasoningEffortLabel('future_effort'), 'Future Effort', 'custom effort label formatting');
  assertEqual(
    getReasoningEffortDescription('max'),
    'Maximum reasoning depth for the hardest problems.',
    'maximum effort description'
  );

  assertResolution(
    resolveReasoningEffort('low', { modelConfiguration: { reasoningEffort: 'ultra' } }, undefined),
    'ultra',
    'modelConfiguration',
    false,
    'VS Code model configuration can select Ultra'
  );
  assertResolution(
    resolveReasoningEffort('low', { modelOptions: { thinking: { effort: 'future_effort' } } }, undefined),
    'future_effort',
    'modelOptions.thinking.effort',
    false,
    'future catalog effort survives runtime option resolution'
  );
  assertResolution(
    resolveReasoningEffort('low', {
      modelOptions: { reasoningEffort: 'max' },
      modelConfiguration: { reasoningEffort: 'ultra' }
    }, undefined),
    'max',
    'modelOptions.reasoningEffort',
    true,
    'request-level effort keeps precedence and reports conflicts'
  );
  assertEqual(toResponsesReasoning('ultra').effort, 'ultra', 'Ultra remains unchanged at the SDK boundary');
  assertEqual(
    JSON.stringify(buildResponsesReasoning({ effort: 'high', summary: 'auto' })),
    JSON.stringify({ effort: 'high', summary: 'auto' }),
    'explicit reasoning summary is preserved'
  );
  assertEqual(
    JSON.stringify(buildResponsesReasoning({ effort: 'none', summary: 'auto' })),
    JSON.stringify({ effort: 'none' }),
    'none omits reasoning summary'
  );

  console.log('Smoke test passed: catalog reasoning efforts are selectable, forward-compatible, and preserved on the wire.');
} finally {
  Module._load = moduleLoad;
  await rm(tempDir, { recursive: true, force: true });
}

function createConfig() {
  return {
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    clientVersion: '0.0.0',
    credentialsSource: 'codexAuth',
    transport: 'auto',
    websocketPrewarm: 'auto',
    requestCompression: 'auto',
    model: 'gpt-5.6-sol',
    includeHiddenModels: false,
    disabledModels: [],
    modelAliases: {},
    instructions: 'Smoke test instructions',
    defaultReasoningEffort: undefined,
    defaultServiceTier: undefined,
    maxOutputTokens: 8192,
    modelPricingUsdPerMTok: {}
  };
}

function createCatalogModel() {
  return {
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    context_window: 372000,
    max_context_window: 372000,
    default_reasoning_level: 'low',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
      { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      { effort: 'future_effort' }
    ]
  };
}

function assertResolution(actual, effort, source, hasExplicitConflict, label) {
  assertEqual(actual.effort, effort, `${label} effort`);
  assertEqual(actual.source, source, `${label} source`);
  assertEqual(actual.hasExplicitConflict, hasExplicitConflict, `${label} conflict`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}
