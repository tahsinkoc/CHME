# CHME MemoryEngine Complete Usage Guide

This document is the complete usage guide for CHME MemoryEngine.

Goals:

1. Use the tool through a single entry point (`MemoryEngine`)
2. Automatically split documents into collections
3. Run retrieval + prompt + LLM answer flow
4. Save snapshots for fast startup

## 1) What is this tool for?

CHME is a "memory orchestration" layer.

You are not forced to build a RAG system, but RAG/chatbot/informal bot systems can integrate it easily.
It handles the following for you:

1. Markdown ingestion
2. Tree construction (document root -> section -> chunk)
3. Keyword indexing
4. Collection routing
5. Retrieval
6. Context prompt generation
7. LLM call

## 2) Data model and tree structure

Inside a collection:

1. Rooted hierarchical tree
2. Parent/children links (adjacency-list style)

Across the whole engine:

1. Multiple collections
2. A forest (set of collection trees)

Node ID schema:

1. Root: `{docId}:root`
2. Section: `{docId}:section:{sectionIndex}`
3. Chunk: `{docId}:{sectionIndex}:{chunkIndex}`

## 3) Setup

Requirements:

1. Node.js 18+
2. `ts-node` for running TypeScript

Available scripts in this repo:

```bash
npm run verify
npm run pipeline
npm run test:ollama:dry
npm run test:ollama
```

## 4) MemoryEngine public API summary

### Constructor

```ts
new MemoryEngine({
  model?: string
  topK?: number
  maxContextChars?: number
  temperature?: number
  maxTokens?: number
  provider?: 'local' | 'openai'
  localUrl?: string
  openAIBaseUrl?: string
  openAIApiKey?: string
})
```

### Collection/ingest

```ts
createCollection(id: string): Collection
getCollection(id: string): Collection | undefined
ingest(collectionId: string, path: string): Promise<void>
ingestAuto(rootPath: string, options?: IngestAutoOptions): Promise<IngestAutoReport>
getCollectionStats(collectionId: string): CollectionStats
```

### Routing/query/prompt

```ts
setRoutingRules(rules: RoutingRule[]): void
getRoutingReport(): RoutingReport
routeCollections(question: string, options?: RouteOptions): Promise<string[]>
retrieve(collectionId: string, question: string, topK?: number): Promise<Node[]>
buildPrompt(collectionId: string, question: string, topK?: number, maxContextChars?: number): Promise<string>
```

### Ask overload

```ts
ask(collectionId: string, question: string): Promise<string> // scoped
ask(question: string, options?: AskGlobalOptions): Promise<string> // global
```

### Snapshot

```ts
saveSnapshots(snapshotDir: string): Promise<SnapshotSaveReport>
loadSnapshots(snapshotDir: string, options?: SnapshotLoadOptions): Promise<SnapshotLoadReport>
```

### Runtime settings

```ts
setModel(model: string): void
setTopK(topK: number): void
setMaxContextChars(chars: number): void
setTemperature(temp: number): void
setMaxTokens(maxTokens: number): void
setProvider(provider: 'local' | 'openai'): void
setLocalUrl(url: string): void
setOpenAIBaseUrl(url: string): void
setOpenAIApiKey(apiKey: string): void
```

## 5) Fastest start (global ask)

```ts
import { MemoryEngine } from './src/MemoryEngine'

async function main() {
  const engine = new MemoryEngine({
    provider: 'local',
    localUrl: 'http://localhost:11434/api/generate',
    model: 'qwen2.5:7b',
    temperature: 0
  })

  // Auto-split markdown files under test/ into collections and ingest
  const report = await engine.ingestAuto('./test', { defaultCollectionId: 'general' })
  console.log('Ingest files:', report.files)
  console.log('Collections:', [...new Set(report.assignments.map((a) => a.collectionId))])

  // Ask globally without passing a collection id
  const answer = await engine.ask('What is the main topic of the files?', {
    topCollections: 3,
    topKPerCollection: 3,
    maxContextChars: 2000
  })

  console.log(answer)
}

main().catch(console.error)
```

## 6) Scoped ask (specific collection)

```ts
import { MemoryEngine } from './src/MemoryEngine'

async function main() {
  const engine = new MemoryEngine({ provider: 'local', model: 'qwen2.5:7b' })

  engine.createCollection('product_docs')
  await engine.ingest('product_docs', './docs/product')

  const answer = await engine.ask('product_docs', 'How does ingestion work?')
  console.log(answer)
}
```

## 7) Routing rules (deterministic collection assignment)

