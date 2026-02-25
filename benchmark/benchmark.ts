import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { MemoryEngine } from '../src/MemoryEngine'

type CollectionId = 'compliance' | 'payments' | 'risk'

type QueryCase = {
  id: string
  question: string
  expectedPrimary: CollectionId
  crossCollection: boolean
}

type Mismatch = {
  iteration: number
  kind: 'route' | 'retrieve' | 'prompt'
  expected: string
  actual: string
}

type QueryRunState = {
  id: string
  question: string
  expectedPrimary: CollectionId
  crossCollection: boolean
  firstRoute: string[]
  firstRetrievedNodeIds: string[]
  firstPromptHash: string
  routeLatencies: number[]
  retrieveLatencies: number[]
  promptLatencies: number[]
  askLatencies: number[]
  answerLengths: number[]
  routeStable: boolean
  retrieveStable: boolean
  promptStable: boolean
  mismatches: Mismatch[]
}

type SignatureBaseline = {
  route: string
  retrieve: string
  prompt: string
}

type TimingSummary = {
  count: number
  mean: number
  p50: number
  p95: number
  min: number
  max: number
}

const DEFAULT_ITERATIONS = 10
const DEFAULT_TOP_COLLECTIONS = 3
const DEFAULT_TOP_K = 5
const DEFAULT_MAX_CONTEXT_CHARS = 2000
const DEFAULT_TOP_K_PER_COLLECTION = 3
const DEFAULT_SNAPSHOT_DIR = path.resolve(process.cwd(), 'benchmark/snapshots')
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'benchmark/results/latest.json')
const DEFAULT_DATA_ROOT = path.resolve(process.cwd(), 'benchmark/data')
const DEFAULT_MODEL = 'qwen2.5:7b'
const EXPECTED_COLLECTIONS: CollectionId[] = ['compliance', 'payments', 'risk']

const QUERIES: QueryCase[] = [
  {
    id: 'compliance_kyc_ownership',
    question: 'Which controls verify customer identity and beneficial ownership during onboarding?',
    expectedPrimary: 'compliance',
    crossCollection: false
  },
  {
    id: 'compliance_aml_escalation',
    question: 'How does AML monitoring escalate alerts from unusual transaction patterns?',
    expectedPrimary: 'compliance',
    crossCollection: false
  },
  {
    id: 'compliance_sanctions_updates',
    question: 'What process updates sanctions lists and resolves potential name matches?',
    expectedPrimary: 'compliance',
    crossCollection: false
  },
  {
    id: 'compliance_chargeback_sanctions',
    question: 'How are chargeback alerts with sanctions exposure escalated and documented?',
    expectedPrimary: 'compliance',
    crossCollection: true
  },
  {
    id: 'payments_ledger_balance',
    question: 'How does ledger posting enforce balanced double entry for each transaction?',
    expectedPrimary: 'payments',
    crossCollection: false
  },
  {
    id: 'payments_idempotency',
    question: 'What is the idempotency key strategy for retrying customer payment requests?',
    expectedPrimary: 'payments',
    crossCollection: false
  },
  {
    id: 'payments_settlement_breaks',
    question: 'How are settlement breaks reconciled when provider files arrive late?',
    expectedPrimary: 'payments',
    crossCollection: false
  },
  {
    id: 'payments_chargeback_limit_signals',
    question: 'How does chargeback handling coordinate with risk limit and fraud signals?',
    expectedPrimary: 'payments',
    crossCollection: true
  },
  {
    id: 'risk_model_calibration',
    question: 'How is the risk score model calibrated when false negatives increase?',
    expectedPrimary: 'risk',
    crossCollection: false
  },
  {
    id: 'risk_signal_aggregation',
    question: 'Which fraud signals are aggregated before blocking a transaction?',
    expectedPrimary: 'risk',
    crossCollection: false
  },
  {
    id: 'risk_velocity_controls',
    question: 'How do velocity rules prevent rapid attack attempts without over blocking?',
    expectedPrimary: 'risk',
    crossCollection: false
  },
  {
    id: 'risk_limit_exposure',
    question: 'What steps reduce exposure when dynamic customer limits are near saturation?',
    expectedPrimary: 'risk',
    crossCollection: false
  }
]

