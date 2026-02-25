import { Collection } from './Collection'
import { ingest as ingestCollection } from './ingest'
import { query } from './query'
import { generateAnswer } from './generateAnswer'
import { callLLM, LLMProvider } from './callLLM'

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

export type CollectionStats = {
  documents: number
  sections: number
  chunks: number
  nodes: number
  keywords: number
}

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

  async ingest(collectionId: string, path: string): Promise<void> {
    const collection = this.collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }

    await ingestCollection(path, collection)
  }

  async ask(collectionId: string, question: string): Promise<string> {
    const prompt = await this.buildPrompt(collectionId, question)
    const maxTokens = this.maxTokens ?? Math.max(64, Math.min(1024, Math.floor(this.maxContextChars / 4)))
    return await callLLM(prompt, this.model, this.temperature, maxTokens, {
      provider: this.provider,
      localUrl: this.localUrl,
      openAIBaseUrl: this.openAIBaseUrl,
      openAIApiKey: this.openAIApiKey
    })
  }

  async retrieve(collectionId: string, question: string, topK: number = this.topK) {
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
}