```ts
import { MemoryEngine } from './src/MemoryEngine'

async function main() {
  const engine = new MemoryEngine()

  engine.setRoutingRules([
    { pattern: /faq/i, collectionId: 'faq', priority: 10 },
    { pattern: /release/i, collectionId: 'release_notes', priority: 5 },
    { pattern: /^ops\//, collectionId: 'operations', priority: 8 }
  ])

  const report = await engine.ingestAuto('./knowledge', { defaultCollectionId: 'general' })
  console.log(report.assignments)
}
```

Routing priority:

1. Rule match (higher priority first)
2. Path-based slug (first folder)
3. Default collection

## 8) Snapshot persistence (recommended production flow)

Snapshot files:

1. `snapshots/_engine.chme.json.gz`
2. `snapshots/<collectionId>.chme.json.gz`

### Save snapshot

```ts
const saveReport = await engine.saveSnapshots('./snapshots')
console.log(saveReport)
```

### Load snapshot

```ts
const loadReport = await engine.loadSnapshots('./snapshots', {
  sourceRootPath: './knowledge'
})
console.log(loadReport)
```

`loadSnapshots` behavior:

1. Replaces existing in-memory state
2. Loads snapshot collections
3. Runs freshness check if `sourceRootPath` is provided (mtime + size)
4. Re-ingests only changed (stale) collections

## 9) Warm startup (load-if-fresh) example

```ts
import { existsSync } from 'node:fs'
import { MemoryEngine } from './src/MemoryEngine'

async function bootstrap() {
  const sourceRoot = './knowledge'
  const snapshotDir = './snapshots'

  const engine = new MemoryEngine({
    provider: 'local',
    localUrl: 'http://localhost:11434/api/generate',
    model: 'qwen2.5:7b',
    temperature: 0
  })

  if (existsSync(`${snapshotDir}/_engine.chme.json.gz`)) {
    await engine.loadSnapshots(snapshotDir, { sourceRootPath: sourceRoot })
  } else {
    await engine.ingestAuto(sourceRoot, { defaultCollectionId: 'general' })
    await engine.saveSnapshots(snapshotDir)
  }

  return engine
}
```

## 10) Retrieval and prompt debug

```ts
const collections = await engine.routeCollections('How does keyword retrieval work?', { topCollections: 3 })
console.log('Routed:', collections)

const chunks = await engine.retrieve(collections[0], 'How does keyword retrieval work?', 5)
console.log(chunks.map((c) => c.id))

const prompt = await engine.buildPrompt(collections[0], 'How does keyword retrieval work?', 5, 1200)
console.log(prompt)
```

## 11) When to use global vs scoped ask

Use global ask when:

1. The user does not know the right collection
2. You have a multi-domain knowledge base
3. You want Top-N collection routing

Use scoped ask when:

1. The question belongs to one known domain
2. You want tighter retrieval control
3. Your UI already selects a collection

## 12) LLM provider notes

Defaults:

1. Provider: `local`
2. Model: `qwen2.5:7b` (at call layer)

Ollama local endpoint:

```txt
http://localhost:11434/api/generate
```

Switch to OpenAI:

```ts
engine.setProvider('openai')
engine.setOpenAIBaseUrl('https://api.openai.com/v1')
engine.setOpenAIApiKey(process.env.OPENAI_API_KEY || '')
engine.setModel('gpt-4')
```

Note:

`callLLM` can return `''` on errors or unreachable endpoints.
Tests rely on this behavior intentionally.

## 13) Developer experience assessment

Strengths:

1. Single entrypoint (`MemoryEngine`)
2. Additive API evolution (existing flow preserved)
3. Deterministic routing/retrieval
4. Fast startup via snapshots
5. Dry + live test scenarios ready

Things to watch:

1. Retrieval is keyword-based (no embeddings/semantic layer yet)
2. For deep tree traversal, low-level `Collection` access may still be needed in advanced cases
3. Very large corpora may need future optimization for global query/context merge

## 14) Test and validation commands

```bash
# Unit + integration checks (including snapshot flow)
npm run verify

# Dry-run without Ollama
npm run test:ollama:dry

# Live Ollama test (qwen2.5:7b)
npm run test:ollama

# Basic pipeline smoke run
npm run pipeline
```

## 15) FAQ

### Is this tool only for RAG?

No. It is a memory orchestration layer. It can be used in RAG systems, but it is not limited to RAG.

### Why auto collection routing?

Because selecting the right collection first improves quality and cost in large document pools.

### Why snapshots?

To avoid full re-ingestion on every startup. This is critical for large corpora.

### What is the name of this tree structure?

Inside a collection: rooted hierarchical tree.
Across the engine: forest.
Representation style: adjacency-list.

---

Keep this file updated as public API behavior evolves.
