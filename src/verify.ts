import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { MemoryEngine } from './MemoryEngine'

const TEST_DIR = path.resolve(process.cwd(), 'test')

async function run(): Promise<void> {
  await testIngestAutoAndStats()
  await testRoutingDeterminism()
  await testRoutingRulePriority()
  await testRouteCollectionsDeterminism()
  await testSnapshotRoundtripAndReplaceLoad()
  await testSnapshotFreshnessReingest()
  await testAskOverloadsAndProviderFallbacks()
  console.log('All tests passed')
}

async function testIngestAutoAndStats(): Promise<void> {
  const engine = createEngine()
  const report = await engine.ingestAuto(TEST_DIR, { defaultCollectionId: 'general' })

  assert.ok(report.files >= 5)
  assert.equal(report.assignments.length, report.files)

  const uniqueCollections = Array.from(new Set(report.assignments.map((a) => a.collectionId)))
  assert.ok(uniqueCollections.length >= 1)

  for (const collectionId of uniqueCollections) {
    const stats = engine.getCollectionStats(collectionId)
    assert.ok(stats.documents >= 1)
    assert.ok(stats.sections >= 1)
    assert.ok(stats.chunks >= 1)
    assert.ok(stats.keywords >= 1)
  }

  const routingReport = engine.getRoutingReport()
  assert.equal(routingReport.lastIngestAssignments.length, report.assignments.length)
}

async function testRoutingDeterminism(): Promise<void> {
  const engineA = createEngine()
  const engineB = createEngine()

  const reportA = await engineA.ingestAuto(TEST_DIR, { defaultCollectionId: 'general' })
  const reportB = await engineB.ingestAuto(TEST_DIR, { defaultCollectionId: 'general' })

  assert.deepEqual(reportA.assignments, reportB.assignments)
}

async function testRoutingRulePriority(): Promise<void> {
  const engine = createEngine()
  engine.setRoutingRules([
    { pattern: /faq/i, collectionId: 'low_priority', priority: 1 },
    { pattern: /faq/i, collectionId: 'high_priority', priority: 10 }
  ])

  const report = await engine.ingestAuto(TEST_DIR, { defaultCollectionId: 'general' })
  const faqAssignment = report.assignments.find((a) => /faq/i.test(a.file))

  assert.ok(faqAssignment)
  assert.equal(faqAssignment?.collectionId, 'high_priority')
}

async function testRouteCollectionsDeterminism(): Promise<void> {
  const engine = createEngine()
  await engine.ingestAuto(TEST_DIR, { defaultCollectionId: 'general' })

  const result1 = await engine.routeCollections('memory engine retrieval', { topCollections: 3 })
  const result2 = await engine.routeCollections('memory engine retrieval', { topCollections: 3 })

  assert.deepEqual(result1, result2)
  assert.ok(result1.length >= 1)
}

async function testSnapshotRoundtripAndReplaceLoad(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'chme-snapshot-roundtrip-'))

  try {
    const snapshotDir = path.join(tempRoot, 'snapshots')

    const sourceEngine = createEngine()
    const ingestReport = await sourceEngine.ingestAuto(TEST_DIR, { defaultCollectionId: 'general' })
    const saveReport = await sourceEngine.saveSnapshots(snapshotDir)

    assert.ok(saveReport.collections >= 1)
    assert.ok(saveReport.files >= 2)

    const restoredEngine = createEngine()
    restoredEngine.createCollection('temporary_collection')

    const loadReport = await restoredEngine.loadSnapshots(snapshotDir)

    assert.equal(restoredEngine.getCollection('temporary_collection'), undefined)

    const collectionIds = Array.from(new Set(ingestReport.assignments.map((a) => a.collectionId))).sort((a, b) => a.localeCompare(b))
    assert.equal(loadReport.collectionsLoaded, collectionIds.length)

    for (const collectionId of collectionIds) {
      assert.deepEqual(
        sourceEngine.getCollectionStats(collectionId),
        restoredEngine.getCollectionStats(collectionId)
      )
    }

    const routeA = await sourceEngine.routeCollections('memory engine retrieval', { topCollections: 3 })
    const routeB = await restoredEngine.routeCollections('memory engine retrieval', { topCollections: 3 })
    assert.deepEqual(routeA, routeB)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function testSnapshotFreshnessReingest(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'chme-snapshot-freshness-'))

  try {
    const dataRoot = path.join(tempRoot, 'data')
    const alphaDir = path.join(dataRoot, 'alpha')
    const betaDir = path.join(dataRoot, 'beta')
    const snapshotDir = path.join(tempRoot, 'snapshots')

    await mkdir(alphaDir, { recursive: true })
    await mkdir(betaDir, { recursive: true })

    const alphaSource = await readFile(path.join(TEST_DIR, '01-overview.md'), 'utf8')
    const betaSource = await readFile(path.join(TEST_DIR, '05-faq.md'), 'utf8')

    await writeFile(path.join(alphaDir, 'a.md'), alphaSource)
    await writeFile(path.join(betaDir, 'b.md'), betaSource)

    const sourceEngine = createEngine()
    await sourceEngine.ingestAuto(dataRoot, { defaultCollectionId: 'general' })
    await sourceEngine.saveSnapshots(snapshotDir)

    await writeFile(path.join(alphaDir, 'a.md'), `${alphaSource}\nFreshness update marker.`)

    const restoredEngine = createEngine()
    const loadReport = await restoredEngine.loadSnapshots(snapshotDir, { sourceRootPath: dataRoot })

    assert.ok(loadReport.filesChecked >= 2)
    assert.ok(loadReport.staleCollectionsReingested.includes('alpha'))

    const alphaStats = restoredEngine.getCollectionStats('alpha')
    assert.ok(alphaStats.documents >= 1)
    assert.ok(alphaStats.chunks >= 1)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function testAskOverloadsAndProviderFallbacks(): Promise<void> {
  const engine = createEngine()
  const report = await engine.ingestAuto(TEST_DIR, { defaultCollectionId: 'general' })

  const firstCollection = report.assignments[0]?.collectionId
  assert.ok(firstCollection)

  const globalAnswer = await engine.ask('What is the main topic of the files?', {
    topCollections: 3,
    topKPerCollection: 3,
    maxContextChars: 1500
  })
  assert.equal(globalAnswer, '')

  const scopedAnswer = await engine.ask(firstCollection as string, 'What is the main topic of the files?')
  assert.equal(scopedAnswer, '')

  engine.setProvider('openai')
  engine.setOpenAIBaseUrl('http://127.0.0.1:1/v1')

  const openaiAnswer = await engine.ask('What is the main topic of the files?', {
    topCollections: 2,
    topKPerCollection: 2,
    maxContextChars: 1000
  })
  assert.equal(openaiAnswer, '')
}

function createEngine(): MemoryEngine {
  return new MemoryEngine({
    model: 'qwen2.5:7b',
    provider: 'local',
    localUrl: 'http://127.0.0.1:1/api/generate',
    temperature: 0,
    topK: 5,
    maxContextChars: 2000
  })
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
