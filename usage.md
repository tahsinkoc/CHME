# CHME MemoryEngine Complete Usage Guide

Bu dokuman, CHME MemoryEngine'in tam kullanim rehberidir.

Hedef:

1. Tool'u tek giris noktasi olarak kullanmak (`MemoryEngine`)
2. Dokumanlari otomatik collection'lara ayirmak
3. Retrieval + prompt + LLM cevap akisini calistirmak
4. Snapshot alip hizli startup yapmak

## 1) Bu tool ne icin?

CHME, bir "memory orchestration" katmanidir.

RAG yapmak zorunda degilsin, ama RAG/chatbot/informal bot sistemlerine kolayca entegre edebilirsin.
Asagidaki isleri senin yerine yapar:

1. Markdown ingest
2. Tree kurma (document root -> section -> chunk)
3. Keyword index olusturma
4. Collection routing
5. Retrieval
6. Context prompt olusturma
7. LLM'e gonderme

## 2) Veri modeli ve agac yapisi

Collection icindeki yapi:

1. Rooted hierarchical tree
2. Parent/children baglantisi (adjacency-list stili)

Engine genelinde:

1. Birden fazla collection
2. Forest (collection bazli agaclar kumesi)

Node ID semasi:

1. Root: `{docId}:root`
2. Section: `{docId}:section:{sectionIndex}`
3. Chunk: `{docId}:{sectionIndex}:{chunkIndex}`

## 3) Kurulum

Gereksinim:

1. Node.js 18+
2. TypeScript calistirmak icin `ts-node`

Bu repoda scriptler:

```bash
npm run verify
npm run pipeline
npm run test:ollama:dry
npm run test:ollama
```

## 4) MemoryEngine public API ozeti

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
  snapshotDir?: string
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
saveSnapshots(snapshotDir?: string): Promise<SnapshotSaveReport>
loadSnapshots(snapshotDir?: string, options?: SnapshotLoadOptions): Promise<SnapshotLoadReport>
```

### Runtime ayarlari

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
setSnapshotDir(dir: string): void
getSnapshotDir(): string
```

## 5) En hizli baslangic (global ask)

```ts
import { MemoryEngine } from './src/MemoryEngine'

async function main() {
  const engine = new MemoryEngine({
    provider: 'local',
    localUrl: 'http://localhost:11434/api/generate',
    model: 'qwen2.5:7b',
    temperature: 0
  })

  // test/ icindeki markdown dosyalarini otomatik collection'lara ayir ve ingest et
  const report = await engine.ingestAuto('./test', { defaultCollectionId: 'general' })
  console.log('Ingest files:', report.files)
  console.log('Collections:', [...new Set(report.assignments.map((a) => a.collectionId))])

  // collection id vermeden global soru
  const answer = await engine.ask('What is the main topic of the files?', {
    topCollections: 3,
    topKPerCollection: 3,
    maxContextChars: 2000
  })

  console.log(answer)
}

main().catch(console.error)
```

## 6) Scoped ask (belirli collection)

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

## 7) Routing kurallari (deterministic collection dagitimi)

```ts
import { MemoryEngine } from './src/MemoryEngine'

async function main() {
  const engine = new MemoryEngine()

  engine.setRoutingRules([
    { pattern: /faq/i, collectionId: 'faq', priority: 10 },
    { pattern: /release/i, collectionId: 'release_notes', priority: 5 },
    { pattern: /^ops\\//, collectionId: 'operations', priority: 8 }
  ])

  const report = await engine.ingestAuto('./knowledge', { defaultCollectionId: 'general' })
  console.log(report.assignments)
}
```

Routing onceligi:

1. Rule match (priority yuksek -> once)
2. Path tabanli slug (ilk klasor)
3. Default collection

## 8) Snapshot persistence (onerilen production akis)

Snapshot dosyalari:

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

### Snapshot path precedence

Snapshot yolu cozum sirasi:

1. Metot parametresi
2. Engine default (`snapshotDir` constructor veya `setSnapshotDir`)
3. Fallback `./snapshots`

