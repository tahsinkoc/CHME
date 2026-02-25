import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { MemoryEngine } from '../src/MemoryEngine'

type CollectionId = 'compliance' | 'payments' | 'risk'

type GoldenQuery = {
  id: string
  question: string
  expectedPrimaryCollection: CollectionId
  acceptedCollections: CollectionId[]
  evidenceDocPrefixes: string[]
  requiredEvidenceKeywords: string[]
  expectedAnswerKeywords: string[]
}

type GoldenFile = {
  queries: GoldenQuery[]
}

type CollectionStats = {
  documents: number
  sections: number
  chunks: number
  nodes: number
  keywords: number
}

type TimingSummary = {
  count: number
  mean: number
  p50: number
  p95: number
  min: number
  max: number
}

type QueryAccumulator = {
  id: string
  question: string
  expectedPrimaryCollection: CollectionId
  acceptedCollections: CollectionId[]
  evidenceDocPrefixes: string[]
  requiredEvidenceKeywords: string[]
  expectedAnswerKeywords: string[]
  runs: number
  firstRoute: string[]
  firstRetrievedNodeIds: string[]
  routeTop1Hits: number
  routeRecallHits: number
  hitAtKHits: number
  mrrSum: number
  evidencePrecisionSum: number
  evidenceRecallSum: number
  requiredEvidenceCoverageSum: number
  askRuns: number
  emptyAnswers: number
  answerCharsTotal: number
  keywordCoverageSum: number
  groundingRatioSum: number
  factualScoreSum: number
}

const DEFAULT_ITERATIONS = 2
const DEFAULT_TOP_K = 5
const DEFAULT_TOP_COLLECTIONS = 3
const DEFAULT_TOP_K_PER_COLLECTION = 3
const DEFAULT_MAX_CONTEXT_CHARS = 2000
const DEFAULT_MODEL = 'qwen2.5:7b'
const DEFAULT_DATA_ROOT = path.resolve(process.cwd(), 'benchmark/data')
const DEFAULT_GOLDEN_PATH = path.resolve(process.cwd(), 'benchmark/factual_golden.json')
const DEFAULT_SNAPSHOT_DIR = path.resolve(process.cwd(), 'benchmark/snapshots_factual')
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), 'benchmark/results/factual_latest.json')

const THRESHOLDS = {
  routeRecallAtN: 0.95,
  hitAtK: 0.85,
  mrrAtK: 0.60,
  meanFactualScore: 0.60
}

