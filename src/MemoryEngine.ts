import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib'
import { promisify } from 'node:util'
import { Collection, Node } from './Collection'
import { ingest as ingestCollection, ingestFiles } from './ingest'
import { query } from './query'
import { callLLM, LLMProvider } from './callLLM'
import { fitTextBlocksToLimit, tokenizeSearchText } from './text'
import { synthesizeAnswer } from './synthesizeAnswer'
import { cosineSimilarity, embedTexts, resolveEmbeddingModel } from './embedding'

const gzip = promisify(gzipCallback)
const gunzip = promisify(gunzipCallback)

type MemoryEngineOptions = {
  model?: string
  topK?: number
  maxContextChars?: number
  temperature?: number
  maxTokens?: number
  provider?: LLMProvider
  localUrl?: string
  openAIBaseUrl?: string
  openAIApiKey?: string
  snapshotDir?: string
  embeddingModel?: string
  localEmbeddingUrl?: string
  embeddingDimensions?: number
  embeddingTimeoutMs?: number
  lexicalWeight?: number
  semanticWeight?: number
}

export type RoutingRule = {
  pattern: RegExp
  collectionId: string
  priority?: number
}

export type IngestAutoOptions = {
  maxCollections?: number
  minRouteScore?: number
  defaultCollectionId?: string
}

export type RouteOptions = {
  topCollections?: number
}

export type AskGlobalOptions = {
  topCollections?: number
  topKPerCollection?: number
  maxContextChars?: number
}

type RoutingAssignment = {
  file: string
  collectionId: string
  reason: string
}

export type IngestAutoReport = {
  files: number
  collectionsCreated: string[]
  assignments: RoutingAssignment[]
}

export type RoutingReport = {
  lastIngestAssignments: RoutingAssignment[]
}

export type CollectionStats = {
  documents: number
  sections: number
  chunks: number
  nodes: number
  keywords: number
}

export type SnapshotFileMeta = {
  path: string
  collectionId: string
  size: number
  mtimeMs: number
}

export type SnapshotSaveReport = {
  collections: number
  files: number
  snapshotDir: string
}

export type SnapshotLoadOptions = {
  sourceRootPath?: string
}

export type SnapshotLoadReport = {
  collectionsLoaded: number
  staleCollectionsReingested: string[]
  filesChecked: number
}

type RoutingRuleSnapshot = {
  pattern: string
  flags: string
  collectionId: string
  priority?: number
}

type CollectionSnapshot = {
  id: string
  documents: Array<{ id: string; path: string }>
  nodes: Node[]
  keywordIndex: Array<{ token: string; nodeIds: string[] }>
}

type EngineSnapshotManifest = {
  schemaVersion: number
  savedAt: string
  lastSourceRootPath?: string
  defaultCollectionId: string
  minRouteScore: number
  embeddingSignature?: string
  routingRules: RoutingRuleSnapshot[]
  collections: string[]
  sourceFiles: SnapshotFileMeta[]
}

const SNAPSHOT_SCHEMA_VERSION = 1
const SNAPSHOT_EXTENSION = '.chme.json.gz'
const ENGINE_SNAPSHOT_FILE = `_engine${SNAPSHOT_EXTENSION}`
const DEFAULT_SNAPSHOT_DIR = './snapshots'
const DEFAULT_TOP_COLLECTIONS = 3
const DEFAULT_TOP_K_PER_COLLECTION = 3
const DEFAULT_MIN_ROUTE_SCORE = 1
const DEFAULT_EMBEDDING_DIMENSIONS = 192
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30000
const DEFAULT_LEXICAL_WEIGHT = 0.82
const DEFAULT_SEMANTIC_WEIGHT = 0.18
const DEFAULT_RETRIEVAL_CANDIDATE_MULTIPLIER = 6

export class MemoryEngine {
  private collections: Map<string, Collection>
  private model: string
  private topK: number
  private maxContextChars: number
  private temperature: number
  private maxTokens?: number
  private provider: LLMProvider
  private localUrl?: string
  private openAIBaseUrl?: string
  private openAIApiKey?: string
  private embeddingModel?: string
  private localEmbeddingUrl?: string
  private embeddingDimensions: number
  private embeddingTimeoutMs: number
  private lexicalWeight: number
  private semanticWeight: number
  private routingRules: RoutingRule[]
  private routingReport: RoutingReport
  private minRouteScore: number
  private lastSourceRootPath?: string
  private lastDefaultCollectionId: string
  private lastSourceFiles: SnapshotFileMeta[]
  private collectionToFiles: Map<string, string[]>
  private snapshotDir?: string
  private embeddingCache: Map<string, number[]>

