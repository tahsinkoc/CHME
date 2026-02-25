import { Collection } from './Collection'
import { ingest as ingestCollection } from './ingest'
import { query } from './query'
import { generateAnswer } from './generateAnswer'
import { callLLM } from './callLLM'

type MemoryEngineOptions = {
  model?: string
  topK?: number
  maxContextChars?: number
  temperature?: number
}

export class MemoryEngine {
  private collections: Map<string, Collection>
  private model: string
  private topK: number
  private maxContextChars: number
  private temperature: number

  constructor(options: MemoryEngineOptions = {}) {
    this.collections = new Map()
    this.model = options.model ?? 'gpt-3.5-turbo'
    this.topK = options.topK ?? 5
    this.maxContextChars = options.maxContextChars ?? 2000
    this.temperature = options.temperature ?? 0
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

  async ingest(collectionId: string, path: string): Promise<void> {
    const collection = this.collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }

    await ingestCollection(path, collection)
  }

  async ask(collectionId: string, question: string): Promise<string> {
    const collection = this.collections.get(collectionId)
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`)
    }

    await query(collection, question, this.topK)
    const prompt = await generateAnswer(collection, question, this.topK, this.maxContextChars)
    const maxTokens = Math.max(64, Math.min(1024, Math.floor(this.maxContextChars / 4)))
    return await callLLM(prompt, this.model, this.temperature, maxTokens)
  }

  setModel(model: string): void {
    this.model = model
  }

  setTopK(topK: number): void {
    this.topK = topK
  }

  setMaxContextChars(chars: number): void {
    this.maxContextChars = chars
  }

  setTemperature(temp: number): void {
    this.temperature = temp
  }
}