async function main(): Promise<void> {
  const startedAt = new Date()
  const runId = startedAt.toISOString().replace(/[:.]/g, '-')
  const iterations = parsePositiveIntArg('--iterations', DEFAULT_ITERATIONS)
  const snapshotDir = path.resolve(parseStringArg('--snapshot-dir') ?? DEFAULT_SNAPSHOT_DIR)
  const outputPath = path.resolve(parseStringArg('--output') ?? DEFAULT_OUTPUT)
  const dataRoot = path.resolve(parseStringArg('--data-root') ?? DEFAULT_DATA_ROOT)
  const liveLlm = hasFlag('--live-llm')
  const provider = normalizeProvider(process.env.LLM_PROVIDER)
  const model = process.env.BENCHMARK_MODEL || DEFAULT_MODEL

  const sourceFiles = await collectMarkdownFiles(dataRoot)
  sourceFiles.sort((a, b) => a.localeCompare(b))

  assert.ok(sourceFiles.length >= 15, `Benchmark dataset should contain at least 15 markdown files: ${sourceFiles.length}`)

  const baseEngine = new MemoryEngine({
    model,
    provider,
    topK: DEFAULT_TOP_K,
    maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    temperature: 0,
    snapshotDir,
    localUrl: process.env.LOCAL_LLM_URL,
    openAIBaseUrl: process.env.OPENAI_BASE_URL,
    openAIApiKey: process.env.OPENAI_API_KEY
  })

  const ingestStarted = performance.now()
  const ingestReport = await baseEngine.ingestAuto(dataRoot, { defaultCollectionId: 'general' })
  const ingestDurationMs = performance.now() - ingestStarted

  const discoveredCollections = Array.from(new Set(ingestReport.assignments.map((item) => item.collectionId))).sort((a, b) => a.localeCompare(b))
  const sourceStats = collectCollectionStats(baseEngine, discoveredCollections)

  const datasetChecks = evaluateDataset(discoveredCollections, sourceStats)

  const saveStarted = performance.now()
  const saveReport = await baseEngine.saveSnapshots()
  const saveDurationMs = performance.now() - saveStarted

  const restoredEngine = new MemoryEngine({
    model,
    provider,
    topK: DEFAULT_TOP_K,
    maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    temperature: 0,
    snapshotDir,
    localUrl: process.env.LOCAL_LLM_URL,
    openAIBaseUrl: process.env.OPENAI_BASE_URL,
    openAIApiKey: process.env.OPENAI_API_KEY
  })

  const loadStarted = performance.now()
  const loadReport = await restoredEngine.loadSnapshots(undefined, { sourceRootPath: dataRoot })
  const loadDurationMs = performance.now() - loadStarted

  const restoredStats = collectCollectionStats(restoredEngine, discoveredCollections)
  const roundtrip = compareStatsRoundtrip(sourceStats, restoredStats)

  const queryState = new Map<string, QueryRunState>()
  const signatures = new Map<string, SignatureBaseline>()
  const routeAll: number[] = []
  const retrieveAll: number[] = []
  const promptAll: number[] = []
  const askAll: number[] = []
  let liveEmptyResponses = 0

  for (const query of QUERIES) {
    queryState.set(query.id, {
      id: query.id,
      question: query.question,
      expectedPrimary: query.expectedPrimary,
      crossCollection: query.crossCollection,
      firstRoute: [],
      firstRetrievedNodeIds: [],
      firstPromptHash: '',
      routeLatencies: [],
      retrieveLatencies: [],
      promptLatencies: [],
      askLatencies: [],
      answerLengths: [],
      routeStable: true,
      retrieveStable: true,
      promptStable: true,
      mismatches: []
    })
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const query of QUERIES) {
      const state = queryState.get(query.id)
      if (!state) {
        continue
      }

      const routeStarted = performance.now()
      const route = await restoredEngine.routeCollections(query.question, { topCollections: DEFAULT_TOP_COLLECTIONS })
      const routeMs = performance.now() - routeStarted
      routeAll.push(routeMs)
      state.routeLatencies.push(routeMs)

      const primaryCollection = route[0]
      const retrieveStarted = performance.now()
      const retrieved = primaryCollection
        ? await restoredEngine.retrieve(primaryCollection, query.question, DEFAULT_TOP_K)
        : []
      const retrieveMs = performance.now() - retrieveStarted
      retrieveAll.push(retrieveMs)
      state.retrieveLatencies.push(retrieveMs)

      const promptStarted = performance.now()
      const prompt = primaryCollection
        ? await restoredEngine.buildPrompt(primaryCollection, query.question, DEFAULT_TOP_K, DEFAULT_MAX_CONTEXT_CHARS)
        : ''
      const promptMs = performance.now() - promptStarted
      promptAll.push(promptMs)
      state.promptLatencies.push(promptMs)

      const routeSignature = route.join('|')
      const retrieveSignature = retrieved.map((node) => node.id).join('|')
      const promptSignature = hashText(prompt)

      if (iteration === 0) {
        state.firstRoute = [...route]
        state.firstRetrievedNodeIds = retrieved.map((node) => node.id)
        state.firstPromptHash = promptSignature
        signatures.set(query.id, {
          route: routeSignature,
          retrieve: retrieveSignature,
          prompt: promptSignature
        })
      } else {
        const baseline = signatures.get(query.id)
        if (!baseline) {
          continue
        }
        if (baseline.route !== routeSignature) {
          state.routeStable = false
          state.mismatches.push({
            iteration,
            kind: 'route',
            expected: baseline.route,
            actual: routeSignature
          })
        }
        if (baseline.retrieve !== retrieveSignature) {
          state.retrieveStable = false
          state.mismatches.push({
            iteration,
            kind: 'retrieve',
            expected: baseline.retrieve,
            actual: retrieveSignature
          })
        }
        if (baseline.prompt !== promptSignature) {
          state.promptStable = false
          state.mismatches.push({
            iteration,
            kind: 'prompt',
            expected: baseline.prompt,
            actual: promptSignature
          })
        }
      }

      if (liveLlm) {
        const askStarted = performance.now()
        const answer = await restoredEngine.ask(query.question, {
          topCollections: DEFAULT_TOP_COLLECTIONS,
          topKPerCollection: DEFAULT_TOP_K_PER_COLLECTION,
          maxContextChars: DEFAULT_MAX_CONTEXT_CHARS
        })
        const askMs = performance.now() - askStarted
        askAll.push(askMs)
        state.askLatencies.push(askMs)
        state.answerLengths.push(answer.length)
        if (answer.trim().length === 0) {
          liveEmptyResponses += 1
        }
      }
    }
  }

  const queryReports = QUERIES.map((query) => {
    const state = queryState.get(query.id)
    if (!state) {
      return null
    }

    const firstPrimaryCollection = state.firstRoute[0] || ''
    return {
      id: state.id,
      question: state.question,
      expectedPrimary: state.expectedPrimary,
      firstPrimaryCollection,
      primaryMatch: firstPrimaryCollection === state.expectedPrimary,
      crossCollection: state.crossCollection,
      firstRoute: state.firstRoute,
      firstRetrievedNodeIds: state.firstRetrievedNodeIds,
      firstPromptHash: state.firstPromptHash,
      signaturesStable: {
        route: state.routeStable,
        retrieve: state.retrieveStable,
        prompt: state.promptStable
      },
      mismatches: state.mismatches,
      latency: {
        routeMs: summarize(state.routeLatencies),
        retrieveMs: summarize(state.retrieveLatencies),
        promptMs: summarize(state.promptLatencies),
        askMs: summarize(state.askLatencies)
      },
      liveAsk: {
        enabled: liveLlm,
        runs: state.answerLengths.length,
        nonEmptyResponses: state.answerLengths.filter((size) => size > 0).length,
        emptyResponses: state.answerLengths.filter((size) => size === 0).length,
        avgAnswerChars: state.answerLengths.length > 0
          ? Number((state.answerLengths.reduce((sum, size) => sum + size, 0) / state.answerLengths.length).toFixed(2))
          : 0
      }
    }
  }).filter((item) => item !== null)

  const routePass = queryReports.every((item) => item.signaturesStable.route)
  const retrievePass = queryReports.every((item) => item.signaturesStable.retrieve)
  const promptPass = queryReports.every((item) => item.signaturesStable.prompt)
  const primaryRoutePass = queryReports.every((item) => item.primaryMatch)

  const hardPass = datasetChecks.pass
    && roundtrip.pass
    && routePass
    && retrievePass
    && promptPass

  const softWarnings: string[] = []
  if (liveLlm && liveEmptyResponses > 0) {
    softWarnings.push(`Live LLM produced ${liveEmptyResponses} empty responses`)
  }

  const finishedAt = new Date()

  const report = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Number((finishedAt.getTime() - startedAt.getTime()).toFixed(2)),
    config: {
      iterations,
      liveLlm,
      model,
      provider,
      dataRoot,
      snapshotDir,
      outputPath
    },
    dataset: {
      files: sourceFiles.length,
      collectionsDiscovered: discoveredCollections,
      expectedCollections: EXPECTED_COLLECTIONS,
      checks: datasetChecks,
      stats: sourceStats
    },
    snapshot: {
      saveReport,
      loadReport,
      timingMs: {
        ingest: Number(ingestDurationMs.toFixed(2)),
        save: Number(saveDurationMs.toFixed(2)),
        load: Number(loadDurationMs.toFixed(2))
      },
      roundtrip
    },
    determinism: {
      routePass,
      retrievePass,
      promptPass,
      primaryRoutePass,
      mismatches: {
        route: queryReports.flatMap((item) => item.mismatches.filter((m) => m.kind === 'route').map((m) => ({ queryId: item.id, ...m }))),
        retrieve: queryReports.flatMap((item) => item.mismatches.filter((m) => m.kind === 'retrieve').map((m) => ({ queryId: item.id, ...m }))),
        prompt: queryReports.flatMap((item) => item.mismatches.filter((m) => m.kind === 'prompt').map((m) => ({ queryId: item.id, ...m })))
      }
    },
    latency: {
      routeMs: summarize(routeAll),
      retrieveMs: summarize(retrieveAll),
      promptMs: summarize(promptAll),
      askMs: summarize(askAll)
    },
    queries: queryReports,
    softWarnings,
    overallPass: hardPass
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log('=== CHME Benchmark ===')
  console.log(`Run ID: ${runId}`)
  console.log(`Dataset files: ${sourceFiles.length}`)
  console.log(`Collections: ${discoveredCollections.join(', ')}`)
  console.log(`Iterations: ${iterations}`)
  console.log(`Live LLM: ${liveLlm ? 'enabled' : 'disabled'}`)
  console.log(`Hard checks: ${hardPass ? 'PASS' : 'FAIL'}`)
  console.log(`Roundtrip: ${roundtrip.pass ? 'PASS' : 'FAIL'}`)
  console.log(`Route stable: ${routePass}`)
  console.log(`Retrieve stable: ${retrievePass}`)
  console.log(`Prompt stable: ${promptPass}`)
  if (softWarnings.length > 0) {
    console.log(`Soft warnings: ${softWarnings.join(' | ')}`)
  }
  console.log(`Report: ${outputPath}`)

  if (!hardPass) {
    process.exitCode = 1
  }
}