async function main(): Promise<void> {
  const startedAt = new Date()
  const runId = startedAt.toISOString().replace(/[:.]/g, '-')

  const iterations = parsePositiveIntArg('--iterations', DEFAULT_ITERATIONS)
  const topK = parsePositiveIntArg('--top-k', DEFAULT_TOP_K)
  const topCollections = parsePositiveIntArg('--top-collections', DEFAULT_TOP_COLLECTIONS)
  const topKPerCollection = parsePositiveIntArg('--top-k-per-collection', DEFAULT_TOP_K_PER_COLLECTION)
  const liveLlmGrading = hasFlag('--live-llm-grading')
  const dataRoot = path.resolve(parseStringArg('--data-root') ?? DEFAULT_DATA_ROOT)
  const goldenPath = path.resolve(parseStringArg('--golden') ?? DEFAULT_GOLDEN_PATH)
  const snapshotDir = path.resolve(parseStringArg('--snapshot-dir') ?? DEFAULT_SNAPSHOT_DIR)
  const outputPath = path.resolve(parseStringArg('--output') ?? DEFAULT_OUTPUT_PATH)
  const provider = normalizeProvider(process.env.LLM_PROVIDER)
  const model = process.env.BENCHMARK_MODEL || DEFAULT_MODEL

  const golden = await loadGolden(goldenPath)
  const expectedCollections = buildExpectedCollections(golden.queries)

  const sourceFiles = await collectMarkdownFiles(dataRoot)
  sourceFiles.sort((a, b) => a.localeCompare(b))
  assert.ok(sourceFiles.length >= 15, `Benchmark dataset should contain at least 15 markdown files: ${sourceFiles.length}`)

  const seedEngine = new MemoryEngine({
    model,
    provider,
    topK,
    maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    temperature: 0,
    snapshotDir,
    localUrl: process.env.LOCAL_LLM_URL,
    openAIBaseUrl: process.env.OPENAI_BASE_URL,
    openAIApiKey: process.env.OPENAI_API_KEY
  })

  const ingestStarted = performance.now()
  const ingestReport = await seedEngine.ingestAuto(dataRoot, { defaultCollectionId: 'general' })
  const ingestDurationMs = performance.now() - ingestStarted

  const discoveredCollections = Array.from(new Set(ingestReport.assignments.map((item) => item.collectionId))).sort((a, b) => a.localeCompare(b))
  const sourceStats = collectCollectionStats(seedEngine, discoveredCollections)
  const datasetChecks = evaluateDataset(expectedCollections, sourceStats)

  const saveStarted = performance.now()
  const saveReport = await seedEngine.saveSnapshots()
  const saveDurationMs = performance.now() - saveStarted

  const evalEngine = new MemoryEngine({
    model,
    provider,
    topK,
    maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    temperature: 0,
    snapshotDir,
    localUrl: process.env.LOCAL_LLM_URL,
    openAIBaseUrl: process.env.OPENAI_BASE_URL,
    openAIApiKey: process.env.OPENAI_API_KEY
  })

  const loadStarted = performance.now()
  const loadReport = await evalEngine.loadSnapshots(undefined, { sourceRootPath: dataRoot })
  const loadDurationMs = performance.now() - loadStarted

  const restoredStats = collectCollectionStats(evalEngine, discoveredCollections)
  const roundtrip = compareStatsRoundtrip(sourceStats, restoredStats)

  const routeLatencies: number[] = []
  const retrieveLatencies: number[] = []
  const askLatencies: number[] = []

  const accumulators = new Map<string, QueryAccumulator>()
  for (const query of golden.queries) {
    accumulators.set(query.id, {
      id: query.id,
      question: query.question,
      expectedPrimaryCollection: query.expectedPrimaryCollection,
      acceptedCollections: [...query.acceptedCollections],
      evidenceDocPrefixes: [...query.evidenceDocPrefixes],
      requiredEvidenceKeywords: [...query.requiredEvidenceKeywords],
      expectedAnswerKeywords: [...query.expectedAnswerKeywords],
      runs: 0,
      firstRoute: [],
      firstRetrievedNodeIds: [],
      routeTop1Hits: 0,
      routeRecallHits: 0,
      hitAtKHits: 0,
      mrrSum: 0,
      evidencePrecisionSum: 0,
      evidenceRecallSum: 0,
      requiredEvidenceCoverageSum: 0,
      askRuns: 0,
      emptyAnswers: 0,
      answerCharsTotal: 0,
      keywordCoverageSum: 0,
      groundingRatioSum: 0,
      factualScoreSum: 0
    })
  }

  let totalExecutions = 0

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const query of golden.queries) {
      const acc = accumulators.get(query.id)
      if (!acc) {
        continue
      }

      totalExecutions += 1
      acc.runs += 1

      const routeStarted = performance.now()
      const routed = await evalEngine.routeCollections(query.question, { topCollections })
      const routeMs = performance.now() - routeStarted
      routeLatencies.push(routeMs)

      if (acc.firstRoute.length === 0) {
        acc.firstRoute = [...routed]
      }

      const top1 = routed[0] || ''
      if (query.acceptedCollections.includes(top1 as CollectionId)) {
        acc.routeTop1Hits += 1
      }

      if (routed.some((collectionId) => query.acceptedCollections.includes(collectionId as CollectionId))) {
        acc.routeRecallHits += 1
      }

      const retrieveStarted = performance.now()
      const combined = await retrieveAcrossCollections(evalEngine, routed, query.question, topCollections, topKPerCollection)
      const retrieveMs = performance.now() - retrieveStarted
      retrieveLatencies.push(retrieveMs)

      const topNodes = dedupeNodes(combined).slice(0, topK)
      if (acc.firstRetrievedNodeIds.length === 0) {
        acc.firstRetrievedNodeIds = topNodes.map((node) => node.id)
      }

      const evidenceSet = new Set(query.evidenceDocPrefixes)
      const retrievedDocPrefixes = topNodes.map((node) => extractDocPrefix(node.id))
      const relevantPositions: number[] = []
      const relevantRetrievedPrefixes = new Set<string>()

      for (let idx = 0; idx < retrievedDocPrefixes.length; idx++) {
        const prefix = retrievedDocPrefixes[idx]
        if (evidenceSet.has(prefix)) {
          relevantPositions.push(idx + 1)
          relevantRetrievedPrefixes.add(prefix)
        }
      }

      const hit = relevantPositions.length > 0 ? 1 : 0
      const rr = relevantPositions.length > 0 ? 1 / relevantPositions[0] : 0
      const precisionAtK = relevantPositions.length / topK
      const recall = evidenceSet.size > 0 ? relevantRetrievedPrefixes.size / evidenceSet.size : 1

      acc.hitAtKHits += hit
      acc.mrrSum += rr
      acc.evidencePrecisionSum += precisionAtK
      acc.evidenceRecallSum += recall

      const contextText = topNodes.map((node) => node.text).join('\n')
      const contextTokens = tokenizeToSet(contextText)
      const requiredMatches = countTokenMatches(contextTokens, query.requiredEvidenceKeywords)
      const requiredCoverage = query.requiredEvidenceKeywords.length > 0
        ? requiredMatches / query.requiredEvidenceKeywords.length
        : 1
      acc.requiredEvidenceCoverageSum += requiredCoverage

      if (liveLlmGrading) {
        const askStarted = performance.now()
        const answer = await evalEngine.ask(query.question, {
          topCollections,
          topKPerCollection,
          maxContextChars: DEFAULT_MAX_CONTEXT_CHARS
        })
        const askMs = performance.now() - askStarted
        askLatencies.push(askMs)

        const answerTrimmed = answer.trim()
        const answerTokens = tokenizeToSet(answerTrimmed)
        const keywordMatches = countTokenMatches(answerTokens, query.expectedAnswerKeywords)
        const keywordCoverage = query.expectedAnswerKeywords.length > 0
          ? keywordMatches / query.expectedAnswerKeywords.length
          : 1

        let groundingRatio = 0
        if (answerTokens.size > 0) {
          let overlap = 0
          for (const token of answerTokens) {
            if (contextTokens.has(token)) {
              overlap += 1
            }
          }
          groundingRatio = overlap / answerTokens.size
        }

        const factualScore = 0.5 * keywordCoverage + 0.5 * groundingRatio

        acc.askRuns += 1
        acc.answerCharsTotal += answerTrimmed.length
        acc.keywordCoverageSum += keywordCoverage
        acc.groundingRatioSum += groundingRatio
        acc.factualScoreSum += factualScore
        if (answerTrimmed.length === 0) {
          acc.emptyAnswers += 1
        }
      }
    }
  }

  const queryReports = golden.queries.map((query) => {
    const acc = accumulators.get(query.id)
    if (!acc) {
      return null
    }

    const routeTop1Accuracy = safeDiv(acc.routeTop1Hits, acc.runs)
    const routeRecallAtN = safeDiv(acc.routeRecallHits, acc.runs)
    const hitAtK = safeDiv(acc.hitAtKHits, acc.runs)
    const mrrAtK = safeDiv(acc.mrrSum, acc.runs)
    const evidencePrecisionAtK = safeDiv(acc.evidencePrecisionSum, acc.runs)
    const evidenceRecall = safeDiv(acc.evidenceRecallSum, acc.runs)
    const requiredEvidenceCoverage = safeDiv(acc.requiredEvidenceCoverageSum, acc.runs)

    const meanFactualScore = safeDiv(acc.factualScoreSum, acc.askRuns)
    const meanKeywordCoverage = safeDiv(acc.keywordCoverageSum, acc.askRuns)
    const meanGroundingRatio = safeDiv(acc.groundingRatioSum, acc.askRuns)
    const avgAnswerChars = safeDiv(acc.answerCharsTotal, acc.askRuns)

    return {
      id: acc.id,
      question: acc.question,
      expectedPrimaryCollection: acc.expectedPrimaryCollection,
      acceptedCollections: acc.acceptedCollections,
      evidenceDocPrefixes: acc.evidenceDocPrefixes,
      firstRoute: acc.firstRoute,
      firstRetrievedNodeIds: acc.firstRetrievedNodeIds,
      relevance: {
        routeTop1Accuracy: round4(routeTop1Accuracy),
        routeRecallAtN: round4(routeRecallAtN),
        hitAtK: round4(hitAtK),
        mrrAtK: round4(mrrAtK),
        evidencePrecisionAtK: round4(evidencePrecisionAtK),
        evidenceRecall: round4(evidenceRecall),
        requiredEvidenceCoverage: round4(requiredEvidenceCoverage)
      },
      factuality: {
        enabled: liveLlmGrading,
        askRuns: acc.askRuns,
        emptyAnswers: acc.emptyAnswers,
        avgAnswerChars: round2(avgAnswerChars),
        meanKeywordCoverage: round4(meanKeywordCoverage),
        meanGroundingRatio: round4(meanGroundingRatio),
        meanFactualScore: round4(meanFactualScore)
      }
    }
  }).filter((item) => item !== null)

  const accumulatorValues = Array.from(accumulators.values())
  const routeTop1Hits = accumulatorValues.reduce((sum, acc) => sum + acc.routeTop1Hits, 0)
  const routeRecallHits = accumulatorValues.reduce((sum, acc) => sum + acc.routeRecallHits, 0)
  const hitAtKHits = accumulatorValues.reduce((sum, acc) => sum + acc.hitAtKHits, 0)
  const mrrSum = accumulatorValues.reduce((sum, acc) => sum + acc.mrrSum, 0)
  const precisionSum = accumulatorValues.reduce((sum, acc) => sum + acc.evidencePrecisionSum, 0)
  const recallSum = accumulatorValues.reduce((sum, acc) => sum + acc.evidenceRecallSum, 0)

  const relevance = {
    routeTop1Accuracy: round4(safeDiv(routeTop1Hits, totalExecutions)),
    routeRecallAtN: round4(safeDiv(routeRecallHits, totalExecutions)),
    hitAtK: round4(safeDiv(hitAtKHits, totalExecutions)),
    mrrAtK: round4(safeDiv(mrrSum, totalExecutions)),
    evidencePrecisionAtK: round4(safeDiv(precisionSum, totalExecutions)),
    evidenceRecall: round4(safeDiv(recallSum, totalExecutions))
  }

  const factualRuns = accumulatorValues.reduce((sum, acc) => sum + acc.askRuns, 0)
  const totalEmptyAnswers = accumulatorValues.reduce((sum, acc) => sum + acc.emptyAnswers, 0)
  const factualScoreSum = accumulatorValues.reduce((sum, acc) => sum + acc.factualScoreSum, 0)
  const keywordCoverageSum = accumulatorValues.reduce((sum, acc) => sum + acc.keywordCoverageSum, 0)
  const groundingRatioSum = accumulatorValues.reduce((sum, acc) => sum + acc.groundingRatioSum, 0)
  const factuality = {
    enabled: liveLlmGrading,
    meanFactualScore: liveLlmGrading
      ? round4(safeDiv(factualScoreSum, factualRuns))
      : null,
    meanKeywordCoverage: liveLlmGrading
      ? round4(safeDiv(keywordCoverageSum, factualRuns))
      : null,
    meanGroundingRatio: liveLlmGrading
      ? round4(safeDiv(groundingRatioSum, factualRuns))
      : null,
    emptyAnswers: liveLlmGrading ? totalEmptyAnswers : null
  }

  const snapshotPass = roundtrip.pass
  const relevancePass = relevance.routeRecallAtN >= THRESHOLDS.routeRecallAtN
    && relevance.hitAtK >= THRESHOLDS.hitAtK
    && relevance.mrrAtK >= THRESHOLDS.mrrAtK
  const factualPass = !liveLlmGrading || ((factuality.meanFactualScore || 0) >= THRESHOLDS.meanFactualScore)
  const overallPass = datasetChecks.pass && snapshotPass && relevancePass && factualPass

  const finishedAt = new Date()
  const report = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: round2(finishedAt.getTime() - startedAt.getTime()),
    config: {
      iterations,
      liveLlmGrading,
      model,
      provider,
      topK,
      topCollections,
      topKPerCollection,
      dataRoot,
      goldenPath,
      snapshotDir,
      outputPath
    },
    dataset: {
      files: sourceFiles.length,
      collectionsDiscovered: discoveredCollections,
      expectedCollections,
      checks: datasetChecks,
      stats: sourceStats
    },
    snapshot: {
      saveReport,
      loadReport,
      timingMs: {
        ingest: round2(ingestDurationMs),
        save: round2(saveDurationMs),
        load: round2(loadDurationMs)
      },
      roundtrip
    },
    relevance,
    factuality,
    latency: {
      routeMs: summarize(routeLatencies),
      retrieveMs: summarize(retrieveLatencies),
      askMs: summarize(askLatencies)
    },
    queries: queryReports,
    thresholds: {
      routeRecallAtN: THRESHOLDS.routeRecallAtN,
      hitAtK: THRESHOLDS.hitAtK,
      mrrAtK: THRESHOLDS.mrrAtK,
      meanFactualScore: THRESHOLDS.meanFactualScore,
      snapshotRoundtrip: true
    },
    overallPass
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log('=== CHME Factual Benchmark ===')
  console.log(`Run ID: ${runId}`)
  console.log(`Dataset files: ${sourceFiles.length}`)
  console.log(`Collections: ${discoveredCollections.join(', ')}`)
  console.log(`Iterations: ${iterations}`)
  console.log(`Live LLM grading: ${liveLlmGrading ? 'enabled' : 'disabled'}`)
  console.log(`Route recall@N: ${relevance.routeRecallAtN}`)
  console.log(`Hit@K: ${relevance.hitAtK}`)
  console.log(`MRR@K: ${relevance.mrrAtK}`)
  if (liveLlmGrading) {
    console.log(`Mean factual score: ${factuality.meanFactualScore}`)
    console.log(`Empty answers: ${factuality.emptyAnswers}`)
  }
  console.log(`Roundtrip pass: ${snapshotPass}`)
  console.log(`Overall pass: ${overallPass}`)
  console.log(`Report: ${outputPath}`)

  if (!overallPass) {
    process.exitCode = 1
  }
}

