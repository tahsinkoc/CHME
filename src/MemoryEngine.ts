import { Collection } from './Collection'
import { ingest as ingestCollection } from './ingest'
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

    const prompt = await generateAnswer(collection, question, this.topK, this.maxContextChars)
    const maxTokens = Math.max(64, Math.min(1024, Math.floor(this.maxContextChars / 4)))
    return await callLLM(prompt, this.model, this.temperature, maxTokens)
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
}