function normalizeProvider(value: string | undefined): 'local' | 'openai' {
  const normalized = (value || 'local').toLowerCase()
  return normalized === 'openai' ? 'openai' : 'local'
}

function parsePositiveIntArg(flag: string, fallback: number): number {
  const value = parseStringArg(flag)
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be an integer >= 1`)
  }
  return parsed
}

function parseStringArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index < 0) {
    return undefined
  }
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    return undefined
  }
  return value
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function summarize(values: number[]): TimingSummary {
  if (values.length === 0) {
    return { count: 0, mean: 0, p50: 0, p95: 0, min: 0, max: 0 }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const count = sorted.length
  const mean = sorted.reduce((sum, value) => sum + value, 0) / count
  const p50 = percentile(sorted, 0.5)
  const p95 = percentile(sorted, 0.95)

  return {
    count,
    mean: Number(mean.toFixed(2)),
    p50: Number(p50.toFixed(2)),
    p95: Number(p95.toFixed(2)),
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[count - 1].toFixed(2))
  }
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0
  }
  if (sortedValues.length === 1) {
    return sortedValues[0]
  }
  const position = (sortedValues.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) {
    return sortedValues[lower]
  }
  const weight = position - lower
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight
}

function collectCollectionStats(engine: MemoryEngine, collections: string[]): Record<string, { documents: number; sections: number; chunks: number; nodes: number; keywords: number }> {
  const result: Record<string, { documents: number; sections: number; chunks: number; nodes: number; keywords: number }> = {}

  for (const collectionId of collections) {
    result[collectionId] = engine.getCollectionStats(collectionId)
  }

  return result
}

function evaluateDataset(
  discoveredCollections: string[],
  stats: Record<string, { documents: number; sections: number; chunks: number; nodes: number; keywords: number }>
): { pass: boolean; missingExpectedCollections: string[]; invalidCollections: string[] } {
  const missingExpectedCollections = EXPECTED_COLLECTIONS.filter((expected) => !discoveredCollections.includes(expected))
  const invalidCollections = EXPECTED_COLLECTIONS.filter((collectionId) => {
    const value = stats[collectionId]
    if (!value) {
      return true
    }
    return value.documents < 1 || value.chunks < 1
  })

  return {
    pass: missingExpectedCollections.length === 0 && invalidCollections.length === 0,
    missingExpectedCollections,
    invalidCollections
  }
}

function compareStatsRoundtrip(
  source: Record<string, { documents: number; sections: number; chunks: number; nodes: number; keywords: number }>,
  restored: Record<string, { documents: number; sections: number; chunks: number; nodes: number; keywords: number }>
): { pass: boolean; mismatches: Array<{ collectionId: string; source: unknown; restored: unknown }> } {
  const mismatches: Array<{ collectionId: string; source: unknown; restored: unknown }> = []
  const allCollections = Array.from(new Set([...Object.keys(source), ...Object.keys(restored)])).sort((a, b) => a.localeCompare(b))

  for (const collectionId of allCollections) {
    const left = source[collectionId]
    const right = restored[collectionId]
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      mismatches.push({
        collectionId,
        source: left,
        restored: right
      })
    }
  }

  return {
    pass: mismatches.length === 0,
    mismatches
  }
}

async function collectMarkdownFiles(rootPath: string): Promise<string[]> {
  const results: string[] = []
  await walkMarkdown(rootPath, results)
  return results
}

async function walkMarkdown(currentPath: string, results: string[]): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name)
    if (entry.isDirectory()) {
      await walkMarkdown(fullPath, results)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(fullPath)
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