  constructor(options: MemoryEngineOptions = {}) {
    this.collections = new Map()
    this.model = options.model ?? 'gpt-3.5-turbo'
    this.topK = options.topK ?? 5
    this.maxContextChars = options.maxContextChars ?? 2000
    this.temperature = options.temperature ?? 0
    this.maxTokens = options.maxTokens
    this.provider = options.provider ?? 'local'
    this.localUrl = options.localUrl
    this.openAIBaseUrl = options.openAIBaseUrl
    this.openAIApiKey = options.openAIApiKey
    this.embeddingModel = options.embeddingModel
    this.localEmbeddingUrl = options.localEmbeddingUrl
    this.embeddingDimensions = options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
    this.embeddingTimeoutMs = options.embeddingTimeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS
    this.lexicalWeight = options.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT
    this.semanticWeight = options.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT
    this.routingRules = []
    this.routingReport = { lastIngestAssignments: [] }
    this.minRouteScore = DEFAULT_MIN_ROUTE_SCORE
    this.lastSourceRootPath = undefined
    this.lastDefaultCollectionId = 'general'
    this.lastSourceFiles = []
    this.collectionToFiles = new Map()
    this.snapshotDir = undefined
    this.embeddingCache = new Map()

    if (options.model !== undefined) {
      this.setModel(options.model)
    }
    if (options.topK !== undefined) {
      this.setTopK(options.topK)
    }
    if (options.maxContextChars !== undefined) {
      this.setMaxContextChars(options.maxContextChars)
    }
    if (options.temperature !== undefined) {
      this.setTemperature(options.temperature)
    }
    if (options.maxTokens !== undefined) {
      this.setMaxTokens(options.maxTokens)
    }
    if (options.snapshotDir !== undefined) {
      this.setSnapshotDir(options.snapshotDir)
    }
  }

  createCollection(id: string): Collection {
    if (!id || id.trim().length === 0) {
      throw new Error('Collection id must be a non-empty string')
    }

    const existing = this.collections.get(id)
    if (existing) {
      return existing
    }

    const collection = new Collection(id)
    this.collections.set(id, collection)
    return collection
  }

  getCollection(id: string): Collection | undefined {
    return this.collections.get(id)
  }

  getCollectionStats(collectionId: string): CollectionStats {
    const collection = this.collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }

    const nodes = Array.from(collection.getAllNodes().values())
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