```ts
const engine = new MemoryEngine({ snapshotDir: './runtime-snapshots' })
await engine.saveSnapshots() // ./runtime-snapshots
await engine.saveSnapshots('./custom-snapshots') // override
```

`loadSnapshots` davranisi:

1. Mevcut in-memory state replace edilir
2. Snapshot collection'lar yuklenir
3. `sourceRootPath` verilirse freshness kontrolu yapilir (mtime + size)
4. Degisen collection'lar partial reingest edilir

## 9) Warm startup (load-if-fresh) ornegi

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

## 10) Retrieval ve prompt debug

```ts
const collections = await engine.routeCollections('How does keyword retrieval work?', { topCollections: 3 })
console.log('Routed:', collections)

const chunks = await engine.retrieve(collections[0], 'How does keyword retrieval work?', 5)
console.log(chunks.map((c) => c.id))

const prompt = await engine.buildPrompt(collections[0], 'How does keyword retrieval work?', 5, 1200)
console.log(prompt)
```

## 11) Global vs scoped ne zaman?

Global ask kullan:

1. Kullanici hangi collection'i bilmiyorsa
2. Multi-domain knowledge base varsa
3. Top-N collection routing istiyorsan

Scoped ask kullan:

1. Soru tek bir domainle ilgiliyse
2. Daha kontrollu retrieval istiyorsan
3. UI tarafi zaten collection seciyorsa

## 12) LLM provider notlari

Varsayilan:

1. Provider: `local`
2. Model: `qwen2.5:7b` (call katmaninda)

Ollama local endpoint:

```txt
http://localhost:11434/api/generate
```

OpenAI gecis:

```ts
engine.setProvider('openai')
engine.setOpenAIBaseUrl('https://api.openai.com/v1')
engine.setOpenAIApiKey(process.env.OPENAI_API_KEY || '')
engine.setModel('gpt-4')
```

Not:

`callLLM` hata veya ulasilamayan endpoint durumunda `''` donebilir.
Bu davranis testlerde bilincli olarak kullaniliyor.

## 13) Dev experience degerlendirmesi

Guclu yonler:

1. Tek entrypoint (`MemoryEngine`)
2. Additive API (mevcut akis bozulmadan gelisti)
3. Deterministic routing/retrieval
4. Snapshot ile hizli startup
5. Dry + live test senaryolari hazir

Dikkat edilmesi gerekenler:

1. Retrieval keyword tabanli (embedding/semantic yok)
2. Collection ici tree traversal icin simdilik dusuk seviyede `getCollection` ile `Collection` API kullanimi gerekebilir
3. Cok buyuk corpus'ta query ve global context birlestirme adimlari icin ileride optimizasyon gerekebilir

## 14) Test ve dogrulama komutlari

```bash
# Birim + entegrasyon (snapshot dahil)
npm run verify

# Ollama olmadan dry-run
npm run test:ollama:dry

# Ollama canli test (qwen2.5:7b)
npm run test:ollama

# Basit pipeline
npm run pipeline
```

Opsiyonel custom snapshot yolu:

```bash
npm run verify -- --snapshot-dir ./tmp/chme-verify
npm run test:ollama:dry -- --snapshot-dir ./tmp/chme-ollama
```

## 15) SSS

### Bu tool sadece RAG icin mi?

Hayir. Bu bir memory orchestration katmani. RAG'de kullanilabilir ama zorunlu degil.

### Neden auto collection routing var?

Cunku buyuk dokuman havuzunda once dogru collection secmek maliyet ve kaliteyi iyilestirir.

### Neden snapshot gerekli?

Her startup'ta yeniden ingest maliyetini dusurmek icin. Buyuk corpus'ta kritik.

### Tree yapisinin adi ne?

Collection icinde rooted hierarchical tree, engine genelinde forest, temsil adjacency-list.

---

Bu dosya proje buyudukce API degisiklikleriyle birlikte guncellenmelidir.
