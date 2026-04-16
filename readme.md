# Compact Hierarchical Memory Engine (CHME)

<p align="center">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"></a>
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/Version-1.0.0-blue?style=for-the-badge" alt="Version">
</p>

CHME is a **compact, in-memory, hierarchical memory orchestration engine** written in TypeScript. It provides a structured memory system for Large Language Models (LLM) and automatically extracts, indexes, and queries information from markdown-based documents.

By default, `ask()` is now **deterministic and evidence-grounded**, so you can use the engine without configuring any model endpoint. When you want free-form generation on top of the retrieved context, use `askWithLLM()`.

## Core Flow

```
1. ingest / ingestAuto     → Markdown to document/section/chunk tree
2. keyword index build      → Chunk-level indexing
3. scoped or global ask   → Query with automatic routing
4. optional snapshot save  → Fast restart with .chme.json.gz persistence
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Multi-Collection Support** | Manages multiple topic domains in isolated collections |
| **Auto-Routing** | Routes queries to correct collections via regex-based rules |
| **Hybrid Retrieval** | Combines lexical chunk search with embedding similarity for better recall |
| **Grounded Answers by Default** | `ask()` returns extractive, evidence-backed answers without requiring an LLM |
| **Local LLM Support** | Ollama integration for local inference |
| **Cloud LLM Support** | OpenAI-compatible APIs (Mistral, OpenAI, etc.) |
| **Snapshot Persistence** | Compressed state saving in `.chme.json.gz` format |
| **Deterministic Behavior** | Reproducible routing, retrieval, and prompt generation |

## Installation

```bash
npm install
```

## Quick Start

```typescript
import { MemoryEngine } from './src/MemoryEngine'

async function main() {
  const engine = new MemoryEngine({
    snapshotDir: './snapshots'
  })

  // Auto-ingest markdown files into collections
  await engine.ingestAuto('./test', { defaultCollectionId: 'general' })
  
  // Save snapshots for fast restart
  await engine.saveSnapshots()

  // Ask questions without specifying collection.
  // This path is grounded and does not require an LLM endpoint.
  const answer = await engine.ask('What is the main topic of the files?')
  console.log(answer)
}

main().catch(console.error)
```

## Supported Providers

### Hybrid Retrieval Defaults

`MemoryEngine` now hydrates chunk embeddings during ingest and uses a hybrid retriever inside `retrieve()` and `ask()`.

- If you configure an OpenAI-compatible provider, CHME will use real embeddings automatically.
- If no embedding endpoint is configured, CHME falls back to deterministic local embeddings so retrieval still works offline and in tests.

### Local (Ollama)

```typescript
const engine = new MemoryEngine({
  provider: 'local',
  localUrl: 'http://localhost:11434/api/generate',
  model: 'qwen2.5:7b',
  embeddingModel: 'nomic-embed-text',
  localEmbeddingUrl: 'http://localhost:11434/api/embeddings',
  temperature: 0
})
```

Use the LLM path explicitly when you want a generated answer instead of the default grounded extractive response:

```typescript
const answer = await engine.askWithLLM('Summarize the main risks across the files.', {
  topCollections: 3,
  topKPerCollection: 3,
  maxContextChars: 2000
})
```

### OpenAI-Compatible (Mistral, etc.)

```typescript
const engine = new MemoryEngine({
  provider: 'openai',
  model: 'mistral-small-latest',
  embeddingModel: 'mistral-embed',
  openAIBaseUrl: 'https://api.mistral.ai/v1',
  openAIApiKey: process.env.MISTRAL_API_KEY,
  temperature: 0
})
```

## Available Scripts

```bash
# Unit + integration tests (including snapshot flow)
npm run verify

# Dry-run without Ollama
npm run test:ollama:dry

# Live Ollama test (qwen2.5:7b)
npm run test:ollama

# Basic pipeline smoke run
npm run pipeline