    return {
      documents,
      sections,
      chunks,
      nodes: nodes.length,
      keywords: collection.getKeywordIndex().size
    }
  }

  getRoutingReport(): RoutingReport {
    return {
      lastIngestAssignments: this.routingReport.lastIngestAssignments.map((item) => ({ ...item }))
    }
  }

  setRoutingRules(rules: RoutingRule[]): void {
    this.routingRules = rules.map((rule) => {
      if (!rule.collectionId || rule.collectionId.trim().length === 0) {
        throw new Error('Routing rule collectionId must be a non-empty string')
      }
      return {
        pattern: rule.pattern,
        collectionId: this.slugify(rule.collectionId),
        priority: rule.priority
      }
    })
  }

  async ingest(collectionId: string, targetPath: string): Promise<void> {
    const collection = this.collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }

    await ingestCollection(targetPath, collection)
  }

  async ingestAuto(rootPath: string, options: IngestAutoOptions = {}): Promise<IngestAutoReport> {
    const absoluteRoot = path.resolve(rootPath)
    const files = await this.collectMarkdownFiles(absoluteRoot)
    files.sort((a, b) => a.localeCompare(b))

    const defaultCollectionId = this.slugify(options.defaultCollectionId ?? 'general')
    const maxCollections = options.maxCollections && options.maxCollections > 0
      ? options.maxCollections
      : Number.POSITIVE_INFINITY
    const minRouteScore = this.normalizeMinRouteScore(options.minRouteScore, this.minRouteScore)

    this.lastSourceRootPath = absoluteRoot
    this.lastDefaultCollectionId = defaultCollectionId
    this.minRouteScore = minRouteScore
    this.lastSourceFiles = []
    this.collectionToFiles = new Map()

    const grouped = new Map<string, string[]>()
    const assignments: RoutingAssignment[] = []
    const created = new Set<string>()

    for (const filePath of files) {
      const route = this.routeFileToCollection(absoluteRoot, filePath, defaultCollectionId)
      let resolvedCollectionId = route.collectionId
      let reason = route.reason

      if (!this.collections.has(resolvedCollectionId) && created.size >= maxCollections) {
        resolvedCollectionId = defaultCollectionId
        reason = `maxCollections:${reason}`
      }

      if (!this.collections.has(resolvedCollectionId)) {
        this.createCollection(resolvedCollectionId)
        created.add(resolvedCollectionId)
      }

      const list = grouped.get(resolvedCollectionId)
      if (list) {
        list.push(filePath)
      } else {
        grouped.set(resolvedCollectionId, [filePath])
      }

      const relativeFile = this.normalizePath(path.relative(absoluteRoot, filePath))
      const sourceStats = await stat(filePath)
      this.lastSourceFiles.push({
        path: relativeFile,
        collectionId: resolvedCollectionId,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs
      })

      const collectionFiles = this.collectionToFiles.get(resolvedCollectionId)
      if (collectionFiles) {
        collectionFiles.push(relativeFile)
      } else {
        this.collectionToFiles.set(resolvedCollectionId, [relativeFile])
      }

      assignments.push({
        file: relativeFile,
        collectionId: resolvedCollectionId,
        reason
      })
    }

    const collectionIds = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b))
    for (const collectionId of collectionIds) {
      const collection = this.collections.get(collectionId)
      if (!collection) {
        continue
      }
      const fileList = grouped.get(collectionId) || []
      await ingestFiles(fileList, absoluteRoot, collection)
      await this.hydrateCollectionEmbeddings(collection)
    }

    this.sortSourceMetadata()
    this.routingReport = {
      lastIngestAssignments: assignments.map((item) => ({ ...item }))
    }

    return {
      files: files.length,
      collectionsCreated: Array.from(created).sort((a, b) => a.localeCompare(b)),
      assignments
    }
  }

  async routeCollections(question: string, options: RouteOptions = {}): Promise<string[]> {
    const topCollections = this.normalizePositiveInteger(options.topCollections, DEFAULT_TOP_COLLECTIONS)
    if (topCollections < 1 || this.collections.size === 0) {
      return []
    }

    const queryTokens = tokenizeSearchText(question)
    const questionEmbedding = await this.embedQuery(question)

    const scored = await Promise.all(Array.from(this.collections.entries())
      .map(async ([collectionId, collection]) => {
        let score = 0
        const keywordIndex = collection.getKeywordIndex()
        for (const token of queryTokens) {
          if (keywordIndex.has(token)) {
            score += 1
          }
        }
        await this.hydrateCollectionEmbeddings(collection)
        const semanticScore = this.normalizeSemanticScore(
          cosineSimilarity(questionEmbedding, this.computeCollectionCentroid(collection))
        )
        return {
          collectionId,
          score: score + (semanticScore * 3),
          lexicalScore: score,
          semanticScore
        }
      }))
    scored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }
      return a.collectionId.localeCompare(b.collectionId)
    })

    const filtered = scored.filter((item) => item.score >= this.minRouteScore)
    const source = filtered.length > 0 ? filtered : scored

    return source.slice(0, topCollections).map((item) => item.collectionId)
  }

  async ask(collectionId: string, question: string): Promise<string>
  async ask(question: string, options?: AskGlobalOptions): Promise<string>
  async ask(arg1: string, arg2?: string | AskGlobalOptions): Promise<string> {
    if (typeof arg2 === 'string') {
      return await this.askScoped(arg1, arg2)
    }
    return await this.askGlobal(arg1, arg2)
  }

  async askWithLLM(collectionId: string, question: string): Promise<string>
  async askWithLLM(question: string, options?: AskGlobalOptions): Promise<string>
  async askWithLLM(arg1: string, arg2?: string | AskGlobalOptions): Promise<string> {
    if (typeof arg2 === 'string') {
      return await this.askScopedWithLLM(arg1, arg2)
    }
    return await this.askGlobalWithLLM(arg1, arg2)
  }

  async retrieve(collectionId: string, question: string, topK: number = this.topK): Promise<Node[]> {
    const collection = this.collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }
    return await this.retrieveHybrid(collection, question, topK)
  }

  async buildPrompt(
    collectionId: string,
    question: string,
    topK: number = this.topK,
    maxContextChars: number = this.maxContextChars
  ): Promise<string> {
    const collection = this.collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }
    const chunks = await this.retrieve(collectionId, question, topK)
    const context = this.buildCollectionContext(collection, chunks, maxContextChars)
    return this.composePrompt(context, question)
  }

  async saveSnapshots(snapshotDir?: string): Promise<SnapshotSaveReport> {
    const absoluteSnapshotDir = this.resolveSnapshotDir(snapshotDir)
    await mkdir(absoluteSnapshotDir, { recursive: true })

    const collectionIds = Array.from(this.collections.keys()).sort((a, b) => a.localeCompare(b))

    for (const collectionId of collectionIds) {
      const collection = this.collections.get(collectionId)
      if (!collection) {
        continue
      }
      const snapshotPath = this.collectionSnapshotPath(absoluteSnapshotDir, collectionId)
      const snapshot = this.serializeCollection(collection)
      await this.writeGzipJson(snapshotPath, snapshot)
    }

    const manifest: EngineSnapshotManifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      lastSourceRootPath: this.lastSourceRootPath,
      defaultCollectionId: this.lastDefaultCollectionId,
      minRouteScore: this.minRouteScore,
      embeddingSignature: this.getEmbeddingSignature(),
      routingRules: this.routingRules.map((rule) => ({
        pattern: rule.pattern.source,
        flags: rule.pattern.flags,
        collectionId: rule.collectionId,
        priority: rule.priority
      })),
      collections: collectionIds,
      sourceFiles: this.lastSourceFiles.map((item) => ({ ...item }))
    }

    const engineSnapshotPath = path.join(absoluteSnapshotDir, ENGINE_SNAPSHOT_FILE)
    await this.writeGzipJson(engineSnapshotPath, manifest)

    return {
      collections: collectionIds.length,
      files: collectionIds.length + 1,
      snapshotDir: absoluteSnapshotDir
    }
  }

  async loadSnapshots(snapshotDir?: string, options: SnapshotLoadOptions = {}): Promise<SnapshotLoadReport> {
    const absoluteSnapshotDir = this.resolveSnapshotDir(snapshotDir)
    const manifestPath = path.join(absoluteSnapshotDir, ENGINE_SNAPSHOT_FILE)
    const manifest = await this.readGzipJson<EngineSnapshotManifest>(manifestPath)

    if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(`Unsupported snapshot schema version: ${manifest.schemaVersion}`)
    }

    this.collections = new Map()
    this.routingRules = (manifest.routingRules || []).map((rule) => ({
      pattern: new RegExp(rule.pattern, rule.flags),
      collectionId: rule.collectionId,
      priority: rule.priority
    }))
    this.lastSourceRootPath = manifest.lastSourceRootPath
      ? path.resolve(manifest.lastSourceRootPath)
      : undefined
    this.lastDefaultCollectionId = this.slugify(manifest.defaultCollectionId || 'general')
    this.minRouteScore = this.normalizeMinRouteScore(manifest.minRouteScore, DEFAULT_MIN_ROUTE_SCORE)
    this.lastSourceFiles = (manifest.sourceFiles || []).map((item) => ({ ...item }))
    this.collectionToFiles = this.buildCollectionToFiles(this.lastSourceFiles)
    this.sortSourceMetadata()
    const shouldRefreshEmbeddings = (manifest.embeddingSignature || '') !== this.getEmbeddingSignature()

    let collectionsLoaded = 0
    for (const collectionId of manifest.collections || []) {
      const snapshotPath = this.collectionSnapshotPath(absoluteSnapshotDir, collectionId)
      const snapshot = await this.readGzipJson<CollectionSnapshot>(snapshotPath)
      this.restoreCollection(snapshot)
      collectionsLoaded += 1
    }

    if (shouldRefreshEmbeddings) {
      for (const collection of this.collections.values()) {
        this.clearCollectionEmbeddings(collection)
      }
    }

    let filesChecked = 0
    const staleCollections = new Set<string>()

    const sourceRootPath = options.sourceRootPath
      ? path.resolve(options.sourceRootPath)
      : this.lastSourceRootPath

    if (sourceRootPath) {
      const manifestPaths = new Set(this.lastSourceFiles.map((item) => item.path))

      for (const fileMeta of this.lastSourceFiles) {
        filesChecked += 1
        const absoluteFilePath = path.resolve(sourceRootPath, fileMeta.path)

        try {
          const currentStats = await stat(absoluteFilePath)
          if (!currentStats.isFile() || currentStats.size !== fileMeta.size || currentStats.mtimeMs !== fileMeta.mtimeMs) {
            staleCollections.add(fileMeta.collectionId)
          }
        } catch {
          staleCollections.add(fileMeta.collectionId)
        }
      }

      const currentFiles = await this.collectMarkdownFiles(sourceRootPath)
      currentFiles.sort((a, b) => a.localeCompare(b))

      const currentGrouped = new Map<string, string[]>()
      for (const absoluteFile of currentFiles) {
        const relativeFile = this.normalizePath(path.relative(sourceRootPath, absoluteFile))
        const route = this.routeFileToCollection(sourceRootPath, absoluteFile, this.lastDefaultCollectionId)

        const list = currentGrouped.get(route.collectionId)
        if (list) {
          list.push(absoluteFile)
        } else {
          currentGrouped.set(route.collectionId, [absoluteFile])
        }

        if (!manifestPaths.has(relativeFile)) {
          staleCollections.add(route.collectionId)
        }
      }

      const staleCollectionIds = Array.from(staleCollections).sort((a, b) => a.localeCompare(b))
      for (const collectionId of staleCollectionIds) {
        const replacement = new Collection(collectionId)
        this.collections.set(collectionId, replacement)

        const filesForCollection = currentGrouped.get(collectionId) || []
        if (filesForCollection.length > 0) {
          await ingestFiles(filesForCollection, sourceRootPath, replacement)
          await this.hydrateCollectionEmbeddings(replacement)
        }
      }

      this.lastSourceRootPath = sourceRootPath
      this.lastSourceFiles = []
      this.collectionToFiles = new Map()

      for (const absoluteFile of currentFiles) {
        const relativeFile = this.normalizePath(path.relative(sourceRootPath, absoluteFile))
        const route = this.routeFileToCollection(sourceRootPath, absoluteFile, this.lastDefaultCollectionId)
        const currentStats = await stat(absoluteFile)

        this.lastSourceFiles.push({
          path: relativeFile,
          collectionId: route.collectionId,
          size: currentStats.size,
          mtimeMs: currentStats.mtimeMs
        })

        const files = this.collectionToFiles.get(route.collectionId)
        if (files) {
          files.push(relativeFile)
        } else {
          this.collectionToFiles.set(route.collectionId, [relativeFile])
        }
      }

      this.sortSourceMetadata()
    }

    this.routingReport = {
      lastIngestAssignments: this.lastSourceFiles.map((item) => ({
        file: item.path,
        collectionId: item.collectionId,
        reason: 'snapshot'
      }))
    }

    if (shouldRefreshEmbeddings) {
      for (const collection of this.collections.values()) {
        await this.hydrateCollectionEmbeddings(collection)
      }
    }

    return {
      collectionsLoaded,
      staleCollectionsReingested: Array.from(staleCollections).sort((a, b) => a.localeCompare(b)),
      filesChecked
    }
  }

  setModel(model: string): void {
    if (!model || model.trim().length === 0) {
      throw new Error('Model must be a non-empty string')
    }
    this.model = model
  }

  setTopK(topK: number): void {
    if (!Number.isInteger(topK) || topK < 1) {
      throw new Error('topK must be an integer >= 1')
    }
    this.topK = topK
  }

  setMaxContextChars(chars: number): void {
    if (!Number.isInteger(chars) || chars < 200) {
      throw new Error('maxContextChars must be an integer >= 200')
    }
    this.maxContextChars = chars
  }

  setTemperature(temp: number): void {
    if (!Number.isFinite(temp) || temp < 0) {
      throw new Error('temperature must be a number >= 0')
    }
    this.temperature = temp
  }

  setMaxTokens(maxTokens: number): void {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new Error('maxTokens must be an integer >= 1')
    }
    this.maxTokens = maxTokens
  }

  setProvider(provider: LLMProvider): void {
    this.provider = provider
    this.embeddingCache.clear()
  }

  setLocalUrl(url: string): void {
    if (!url || url.trim().length === 0) {
      throw new Error('localUrl must be a non-empty string')
    }
    this.localUrl = url
    this.embeddingCache.clear()
  }

  setOpenAIBaseUrl(url: string): void {
    if (!url || url.trim().length === 0) {
      throw new Error('openAIBaseUrl must be a non-empty string')
    }
    this.openAIBaseUrl = url
    this.embeddingCache.clear()
  }

  setOpenAIApiKey(apiKey: string): void {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('openAIApiKey must be a non-empty string')
    }
    this.openAIApiKey = apiKey
    this.embeddingCache.clear()
  }

  setEmbeddingModel(model: string): void {
    if (!model || model.trim().length === 0) {
      throw new Error('embeddingModel must be a non-empty string')
    }
    this.embeddingModel = model
    this.embeddingCache.clear()
  }

  setLocalEmbeddingUrl(url: string): void {
    if (!url || url.trim().length === 0) {
      throw new Error('localEmbeddingUrl must be a non-empty string')
    }
    this.localEmbeddingUrl = url
    this.embeddingCache.clear()
  }

  setSnapshotDir(dir: string): void {
    if (!dir || dir.trim().length === 0) {
      throw new Error('snapshotDir must be a non-empty string')
    }
    this.snapshotDir = path.resolve(dir)
  }

  getSnapshotDir(): string {
    return this.resolveSnapshotDir()
  }

  private async askScoped(collectionId: string, question: string): Promise<string> {
    const chunks = await this.retrieve(collectionId, question, this.topK)
    return synthesizeAnswer(question, chunks, this.maxContextChars)
  }

  private async askScopedWithLLM(collectionId: string, question: string): Promise<string> {
    const prompt = await this.buildPrompt(collectionId, question)
    const maxTokens = this.resolveMaxTokens()
    return await callLLM(prompt, this.model, this.temperature, maxTokens, {
      provider: this.provider,
      localUrl: this.localUrl,
      openAIBaseUrl: this.openAIBaseUrl,
      openAIApiKey: this.openAIApiKey
    })
  }

  private async askGlobal(question: string, options: AskGlobalOptions = {}): Promise<string> {
    const topCollections = this.normalizePositiveInteger(options.topCollections, DEFAULT_TOP_COLLECTIONS)
    const topKPerCollection = this.normalizePositiveInteger(options.topKPerCollection, DEFAULT_TOP_K_PER_COLLECTION)
    const maxContextChars = options.maxContextChars ?? this.maxContextChars

    const selectedCollections = await this.routeCollections(question, { topCollections })
    if (selectedCollections.length === 0) {
      throw new Error('No collections available for global ask')
    }

    const chunks = (await this.retrieveAcrossCollections(selectedCollections, question, topKPerCollection))
      .slice(0, this.topK)
    return synthesizeAnswer(question, chunks, maxContextChars)
  }

  private async askGlobalWithLLM(question: string, options: AskGlobalOptions = {}): Promise<string> {
    const topCollections = this.normalizePositiveInteger(options.topCollections, DEFAULT_TOP_COLLECTIONS)
    const topKPerCollection = this.normalizePositiveInteger(options.topKPerCollection, DEFAULT_TOP_K_PER_COLLECTION)
    const maxContextChars = options.maxContextChars ?? this.maxContextChars

    const selectedCollections = await this.routeCollections(question, { topCollections })
    if (selectedCollections.length === 0) {
      throw new Error('No collections available for global ask')
    }

    const context = await this.buildGlobalContext(selectedCollections, question, topKPerCollection, maxContextChars)
    const prompt = this.composePrompt(context, question)

    return await callLLM(prompt, this.model, this.temperature, this.resolveMaxTokens(), {
      provider: this.provider,
      localUrl: this.localUrl,
      openAIBaseUrl: this.openAIBaseUrl,
      openAIApiKey: this.openAIApiKey
    })
  }

  private async buildGlobalContext(
    collectionIds: string[],
    question: string,
    topKPerCollection: number,
    maxContextChars: number
  ): Promise<string> {
    const blocks: string[] = []

    for (const collectionId of collectionIds) {
      const collection = this.collections.get(collectionId)
      if (!collection) {
        continue
      }

      const chunks = await this.retrieve(collectionId, question, topKPerCollection)
      for (const chunk of chunks) {
        blocks.push(this.formatContextBlock(collection, chunk, collectionId))
      }
    }

    return fitTextBlocksToLimit(blocks, maxContextChars)
  }

  private composePrompt(context: string, question: string): string {
    return [
      'You are an assistant with access to company knowledge.',
      'Use the following context to answer the question:',
      '',
      'CONTEXT:',
      context,
      '',
      'QUESTION:',
      question,
      '',
      'Answer:'
    ].join('\n')
  }

  private buildCollectionContext(collection: Collection, chunks: Node[], maxContextChars: number): string {
    const blocks = chunks.map((chunk) => this.formatContextBlock(collection, chunk))
    return fitTextBlocksToLimit(blocks, maxContextChars)
  }

  private formatContextBlock(collection: Collection, chunk: Node, collectionId?: string): string {
    const sectionTitle = this.resolveSectionTitle(collection, chunk)
    const heading = sectionTitle ? `## ${sectionTitle}` : '## Section'
    return collectionId
      ? `### Collection: ${collectionId}\n${heading}\n${chunk.text}`
      : `${heading}\n${chunk.text}`
  }

  private async retrieveHybrid(collection: Collection, question: string, topK: number): Promise<Node[]> {
    if (topK <= 0) {
      return []
    }

    const chunks = this.getChunkNodes(collection)
    if (chunks.length === 0) {
      return []
    }

    await this.hydrateCollectionEmbeddings(collection)

    const candidateLimit = Math.min(
      chunks.length,
      Math.max(topK * DEFAULT_RETRIEVAL_CANDIDATE_MULTIPLIER, topK)
    )
    const lexicalNodes = await query(collection, question, candidateLimit)
    const questionEmbedding = await this.embedQuery(question)

    if (questionEmbedding.length === 0) {
      return lexicalNodes.slice(0, topK)
    }

    const lexicalScores = new Map<string, number>()
    const docLexicalSupport = new Map<string, number>()
    for (let index = 0; index < lexicalNodes.length; index++) {
      const node = lexicalNodes[index]
      const lexicalScore = (lexicalNodes.length - index) / lexicalNodes.length
      lexicalScores.set(node.id, lexicalScore)
      const currentSupport = docLexicalSupport.get(node.docId) || 0
      docLexicalSupport.set(node.docId, Math.max(currentSupport, lexicalScore))
    }

    const semanticScored = chunks
      .map((node) => ({
        node,
        score: this.normalizeSemanticScore(cosineSimilarity(questionEmbedding, node.embedding))
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score
        }
        return a.node.id.localeCompare(b.node.id)
      })

    const candidateMap = new Map<string, { node: Node; lexicalScore: number; semanticScore: number }>()

    for (const node of lexicalNodes) {
      candidateMap.set(node.id, {
        node,
        lexicalScore: lexicalScores.get(node.id) || 0,
        semanticScore: 0
      })
    }

    for (const item of semanticScored.slice(0, candidateLimit)) {
      const existing = candidateMap.get(item.node.id)
      if (existing) {
        existing.semanticScore = item.score
      } else {
        candidateMap.set(item.node.id, {
          node: item.node,
          lexicalScore: 0,
          semanticScore: item.score
        })
      }
    }

    const combined = Array.from(candidateMap.values())
      .map((item) => {
        const overlapBoost = item.lexicalScore > 0 && item.semanticScore > 0 ? 0.05 : 0
        const docSupportBoost = (docLexicalSupport.get(item.node.docId) || 0) * 0.12
        return {
          node: item.node,
          score: (item.lexicalScore * this.lexicalWeight) + (item.semanticScore * this.semanticWeight) + overlapBoost + docSupportBoost
        }
      })
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score
        }
        return a.node.id.localeCompare(b.node.id)
      })

    if (combined.length === 0 || combined.every((item) => item.score <= 0)) {
      return lexicalNodes.slice(0, topK)
    }

    return this.selectDiverseScoredNodes(combined, topK)
  }

  private selectDiverseScoredNodes(scored: Array<{ node: Node; score: number }>, topK: number): Node[] {
    const selected: Node[] = []
    const pool = scored.map((item) => ({ ...item }))
    const docCounts = new Map<string, number>()
    const sectionCounts = new Map<string, number>()
    const docBaseScores = new Map<string, number>()

    for (const item of scored) {
      const current = docBaseScores.get(item.node.docId) || Number.NEGATIVE_INFINITY
      if (item.score > current) {
        docBaseScores.set(item.node.docId, item.score)
      }
    }

    while (selected.length < topK && pool.length > 0) {
      let bestIndex = 0
      let bestScore = Number.NEGATIVE_INFINITY

      for (let index = 0; index < pool.length; index++) {
        const item = pool[index]
        const docBoost = (docBaseScores.get(item.node.docId) || 0) * 0.25
        const docPenalty = (docCounts.get(item.node.docId) || 0) * 0.75
        const sectionPenalty = (sectionCounts.get(item.node.parent || '') || 0) * 1
        const adjustedScore = item.score + docBoost - docPenalty - sectionPenalty

        if (adjustedScore > bestScore) {
          bestScore = adjustedScore
          bestIndex = index
          continue
        }

        if (adjustedScore === bestScore && item.node.id.localeCompare(pool[bestIndex].node.id) < 0) {
          bestIndex = index
        }
      }

      const [chosen] = pool.splice(bestIndex, 1)
      if (!chosen) {
        break
      }
      if (chosen.score <= 0 && selected.length > 0) {
        break
      }

      selected.push(chosen.node)
      docCounts.set(chosen.node.docId, (docCounts.get(chosen.node.docId) || 0) + 1)
      sectionCounts.set(chosen.node.parent || '', (sectionCounts.get(chosen.node.parent || '') || 0) + 1)
    }

    return selected
  }

  private async hydrateCollectionEmbeddings(collection: Collection): Promise<void> {
    const chunkNodes = this.getChunkNodes(collection)
    const missing = chunkNodes.filter((node) => !node.embedding || node.embedding.length === 0)
    if (missing.length === 0) {
      return
    }

    const vectors = await this.embedTextsCached(missing.map((node) => node.text))
    for (let index = 0; index < missing.length; index++) {
      missing[index].embedding = vectors[index] ? [...vectors[index]] : undefined
    }
  }

  private clearCollectionEmbeddings(collection: Collection): void {
    for (const node of this.getChunkNodes(collection)) {
      node.embedding = undefined
    }
  }

  private getChunkNodes(collection: Collection): Node[] {
    return Array.from(collection.getAllNodes().values())
      .filter((node) => node.depth === 2)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  private computeCollectionCentroid(collection: Collection): number[] {
    const vectors = this.getChunkNodes(collection)
      .map((node) => node.embedding || [])
      .filter((embedding) => embedding.length > 0)

    if (vectors.length === 0) {
      return []
    }

    const dimension = vectors[0].length
    const centroid = new Array<number>(dimension).fill(0)

    for (const vector of vectors) {
      for (let index = 0; index < dimension; index++) {
        centroid[index] += vector[index]
      }
    }

    let norm = 0
    for (let index = 0; index < dimension; index++) {
      centroid[index] /= vectors.length
      norm += centroid[index] * centroid[index]
    }

    if (norm === 0) {
      return centroid
    }

    const scale = 1 / Math.sqrt(norm)
    return centroid.map((value) => value * scale)
  }

  private async embedQuery(question: string): Promise<number[]> {
    const [embedding] = await this.embedTextsCached([question])
    return embedding || []
  }

  private async embedTextsCached(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length)
    const missingTexts: string[] = []
    const missingIndices: number[] = []

    for (let index = 0; index < texts.length; index++) {
      const text = texts[index]
      const cacheKey = `${this.getEmbeddingSignature()}::${text}`
      const cached = this.embeddingCache.get(cacheKey)
      if (cached) {
        results[index] = [...cached]
      } else {
        missingTexts.push(text)
        missingIndices.push(index)
      }
    }

    if (missingTexts.length > 0) {
      const generated = await embedTexts(missingTexts, this.getEmbeddingOptions())
      for (let index = 0; index < generated.length; index++) {
        const vector = generated[index] ? [...generated[index]] : []
        const originalIndex = missingIndices[index]
        const cacheKey = `${this.getEmbeddingSignature()}::${texts[originalIndex]}`
        this.embeddingCache.set(cacheKey, vector)
        results[originalIndex] = [...vector]
      }
    }

    return results.map((vector) => vector || [])
  }

  private getEmbeddingOptions(): Parameters<typeof embedTexts>[1] {
    const openAIApiKey = this.openAIApiKey ?? process.env.OPENAI_API_KEY ?? process.env.MISTRAL_API_KEY
    const resolvedEmbeddingModel = this.provider === 'openai'
      ? (openAIApiKey ? resolveEmbeddingModel('openai', this.embeddingModel, this.openAIBaseUrl) : undefined)
      : (this.embeddingModel && (this.localEmbeddingUrl || this.localUrl) ? this.embeddingModel : undefined)

    return {
      provider: this.provider,
      embeddingModel: resolvedEmbeddingModel,
      dimensions: this.embeddingDimensions,
      timeoutMs: this.embeddingTimeoutMs,
      localUrl: this.localUrl,
      localEmbeddingUrl: this.localEmbeddingUrl,
      openAIBaseUrl: this.openAIBaseUrl,
      openAIApiKey
    }
  }

  private getEmbeddingSignature(): string {
    const options = this.getEmbeddingOptions()
    return [
      options.provider || 'local',
      options.embeddingModel || 'deterministic',
      options.dimensions || DEFAULT_EMBEDDING_DIMENSIONS
    ].join(':')
  }

  private normalizeSemanticScore(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return 0
    }
    return value
  }

  private async retrieveAcrossCollections(
    collectionIds: string[],
    question: string,
    topKPerCollection: number
  ): Promise<Node[]> {
    const combined: Node[] = []
    const seen = new Set<string>()

    for (const collectionId of collectionIds) {
      const chunks = await this.retrieve(collectionId, question, topKPerCollection)
      for (const chunk of chunks) {
        if (seen.has(chunk.id)) {
          continue
        }
        seen.add(chunk.id)
        combined.push(chunk)
      }
    }

    return combined
  }

  private resolveSectionTitle(collection: Collection, chunk: Node): string {
    if (!chunk.parent) {
      return ''
    }

    const sectionNode = collection.getNode(chunk.parent)
    if (!sectionNode) {
      return ''
    }

    return sectionNode.text.trim()
  }

  private resolveMaxTokens(): number {
    return this.maxTokens ?? Math.max(64, Math.min(1024, Math.floor(this.maxContextChars / 4)))
  }

  private normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (value === undefined) {
      return fallback
    }
    if (!Number.isInteger(value) || value < 1) {
      throw new Error('Value must be an integer >= 1')
    }
    return value
  }

  private normalizeMinRouteScore(value: number | undefined, fallback: number): number {
    if (value === undefined) {
      return fallback
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('minRouteScore must be a number >= 0')
    }
    return value
  }

  private slugify(input: string): string {
    const normalized = input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')

    return normalized || 'general'
  }

  private routeFileToCollection(
    rootPath: string,
    filePath: string,
    defaultCollectionId: string
  ): { collectionId: string; reason: string } {
    const relativeFile = this.normalizePath(path.relative(rootPath, filePath))

    const orderedRules = this.routingRules
      .map((rule, index) => ({ rule, index }))
      .sort((a, b) => {
        const priorityA = a.rule.priority ?? 0
        const priorityB = b.rule.priority ?? 0
        if (priorityB !== priorityA) {
          return priorityB - priorityA
        }
        return a.index - b.index
      })

    for (const { rule } of orderedRules) {
      if (this.matchRule(rule.pattern, relativeFile)) {
        return {
          collectionId: this.slugify(rule.collectionId),
          reason: `rule:${rule.collectionId}`
        }
      }
    }

    const parts = relativeFile.split('/').filter((part) => part.length > 0)
    if (parts.length > 1) {
      return {
        collectionId: this.slugify(parts[0]),
        reason: `path:${parts[0]}`
      }
    }

    return {
      collectionId: defaultCollectionId,
      reason: 'default'
    }
  }

  private matchRule(pattern: RegExp, target: string): boolean {
    pattern.lastIndex = 0
    return pattern.test(target)
  }

  private normalizePath(input: string): string {
    return input.replace(/\\/g, '/')
  }

  private async collectMarkdownFiles(rootPath: string): Promise<string[]> {
    const rootStats = await stat(rootPath)
    if (rootStats.isFile()) {
      return rootPath.toLowerCase().endsWith('.md') ? [rootPath] : []
    }

    if (!rootStats.isDirectory()) {
      return []
    }

    const results: string[] = []
    await this.walkMarkdown(rootPath, results)
    return results
  }

  private async walkMarkdown(currentPath: string, results: string[]): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        await this.walkMarkdown(fullPath, results)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push(fullPath)
      }
    }
  }

  private serializeCollection(collection: Collection): CollectionSnapshot {
    const documents = Array.from(collection.getAllDocuments().values())
      .map((doc) => ({ id: doc.id, path: doc.path }))
      .sort((a, b) => a.id.localeCompare(b.id))

    const nodes = Array.from(collection.getAllNodes().values())
      .map((node) => ({
        ...node,
        children: [...node.children],
        tokens: [...node.tokens],
        embedding: node.embedding ? [...node.embedding] : undefined
      }))
      .sort((a, b) => {
        if (a.depth !== b.depth) {
          return a.depth - b.depth
        }
        return a.id.localeCompare(b.id)
      })

    const keywordIndex = Array.from(collection.getKeywordIndex().entries())
      .map(([token, nodeIds]) => ({ token, nodeIds: Array.from(nodeIds).sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => a.token.localeCompare(b.token))

    return {
      id: collection.getId(),
      documents,
      nodes,
      keywordIndex
    }
  }

  private restoreCollection(snapshot: CollectionSnapshot): void {
    const collection = this.createCollection(snapshot.id)

    for (const doc of snapshot.documents || []) {
      collection.addDocument(doc.id, doc.path)
    }

    const sortedNodes = [...(snapshot.nodes || [])].sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth
      }
      return a.id.localeCompare(b.id)
    })

    for (const node of sortedNodes) {
      collection.addNode({
        id: node.id,
        text: node.text,
        parent: node.parent,
        children: [],
        depth: node.depth,
        docId: node.docId,
        tokens: [...(node.tokens || [])],
        embedding: node.embedding ? [...node.embedding] : undefined
      })
    }

    for (const entry of snapshot.keywordIndex || []) {
      for (const nodeId of entry.nodeIds || []) {
        collection.addToKeywordIndex(entry.token, nodeId)
      }
    }
  }

  private buildCollectionToFiles(sourceFiles: SnapshotFileMeta[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>()

    for (const item of sourceFiles) {
      const list = grouped.get(item.collectionId)
      if (list) {
        list.push(item.path)
      } else {
        grouped.set(item.collectionId, [item.path])
      }
    }

    for (const [collectionId, files] of grouped.entries()) {
      files.sort((a, b) => a.localeCompare(b))
      grouped.set(collectionId, files)
    }

    return grouped
  }

  private sortSourceMetadata(): void {
    this.lastSourceFiles.sort((a, b) => {
      if (a.collectionId !== b.collectionId) {
        return a.collectionId.localeCompare(b.collectionId)
      }
      return a.path.localeCompare(b.path)
    })

    for (const [collectionId, files] of this.collectionToFiles.entries()) {
      const unique = Array.from(new Set(files)).sort((a, b) => a.localeCompare(b))
      this.collectionToFiles.set(collectionId, unique)
    }
  }

  private collectionSnapshotPath(snapshotDir: string, collectionId: string): string {
    const encodedId = encodeURIComponent(collectionId)
    return path.join(snapshotDir, `${encodedId}${SNAPSHOT_EXTENSION}`)
  }

  private resolveSnapshotDir(snapshotDir?: string): string {
    const rawPath = snapshotDir ?? this.snapshotDir ?? DEFAULT_SNAPSHOT_DIR
    if (!rawPath || rawPath.trim().length === 0) {
      throw new Error('snapshotDir must be a non-empty string')
    }
    return path.resolve(rawPath)
  }

  private async writeGzipJson(filePath: string, value: unknown): Promise<void> {
    try {
      const json = JSON.stringify(value)
      const compressed = await gzip(Buffer.from(json, 'utf8'))
      await writeFile(filePath, compressed)
    } catch {
      throw new Error(`Failed to write snapshot file: ${filePath}`)
    }
  }

  private async readGzipJson<T>(filePath: string): Promise<T> {
    try {
      const compressed = await readFile(filePath)
      const jsonBuffer = await gunzip(compressed)
      return JSON.parse(jsonBuffer.toString('utf8')) as T
    } catch {
      throw new Error(`Failed to read snapshot file: ${filePath}`)
    }
  }
}