function normalizeProvider(value: string | undefined): 'local' | 'openai' {
  const normalized = (value || 'local').toLowerCase()
  return normalized === 'openai' ? 'openai' : 'local'
}

async function loadGolden(goldenPath: string): Promise<GoldenFile> {
  const raw = await readFile(goldenPath, 'utf8')
  const data = JSON.parse(raw) as GoldenFile
  if (!data || !Array.isArray(data.queries) || data.queries.length === 0) {
    throw new Error('Golden file must include a non-empty queries array')
  }

  const seen = new Set<string>()
  for (const query of data.queries) {
    if (!query.id || !query.question) {
      throw new Error('Each golden query must include id and question')
    }
    if (seen.has(query.id)) {
      throw new Error(`Duplicate golden query id: ${query.id}`)
    }
    seen.add(query.id)
    if (!Array.isArray(query.acceptedCollections) || query.acceptedCollections.length === 0) {
      throw new Error(`acceptedCollections must be non-empty: ${query.id}`)
    }
    if (!Array.isArray(query.evidenceDocPrefixes) || query.evidenceDocPrefixes.length === 0) {
      throw new Error(`evidenceDocPrefixes must be non-empty: ${query.id}`)
    }
  }

  return data
}

function buildExpectedCollections(queries: GoldenQuery[]): string[] {
  const set = new Set<string>()
  for (const query of queries) {
    set.add(query.expectedPrimaryCollection)
    for (const collectionId of query.acceptedCollections) {
      set.add(collectionId)
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b))
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

function extractDocPrefix(nodeId: string): string {
  return nodeId.split(':')[0]
}

function dedupeNodes(nodes: Array<{ id: string; text: string }>): Array<{ id: string; text: string }> {
  const seen = new Set<string>()
  const unique: Array<{ id: string; text: string }> = []
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue
    }
    seen.add(node.id)
    unique.push(node)
  }
  return unique
}

