import assert from 'node:assert/strict'
import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { MemoryEngine } from '../src/MemoryEngine'
import { query } from '../src/query'
import { generateAnswer } from '../src/generateAnswer'
import { Node } from '../src/Collection'

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

  process.env.LLM_PROVIDER = 'local'
  process.env.LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || 'http://localhost:11434/api/generate'

  const markdownFiles = (await readdir(testDir)).filter((name) => name.toLowerCase().endsWith('.md'))
  assert.ok(markdownFiles.length >= 5, 'test/ klasorunde en az 5 markdown dosyasi olmali')

  const engine = new MemoryEngine({
    model: 'qwen2.5:7b',
    topK: 5,
    maxContextChars: 2000,
    temperature: 0
  })

  const collectionId = 'ollamaDetailedTestCollection'
  engine.createCollection(collectionId)
  await engine.ingest(collectionId, testDir)

  const collection = engine.getCollection(collectionId)
  assert.ok(collection, 'Collection olusturulamadi')

  const stats = summarizeTree(Array.from(collection.getAllNodes().values()))
  assert.ok(stats.documents >= 5, 'Dokuman root sayisi 5 veya uzeri olmali')
  assert.ok(stats.sections > 0, 'Section node bulunamadi')
  assert.ok(stats.chunks > 0, 'Chunk node bulunamadi')
  assert.ok(collection.getKeywordIndex().size > 0, 'Keyword index bos olmamali')

  console.log('=== Detailed Memory Tool Test (Ollama: qwen2.5:7b) ===')
  console.log(`Docs: ${stats.documents} | Sections: ${stats.sections} | Chunks: ${stats.chunks} | Keywords: ${collection.getKeywordIndex().size}`)
  console.log(`LLM Provider: ${process.env.LLM_PROVIDER}`)
  console.log(`LLM URL: ${process.env.LOCAL_LLM_URL}`)
  console.log(`Model: qwen2.5:7b`)
  console.log(`Mode: ${dryRun ? 'DRY-RUN (LLM call skipped)' : 'LIVE (real Ollama call)'}`)

  for (const scenario of SCENARIOS) {
    console.log('\n--- Scenario:', scenario.name, '---')
    console.log('Question:', scenario.question)

    const retrieved = await query(collection, scenario.question, 5)
    assert.ok(retrieved.length > 0, `Retrieval sonuc donmedi: ${scenario.name}`)

    console.log('Retrieved chunks:')
    for (const chunk of retrieved) {
      console.log(`- ${chunk.id} (parent=${chunk.parent})`)
    }

    const prompt = await generateAnswer(collection, scenario.question, 5, 2000)
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

function summarizeTree(nodes: Node[]): { documents: number; sections: number; chunks: number } {
  let documents = 0
  let sections = 0
  let chunks = 0

  for (const node of nodes) {
    if (node.depth === 0) {
      documents += 1
    } else if (node.depth === 1) {
      sections += 1
    } else if (node.depth === 2) {
      chunks += 1
    }
  }

  return { documents, sections, chunks }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
