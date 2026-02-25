import assert from 'node:assert/strict'
import path from 'node:path'
import { MemoryEngine } from './MemoryEngine'

const TEST_DIR = path.resolve(process.cwd(), 'test')

async function run(): Promise<void> {
  await testIngestAutoAndStats()
  await testRoutingDeterminism()
  await testRoutingRulePriority()
  await testRouteCollectionsDeterminism()
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
