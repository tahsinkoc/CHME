import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib'
import { promisify } from 'node:util'
import { Collection, Node } from './Collection'
import { ingest as ingestCollection, ingestFiles } from './ingest'
import { query } from './query'
import { generateAnswer } from './generateAnswer'
import { callLLM, LLMProvider } from './callLLM'

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
  routingRules: RoutingRuleSnapshot[]
  collections: string[]
  sourceFiles: SnapshotFileMeta[]
}

const SNAPSHOT_SCHEMA_VERSION = 1
const SNAPSHOT_EXTENSION = '.chme.json.gz'
const ENGINE_SNAPSHOT_FILE = `_engine${SNAPSHOT_EXTENSION}`
const DEFAULT_TOP_COLLECTIONS = 3
const DEFAULT_TOP_K_PER_COLLECTION = 3
const DEFAULT_MIN_ROUTE_SCORE = 1

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with',
  'this', 'these', 'those', 'or', 'if', 'then', 'than', 'but', 'not', 'no', 'yes', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'me', 'my', 'mine', 'them',
  'his', 'her', 'hers', 'who', 'whom', 'what', 'which', 'when', 'where', 'why', 'how', 'into', 'out', 'up', 'down', 'over', 'under', 'again', 'further', 'once'
])

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
  private routingRules: RoutingRule[]
  private routingReport: RoutingReport
  private minRouteScore: number
  private lastSourceRootPath?: string
  private lastDefaultCollectionId: string
  private lastSourceFiles: SnapshotFileMeta[]
  private collectionToFiles: Map<string, string[]>

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
    this.routingRules = []
    this.routingReport = { lastIngestAssignments: [] }
    this.minRouteScore = DEFAULT_MIN_ROUTE_SCORE
    this.lastSourceRootPath = undefined
    this.lastDefaultCollectionId = 'general'
    this.lastSourceFiles = []
    this.collectionToFiles = new Map()

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

    const queryTokens = this.tokenize(question)

    const scored = Array.from(this.collections.entries())
      .map(([collectionId, collection]) => {
        let score = 0
        const keywordIndex = collection.getKeywordIndex()
        for (const token of queryTokens) {
          if (keywordIndex.has(token)) {
            score += 1
          }
        }
        return { collectionId, score }
      })
      .sort((a, b) => {
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

  async retrieve(collectionId: string, question: string, topK: number = this.topK): Promise<Node[]> {
    const collection = this.collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }
    return await query(collection, question, topK)
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
    return await generateAnswer(collection, question, topK, maxContextChars)
  }

  async saveSnapshots(snapshotDir: string): Promise<SnapshotSaveReport> {
    const absoluteSnapshotDir = path.resolve(snapshotDir)
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

  async loadSnapshots(snapshotDir: string, options: SnapshotLoadOptions = {}): Promise<SnapshotLoadReport> {
    const absoluteSnapshotDir = path.resolve(snapshotDir)
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

    let collectionsLoaded = 0
    for (const collectionId of manifest.collections || []) {
      const snapshotPath = this.collectionSnapshotPath(absoluteSnapshotDir, collectionId)
      const snapshot = await this.readGzipJson<CollectionSnapshot>(snapshotPath)
      this.restoreCollection(snapshot)
      collectionsLoaded += 1
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
  }

  setLocalUrl(url: string): void {
    if (!url || url.trim().length === 0) {
      throw new Error('localUrl must be a non-empty string')
    }
    this.localUrl = url
  }

  setOpenAIBaseUrl(url: string): void {
    if (!url || url.trim().length === 0) {
      throw new Error('openAIBaseUrl must be a non-empty string')
    }
    this.openAIBaseUrl = url
  }

  setOpenAIApiKey(apiKey: string): void {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('openAIApiKey must be a non-empty string')
    }
    this.openAIApiKey = apiKey
  }

  private async askScoped(collectionId: string, question: string): Promise<string> {
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
        const sectionTitle = this.resolveSectionTitle(collection, chunk)
        const heading = sectionTitle ? `## ${sectionTitle}` : '## Section'
        blocks.push(`### Collection: ${collectionId}\n${heading}\n${chunk.text}`)
      }
    }

    return this.fitBlocksToLimit(blocks, maxContextChars)
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

  private fitBlocksToLimit(blocks: string[], maxChars: number): string {
    if (maxChars <= 0 || blocks.length === 0) {
      return ''
    }

    const selected: string[] = []
    let used = 0

    for (const block of blocks) {
      const separator = selected.length === 0 ? 0 : 2
      const nextSize = used + separator + block.length
      if (nextSize <= maxChars) {
        if (separator > 0) {
          used += separator
        }
        selected.push(block)
        used += block.length
        continue
      }

      if (selected.length === 0) {
        const truncated = this.truncateBlockBySentence(block, maxChars)
        if (truncated.length > 0) {
          selected.push(truncated)
        }
      }
      break
    }

    return selected.join('\n\n')
  }

  private truncateBlockBySentence(block: string, maxChars: number): string {
    if (block.length <= maxChars) {
      return block
    }

    const clipped = block.slice(0, maxChars)
    const sentenceBreak = this.findLastSentenceBreak(clipped)
    if (sentenceBreak > 0) {
      return clipped.slice(0, sentenceBreak).trimEnd()
    }

    const newlineBreak = clipped.lastIndexOf('\n')
    if (newlineBreak > 0) {
      return clipped.slice(0, newlineBreak).trimEnd()
    }

    const wordBreak = clipped.lastIndexOf(' ')
    if (wordBreak > 0) {
      return clipped.slice(0, wordBreak).trimEnd()
    }

    return clipped.trimEnd()
  }

  private findLastSentenceBreak(text: string): number {
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i]
      if (ch === '.' || ch === '!' || ch === '?') {
        return i + 1
      }
    }
    return -1
  }

  private tokenize(input: string): string[] {
    const cleaned = input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    const parts = cleaned.split(/\s+/)
    const unique = new Set<string>()

    for (const part of parts) {
      if (!part) {
        continue
      }
      if (STOPWORDS.has(part)) {
        continue
      }
      unique.add(part)
    }

    return Array.from(unique)
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

  private async writeGzipJson(filePath: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value)
    const compressed = await gzip(Buffer.from(json, 'utf8'))
    await writeFile(filePath, compressed)
  }

  private async readGzipJson<T>(filePath: string): Promise<T> {
    const compressed = await readFile(filePath)
    const jsonBuffer = await gunzip(compressed)
    return JSON.parse(jsonBuffer.toString('utf8')) as T
  }
}