# Benchmark tests
npm run benchmark           # Deterministic benchmark
npm run benchmark:factual   # Factual accuracy benchmark
npm run benchmark:live     # Live LLM benchmark
npm run benchmark:factual:live  # Live factual grading
npm run benchmark:factual:mistral  # Mistral factual benchmark
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MemoryEngine                              │
│                    (Main Entry Point)                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Ingest    │  │    Query     │  │   GenerateAnswer     │  │
│  │   Module    │  │    Module    │  │      Module           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│         │                 │                      │               │
│         ▼                 ▼                      ▼               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Collection Management                    │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────┐   │ │
│  │  │Documents│  │ Sections│  │  Chunks │  │    Nodes    │   │ │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────────┘   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│         │                 │                      │               │
│         ▼                 ▼                      ▼               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Keyword Index                             │ │
│  │              (Chunk → Document Mapping)                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
         ┌─────────────────────────────────────────────┐
         │              LLM Integration                │
         │  ┌─────────────┐    ┌───────────────────┐   │
         │  │   Ollama    │    │ OpenAI-compatible │   │
         │  │  (Local)   │    │  API (Mistral)    │   │
         │  └─────────────┘    └───────────────────┘   │
         └─────────────────────────────────────────────┘
```

## Data Model

### Collection Hierarchy

```
Collection
├── id: string
├── documents: Document[]
├── sections: Section[]
├── chunks: Chunk[]
├── nodes: Node[]
└── keywords: Map<string, number>
```

### Document Flow

```
Markdown File
       │
       ▼
   Document
       │
       ├── Section 1 ───┬──▶ Chunk 1 ──▶ Node 1
       │                ├──▶ Chunk 2 ──▶ Node 2
       │                └──▶ Chunk 3 ──▶ Node 3
       │
       ├── Section 2 ───┬──▶ Chunk 4 ──▶ Node 4
       │                └──▶ Chunk 5 ──▶ Node 5
       │
       └── Section N ──▶ ...
```

### Node ID Schema

| Level | Format | Example |
|-------|--------|---------|
| Root | `{docId}:root` | `overview:root` |
| Section | `{docId}:section:{sectionIndex}` | `overview:section:1` |
| Chunk | `{docId}:{sectionIndex}:{chunkIndex}` | `overview:1:0` |

## Configuration

### MemoryEngine Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | string | `qwen2.5:7b` | LLM model name |
| `topK` | number | `5` | Default top-K chunks per collection |
| `maxContextChars` | number | `2000` | Maximum context characters |
| `temperature` | number | `0` | LLM temperature |
| `maxTokens` | number | - | Maximum tokens for generation |
| `provider` | `'local'` \| `'openai'` | `'local'` | LLM provider |
| `localUrl` | string | `http://localhost:11434/api/generate` | Ollama endpoint |
| `embeddingModel` | string | auto/deterministic | Embedding model for hybrid retrieval |
| `localEmbeddingUrl` | string | inferred | Local embedding endpoint |
| `embeddingDimensions` | number | `192` | Dimension count for deterministic fallback embeddings |
| `openAIBaseUrl` | string | - | OpenAI-compatible API URL |
| `openAIApiKey` | string | - | API key |
| `snapshotDir` | string | `./snapshots` | Snapshot directory |

## Benchmark Results

### Dataset

| Collection | Documents | Sections | Chunks | Nodes | Keywords |
|------------|-----------|----------|--------|-------|----------|
| compliance | 5 | 30 | 50 | 85 | 206 |
| payments | 5 | 30 | 50 | 85 | 215 |
| risk | 5 | 30 | 50 | 85 | 201 |

### Performance Metrics

| Metric | Score |
|--------|-------|
| Route Top-1 Accuracy | 1.00 |
| Route Recall@N | 1.00 |
| Hit@K | 0.917 |
| MRR@K | 0.799 |
| Evidence Recall | 0.819 |
| Mean Factual Score | 0.546 |

### Latency Profile

| Stage | Mean (ms) | P50 (ms) | P95 (ms) |
|-------|-----------|----------|----------|
| Route | 0.05 | 0.04 | 0.08 |
| Retrieve | 0.09-0.35 | 0.09-0.25 | 0.15-0.67 |
| Prompt | 0.07 | 0.06 | 0.15 |
| Ask (LLM) | ~6025 | ~5674 | ~10511 |

**Note:** Memory pipeline stages are sub-millisecond to low-millisecond. End-to-end latency is dominated by external model inference.

### Determinism

- **Route determinism:** ✅ 100%
- **Retrieve determinism:** ✅ 100%
- **Prompt determinism:** ✅ 100%
- **Snapshot roundtrip:** ✅ Pass (0 mismatches)

