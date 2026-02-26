# CHME (Compact Hierarchical Memory Engine) - System Design

## 1. Overview

CHME is a **compact, in-memory, hierarchical memory orchestration engine** written in TypeScript. It provides a structured memory system for Large Language Models (LLM) and automatically extracts, indexes, and queries information from markdown-based documents.

### Core Features
- **Multi-Collection Support**: Manages multiple topic domains in isolated collections
- **Auto-Routing**: Routes queries to correct collections via regex-based rules
- **Keyword Indexing**: Section-aware chunk-level search
- **Local and Cloud LLM Support**: Ollama (local) and OpenAI-compatible APIs (Mistral, OpenAI, etc.)
- **Snapshot Persistence**: Compressed state saving in `.chme.json.gz` format

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MemoryEngine                              │
│                    (Main Entry Point)                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Ingest    │  │    Query     │  │  GenerateAnswer      │  │
│  │   Module    │  │    Module    │  │      Module          │  │
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

---

## 3. Data Structures

### 3.1 Collection Hierarchy

```
Collection
├── id: string
├── documents: Document[]
├── sections: Section[]
├── chunks: Chunk[]
├── nodes: Node[]
└── keywords: Map<string, number>
```

**Document Flow:**
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

### 3.2 Core Types

```typescript
// Collection Content Structure
type Collection = {
  id: string                    // Unique identifier
  documents: Document[]         // Original files
  sections: Section[]          // Header-based sections
  chunks: Chunk[]              // Split content
  nodes: Node[]                // Indexed nodes
  keywords: Map<string, number> // Frequency-based keywords
}

// Query Result
type QueryResult = {
  collectionId: string           // Matched collection
  nodes: Node[]                  // Returned nodes
  scores: number[]               // Relevance scores
}
```

---

## 4. Core Algorithms

### 4.1 Ingest Algorithm

```
function ingest(rootPath: string, collectionId: string):
  
  1. Scan Files (.md files)
     for each markdownFile in rootPath:
       
       2. Parse (Create Document)
          document = parseMarkdown(file)
       
       3. Split into Sections
          sections = extractSections(document)
       
       4. Split into Chunks
          chunks = splitIntoChunks(sections, MAX_CHUNK_CHARS)
       
       5. Index Nodes
          for each chunk in chunks:
            nodes.push(createNode(chunk, section, document))
       
       6. Extract Keywords
          keywords = extractKeywords(chunks)
  
  7. Save to Collection
     collection = createCollection(id, documents, sections, chunks, nodes, keywords)
  
  return collection
```

**Time Complexity:** O(n × m)  
- n: Total number of files  
- m: Average chunk count per file

### 4.2 Query Algorithm

```
function query(question: string, options: QueryOptions):
  
  1. Collection Selection (Routing)
     if options.topCollections > 1:
       scores = scoreAllCollections(question)
       selectedCollections = topN(scores, options.topCollections)
     else:
       selectedCollections = [defaultCollection]
  
  2. Keyword Matching
     queryKeywords = extractKeywords(question)
     
     for each collection in selectedCollections:
       for each keyword in queryKeywords:
         matchingChunks = collection.keywordIndex[keyword]
         
         // Calculate chunk scores
         for chunk in matchingChunks:
           score = calculateRelevanceScore(chunk, queryKeywords)
       
       // Select top K chunks
       topChunks = topN(scores, options.topKPerCollection)
  
  3. Return Result
     return QueryResult(selectedCollections, topChunks)
```

**Matching Formula:**
\[
\text{Score}(q, c) = \sum_{w \in K_q} \text{tf}(w, c) \times \text{idf}(w)
\]
- \(K_q\): Query keywords
- \(\text{tf}(w, c)\): Term frequency
- \(\text{idf}(w)\): Inverse document frequency

### 4.3 Routing Algorithm

```
function route(question: string, rules: RoutingRule[]):
  
  1. Regex Matching
     for each rule in rules:
       if rule.pattern.test(question):
         matches.push({ rule, score: rule.priority || 1 })
  
  2. Score Sorting
     matches = sortByScore(matches, descending)
  
  3. Best Match
     if matches.length > 0:
       return matches[0].collectionId
     else:
       return defaultCollectionId
```

---

## 5. Persistence (Snapshot) System

### 5.1 Saving (Save)

```
function saveSnapshots():
  
  1. For Each Collection:
     snapshotData = {
       id: collection.id,
       documents: collection.documents,
       sections: collection.sections,
       chunks: collection.chunks,
       nodes: collection.nodes,
       keywords: Object.fromEntries(collection.keywords)
     }
  
  2. Compress
     compressed = gzip(JSON.stringify(snapshotData))
  
  3. Write to File
     filePath = `${snapshotDir}/${collection.id}.chme.json.gz`
     writeFile(filePath, compressed)
  
  4. Update Metadata
     meta = { path, collectionId, size, mtimeMs }
```

