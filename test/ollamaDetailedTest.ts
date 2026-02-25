import assert from 'node:assert/strict'
import path from 'node:path'
import { MemoryEngine } from '../src/MemoryEngine'

type Scenario = {
  name: string
  question: string
}

const SCENARIOS: Scenario[] = [
  {
    name: 'System Scope',
    question: 'What is the main scope of this memory engine project?'
  },
  {
    name: 'Ingest Behavior',
    question: 'How does markdown ingestion and chunking work in this system?'
  },
  {
    name: 'Retrieval Logic',
    question: 'How does keyword-based retrieval and section-aware ranking work?'
  },
  {
    name: 'Operational Mode',
    question: 'What is the expected local model and runtime setup for answering?'
  }
]

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const testDir = path.resolve(process.cwd(), 'test')
  const localUrl = process.env.LOCAL_LLM_URL || 'http://localhost:11434/api/generate'

  const engine = new MemoryEngine({
    model: 'qwen2.5:7b',
    topK: 5,
    maxContextChars: 2000,
    temperature: 0,
    provider: 'local',
    localUrl
  })

  engine.setRoutingRules([
    { pattern: /^test\//, collectionId: 'manual_test_root', priority: -1 },
    { pattern: /faq/i, collectionId: 'knowledge_faq', priority: 10 }
  ])

  const ingestReport = await engine.ingestAuto(testDir, { defaultCollectionId: 'general' })
  assert.ok(ingestReport.files >= 5, 'En az 5 markdown dosyasi ingest edilmeli')
  assert.equal(ingestReport.assignments.length, ingestReport.files)

  const routingReport = engine.getRoutingReport()
  assert.equal(routingReport.lastIngestAssignments.length, ingestReport.assignments.length)

  const assignedCollections = Array.from(new Set(ingestReport.assignments.map((a) => a.collectionId))).sort((a, b) => a.localeCompare(b))
  assert.ok(assignedCollections.length >= 1, 'En az bir collection olusmali')

  const total = assignedCollections
    .map((id) => engine.getCollectionStats(id))
    .reduce(
      (acc, stats) => {
        acc.documents += stats.documents
        acc.sections += stats.sections
        acc.chunks += stats.chunks
        acc.keywords += stats.keywords
        return acc
      },
      { documents: 0, sections: 0, chunks: 0, keywords: 0 }
    )

  console.log('=== Detailed Memory Tool Test (Ollama: qwen2.5:7b) ===')
  console.log(`Files ingested: ${ingestReport.files}`)
  console.log(`Collections: ${assignedCollections.join(', ')}`)
  console.log(`Docs: ${total.documents} | Sections: ${total.sections} | Chunks: ${total.chunks} | Keywords: ${total.keywords}`)
  console.log('LLM Provider: local')
  console.log(`LLM URL: ${localUrl}`)
  console.log('Model: qwen2.5:7b')
  console.log(`Mode: ${dryRun ? 'DRY-RUN (LLM call skipped)' : 'LIVE (real Ollama call)'}`)

  for (const scenario of SCENARIOS) {
    console.log(`\n--- Scenario: ${scenario.name} ---`)
    console.log(`Question: ${scenario.question}`)

    const routed = await engine.routeCollections(scenario.question, { topCollections: 3 })
    assert.ok(routed.length > 0, `Collection route bulunamadi: ${scenario.name}`)
    console.log(`Routed collections: ${routed.join(', ')}`)

    const firstCollection = routed[0]
    const retrieved = await engine.retrieve(firstCollection, scenario.question, 3)
    assert.ok(retrieved.length > 0, `Retrieval sonuc donmedi: ${scenario.name}`)

    console.log(`Retrieved chunks from ${firstCollection}:`)
    for (const chunk of retrieved) {
      console.log(`- ${chunk.id} (parent=${chunk.parent})`)
    }

    const scopedPrompt = await engine.buildPrompt(firstCollection, scenario.question, 3, 1200)
    assert.ok(scopedPrompt.includes('CONTEXT:'), 'Scoped prompt context bolumu eksik')
    assert.ok(scopedPrompt.includes('QUESTION:'), 'Scoped prompt question bolumu eksik')
    console.log(`Scoped prompt chars: ${scopedPrompt.length}`)

    if (dryRun) {
      continue
    }

    const globalStart = Date.now()
    const globalAnswer = await engine.ask(scenario.question, {
      topCollections: 3,
      topKPerCollection: 3,
      maxContextChars: 2000
    })
    const globalElapsed = Date.now() - globalStart
    assert.ok(globalAnswer.trim().length > 0, `Global ask bos cevap dondu: ${scenario.name}`)
    console.log(`Global answer time: ${globalElapsed}ms`)
    console.log(`Global answer:\n${globalAnswer}`)

    const scopedStart = Date.now()
    const scopedAnswer = await engine.ask(firstCollection, scenario.question)
    const scopedElapsed = Date.now() - scopedStart
    assert.ok(scopedAnswer.trim().length > 0, `Scoped ask bos cevap dondu: ${scenario.name}`)
    console.log(`Scoped answer time: ${scopedElapsed}ms`)
  }

  console.log('\nDetailed Ollama scenario test passed')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