## Snapshot System

### Save Snapshots

```typescript
await engine.saveSnapshots('./snapshots')
// Creates: 
// - snapshots/_engine.chme.json.gz
// - snapshots/<collectionId>.chme.json.gz
```

### Load Snapshots

```typescript
await engine.loadSnapshots('./snapshots', {
  sourceRootPath: './knowledge'  // Optional: freshness check
})
```

### Warm Startup Pattern

```typescript
import { existsSync } from 'node:fs'
import { MemoryEngine } from './src/MemoryEngine'

async function bootstrap() {
  const sourceRoot = './knowledge'
  const snapshotDir = './snapshots'

  const engine = new MemoryEngine({
    provider: 'local',
    model: 'qwen2.5:7b',
    temperature: 0
  })

  if (existsSync(`${snapshotDir}/_engine.chme.json.gz`)) {
    // Load existing snapshots (with optional freshness check)
    await engine.loadSnapshots(snapshotDir, { sourceRootPath: sourceRoot })
  } else {
    // Fresh start - ingest and save
    await engine.ingestAuto(sourceRoot, { defaultCollectionId: 'general' })
    await engine.saveSnapshots(snapshotDir)
  }

  return engine
}
```

## Routing Rules

Configure automatic collection assignment during ingestion:

```typescript
engine.setRoutingRules([
  { pattern: /faq/i, collectionId: 'faq', priority: 10 },
  { pattern: /release/i, collectionId: 'release_notes', priority: 5 },
  { pattern: /^ops\//, collectionId: 'operations', priority: 8 }
])

await engine.ingestAuto('./knowledge', { defaultCollectionId: 'general' })
```

**Routing Priority:**
1. Rule match (higher priority first)
2. Path-based slug (first folder)
3. Default collection

## Global vs Scoped Ask

### Global Ask (auto-routing)

```typescript
const answer = await engine.ask('What is the main topic?', {
  topCollections: 3,
  topKPerCollection: 3,
  maxContextChars: 2000
})
```

**Use when:**
- User doesn't know the right collection
- Multi-domain knowledge base
- Top-N collection routing needed

### Scoped Ask (specific collection)

```typescript
const answer = await engine.ask('product_docs', 'How does ingestion work?')
```

**Use when:**
- Question belongs to one known domain
- Tighter retrieval control needed
- UI already selects a collection

## Debugging Tools

```typescript
// Debug routing
const collections = await engine.routeCollections('How does keyword retrieval work?', { topCollections: 3 })
console.log('Routed:', collections)

// Debug retrieval
const chunks = await engine.retrieve(collections[0], 'How does keyword retrieval work?', 5)
console.log(chunks.map((c) => c.id))

// Debug prompt
const prompt = await engine.buildPrompt(collections[0], 'How does keyword retrieval work?', 5, 1200)
console.log(prompt)
```

## Documentation

| Document | Description |
|----------|-------------|
| [`SYSTEM_DESIGN.md`](SYSTEM_DESIGN.md) | Detailed system architecture and algorithms |
| [`eng_usage.md`](eng_usage.md) | Complete English usage guide |
| [`usage.md`](usage.md) | Turkish usage guide |
| [`MEMORY_ENGINE_STATUS.md`](MEMORY_ENGINE_STATUS.md) | Current status and capabilities |
| [`benchmark/README.md`](benchmark/README.md) | Benchmark documentation |
| [Technical Paper](https://tahsinkoc.com/papers/chme-hierarchical-memory-engine) | Academic paper on CHME |

## Future Work


- Multi-lingual support
- Response caching
- Learned rerankers

---

**Version:** 1.0.0  
**Last Updated:** 2026-02-26

## Roadmap & Improvement Areas

CHME is actively being improved. Current focus areas include:

### 1. Reranking Strategy
A reranking layer is planned to improve retrieval precision. The current keyword-based retrieval provides fast candidate generation, but a learned reranker will help filter and rank the most relevant chunks before context construction.

### 2. Factual Accuracy Improvement
Current factual accuracy: **0.546 - 0.59**  
Target: **0.80+**

Key improvements planned:
- Hybrid retrieval (keyword + semantic embeddings)
- Better chunk boundary detection
- Improved prompt engineering
- Enhanced evidence coverage metrics