### 5.2 Loading (Load)

```
function loadSnapshots():
  
  1. Scan Files
     files = readdir(snapshotDir)
  
  2. For Each File:
     compressed = readFile(filePath)
     snapshotData = JSON.parse(gunzip(compressed))
     
     // Freshness Check
     if snapshotData.mtimeMs < currentFile.mtimeMs:
       // File changed, re-ingest
       reingest(collectionId)
     else:
       // Reconstruct collection
       collection = reconstructCollection(snapshotData)
```

---

## 6. LLM Integration

### 6.1 Provider Architecture

```typescript
interface LLMProvider {
  generate(prompt: string): Promise<string>
}

class OllamaProvider implements LLMProvider {
  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.model,
        prompt: prompt,
        stream: false
      })
    })
    return response.json().response
  }
}

class OpenAIProvider implements LLMProvider {
  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: this.temperature,
        max_tokens: this.maxTokens
      })
    })
    return response.json().choices[0].message.content
  }
}
```

### 6.2 Prompt Template

```
Question: {question}

Context:
{context}

Please answer the question using the context above.
Only use information from the provided context in your answer.
```

---

## 7. Benchmark Metrics

### 7.1 Routing Metrics

| Metric | Formula | Description |
|--------|---------|-------------|
| Route Top-1 Accuracy | \(\frac{1}{\|Q\|}\sum \mathbf{1}\{\hat{c}_1 \in C^*\}\) | First position collection accuracy |
| Route Recall@N | \(\frac{1}{\|Q\|}\sum \mathbf{1}\{\hat{C}_N \cap C^* \neq \emptyset\}\) | At least one correct collection in N |

### 7.2 Retrieval Metrics

| Metric | Formula | Description |
|--------|---------|-------------|
| Hit@K | \(\frac{1}{\|Q\|}\sum \mathbf{1}\{\exists r \leq K: d_r \in D^*\}\) | At least one relevant document in K |
| MRR@K | \(\frac{1}{\|Q\|}\sum \frac{1}{\text{rank}}\) | Mean reciprocal rank |
| Precision@K | \(\frac{1}{\|Q\|}\sum \frac{|R_K \cap D^*|}{K}\) | Ratio of correct retrievals |
| Evidence Recall | \(\frac{1}{\|Q\|}\sum \frac{|R_K \cap D^*|}{|D^*|}\) | Ratio of all relevant docs found |

### 7.3 Factuality Metrics

\[
\text{FactualScore} = 0.5 \times \text{KeywordCoverage} + 0.5 \times \text{GroundingRatio}
\]

- **KeywordCoverage**: \(\frac{|K_{ans} \cap K_{expected}|}{|K_{expected}|}\)
- **GroundingRatio**: \(\frac{|T_{ans} \cap T_{ctx}|}{|T_{ans}|}\)

---

## 8. Performance Characteristics

### 8.1 Latency Profile

| Operation | Mean (ms) | p95 (ms) |
|-----------|-----------|----------|
| Route | 0.05 | 0.07 |
| Retrieve | 0.23 | 0.53 |
| LLM Query (Ask) | 1982 | 3169 |
| Total | ~1983 | ~3170 |

### 8.2 Scalability

- **Document Count**: Linear search complexity O(d)
- **Collection Count**: Routing O(r) + Retrieval O(k)
- **Memory Usage**: ~1KB per chunk

---

## 9. Usage Examples

### 9.1 Basic Usage

```typescript
import { MemoryEngine } from './src/MemoryEngine'

const engine = new MemoryEngine({
  provider: 'local',
  model: 'qwen2.5:7b',
  snapshotDir: './snapshots'
})

// Ingest documents
await engine.ingestAuto('./test', { defaultCollectionId: 'general' })

// Save snapshot
await engine.saveSnapshots()

// Query
const answer = await engine.ask('What is the main topic of these files?')
console.log(answer)
```

### 9.2 Using Mistral API

```typescript
const engine = new MemoryEngine({
  provider: 'openai',
  model: 'mistral-small-latest',
  openAIBaseUrl: 'https://api.mistral.ai/v1',
  openAIApiKey: process.env.MISTRAL_API_KEY,
  temperature: 0
})
```

---

## 10. Future Work

1. **Vector-based Search**: Embedding-based semantic search instead of TF-IDF
2. **Dynamic Routing**: LLM-based intelligent collection selection
3. **Multi-lingual Support**: Language detection and translation integration
4. **Caching**: Response cache for frequently asked questions

---

*Last Updated: 2026-02-26*
*Version: 1.0.0*
