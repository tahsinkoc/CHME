import assert from 'node:assert/strict'
import path from 'node:path'
import { readdir } from 'node:fs/promises'
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

  const markdownFiles = (await readdir(testDir)).filter((name) => name.toLowerCase().endsWith('.md'))
  assert.ok(markdownFiles.length >= 5, 'test/ klasorunde en az 5 markdown dosyasi olmali')

  const engine = new MemoryEngine({
    model: 'qwen2.5:7b',
    topK: 5,
    maxContextChars: 2000,
    temperature: 0,
    provider: 'local',
    localUrl
  })

  const collectionId = 'ollamaDetailedTestCollection'
  engine.createCollection(collectionId)
  await engine.ingest(collectionId, testDir)

  const stats = engine.getCollectionStats(collectionId)
  assert.ok(stats.documents >= 5, 'Dokuman root sayisi 5 veya uzeri olmali')
  assert.ok(stats.sections > 0, 'Section node bulunamadi')
  assert.ok(stats.chunks > 0, 'Chunk node bulunamadi')
  assert.ok(stats.keywords > 0, 'Keyword index bos olmamali')

  console.log('=== Detailed Memory Tool Test (Ollama: qwen2.5:7b) ===')
  console.log(`Docs: ${stats.documents} | Sections: ${stats.sections} | Chunks: ${stats.chunks} | Keywords: ${stats.keywords}`)
  console.log('LLM Provider: local')
  console.log(`LLM URL: ${localUrl}`)
  console.log(`Model: qwen2.5:7b`)
  console.log(`Mode: ${dryRun ? 'DRY-RUN (LLM call skipped)' : 'LIVE (real Ollama call)'}`)

  for (const scenario of SCENARIOS) {
    console.log('\n--- Scenario:', scenario.name, '---')
    console.log('Question:', scenario.question)

    const retrieved = await engine.retrieve(collectionId, scenario.question, 5)
    assert.ok(retrieved.length > 0, `Retrieval sonuc donmedi: ${scenario.name}`)

    console.log('Retrieved chunks:')
    for (const chunk of retrieved) {
      console.log(`- ${chunk.id} (parent=${chunk.parent})`)
    }

    const prompt = await engine.buildPrompt(collectionId, scenario.question, 5, 2000)
    assert.ok(prompt.includes('CONTEXT:'), 'Prompt context bolumu eksik')
    assert.ok(prompt.includes('QUESTION:'), 'Prompt question bolumu eksik')
    console.log(`Prompt chars: ${prompt.length}`)

    if (dryRun) {
      continue
    }

    const started = Date.now()
    const answer = await engine.ask(collectionId, scenario.question)
    const elapsed = Date.now() - started

    assert.ok(answer.trim().length > 0, `LLM bos cevap dondu: ${scenario.name}`)
    console.log(`Answer time: ${elapsed}ms`)
    console.log(`Answer:\n${answer}`)
  }

  console.log('\nDetailed Ollama scenario test passed')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