async function retrieveAcrossCollections(
  engine: MemoryEngine,
  routedCollections: string[],
  question: string,
  topCollections: number,
  topKPerCollection: number
): Promise<Array<{ id: string; text: string }>> {
  const combined: Array<{ id: string; text: string }> = []
  const selectedCollections = routedCollections.slice(0, topCollections)

  for (const collectionId of selectedCollections) {
    const nodes = await engine.retrieve(collectionId, question, topKPerCollection)
    for (const node of nodes) {
      combined.push({ id: node.id, text: node.text })
    }
  }

  return combined
}

function tokenizeToSet(input: string): Set<string> {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
  const parts = cleaned.split(/\s+/).filter((part) => part.length > 0)
  return new Set(parts)
}

function countTokenMatches(tokenSet: Set<string>, keywords: string[]): number {
  let count = 0
  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim()
    if (!normalized) {
      continue
    }
    const units = normalized.split(/\s+/).filter((part) => part.length > 0)
    if (units.length === 1) {
      if (tokenSet.has(units[0])) {
        count += 1
      }
      continue
    }

    let allPresent = true
    for (const unit of units) {
      if (!tokenSet.has(unit)) {
        allPresent = false
        break
      }
    }
    if (allPresent) {
      count += 1
    }
  }
  return count
}

function safeDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0
  }
  return numerator / denominator
}

function round4(value: number): number {
  return Number(value.toFixed(4))
}

function round2(value: number): number {
  return Number(value.toFixed(2))
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
    mean: round2(mean),
    p50: round2(p50),
    p95: round2(p95),
    min: round2(sorted[0]),
    max: round2(sorted[count - 1])
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

function collectCollectionStats(engine: MemoryEngine, collections: string[]): Record<string, CollectionStats> {
  const stats: Record<string, CollectionStats> = {}
  for (const collectionId of collections) {
    stats[collectionId] = engine.getCollectionStats(collectionId)
  }
  return stats
}

function evaluateDataset(expectedCollections: string[], stats: Record<string, CollectionStats>): { pass: boolean; missingExpectedCollections: string[]; invalidCollections: string[] } {
  const missingExpectedCollections = expectedCollections.filter((collectionId) => !stats[collectionId])
  const invalidCollections = expectedCollections.filter((collectionId) => {
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
  source: Record<string, CollectionStats>,
  restored: Record<string, CollectionStats>
): { pass: boolean; mismatches: Array<{ collectionId: string; source: unknown; restored: unknown }> } {
  const allCollections = Array.from(new Set([...Object.keys(source), ...Object.keys(restored)])).sort((a, b) => a.localeCompare(b))
  const mismatches: Array<{ collectionId: string; source: unknown; restored: unknown }> = []

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
