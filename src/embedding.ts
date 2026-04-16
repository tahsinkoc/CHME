import { LLMProvider } from './callLLM'

const DEFAULT_EMBEDDING_DIMENSIONS = 192
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30000
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_MISTRAL_EMBEDDING_MODEL = 'mistral-embed'

export type EmbeddingOptions = {
  provider?: LLMProvider
  embeddingModel?: string
  dimensions?: number
  localUrl?: string
  localEmbeddingUrl?: string
  openAIBaseUrl?: string
  openAIApiKey?: string
  timeoutMs?: number
}

export async function embedTexts(texts: string[], options: EmbeddingOptions = {}): Promise<number[][]> {
  if (texts.length === 0) {
    return []
  }

  const normalizedTexts = texts.map((text) => text || '')
  const provider = (options.provider || 'local').toLowerCase() === 'openai' ? 'openai' : 'local'
  const model = resolveEmbeddingModel(provider, options.embeddingModel, options.openAIBaseUrl)

  if (model) {
    try {
      if (provider === 'openai') {
        const vectors = await embedWithOpenAICompatible(normalizedTexts, model, options)
        if (vectors.length === normalizedTexts.length) {
          return vectors
        }
      } else {
        const vectors = await embedWithLocalProvider(normalizedTexts, model, options)
        if (vectors.length === normalizedTexts.length) {
          return vectors
        }
      }
    } catch {
      // Fall back to deterministic embeddings below.
    }
  }

  const dimensions = normalizeDimensions(options.dimensions)
  return normalizedTexts.map((text) => deterministicEmbedding(text, dimensions))
}

export async function embedText(text: string, options: EmbeddingOptions = {}): Promise<number[]> {
  const [vector] = await embedTexts([text], options)
  return vector || deterministicEmbedding(text || '', normalizeDimensions(options.dimensions))
}

export function deterministicEmbedding(text: string, dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(normalizeDimensions(dimensions)).fill(0)
  const features = extractFeatures(text)

  if (features.length === 0) {
    return vector
  }

  for (const feature of features) {
    let state = hashFeature(feature.value)
    for (let offset = 0; offset < 4; offset++) {
      state = mixHash(state + offset + 0x9e3779b9)
      const index = Math.abs(state) % vector.length
      const sign = ((state >>> 1) & 1) === 0 ? 1 : -1
      vector[index] += feature.weight * sign
    }
  }

  return normalizeVector(vector)
}

export function cosineSimilarity(left?: number[], right?: number[]): number {
  if (!left || !right || left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0
  }

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let index = 0; index < left.length; index++) {
    const a = left[index]
    const b = right[index]
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export function resolveEmbeddingModel(
  provider: LLMProvider,
  configuredModel: string | undefined,
  openAIBaseUrl: string | undefined
): string | undefined {
  if (configuredModel && configuredModel.trim().length > 0) {
    return configuredModel.trim()
  }

  if (provider !== 'openai') {
    return undefined
  }

  const baseUrl = (openAIBaseUrl || '').toLowerCase()
  if (baseUrl.includes('mistral.ai')) {
    return DEFAULT_MISTRAL_EMBEDDING_MODEL
  }

  return DEFAULT_OPENAI_EMBEDDING_MODEL
}

function normalizeDimensions(value: number | undefined): number {
  if (!value || !Number.isInteger(value) || value < 32) {
    return DEFAULT_EMBEDDING_DIMENSIONS
  }
  return value
}

async function embedWithOpenAICompatible(
  texts: string[],
  model: string,
  options: EmbeddingOptions
): Promise<number[][]> {
  const baseUrl = (options.openAIBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = options.openAIApiKey ?? process.env.OPENAI_API_KEY ?? process.env.MISTRAL_API_KEY ?? ''

  const response = await fetchWithTimeout(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      input: texts
    })
  }, options.timeoutMs)

  if (!response.ok) {
    throw new Error(`Embedding request failed: ${response.status}`)
  }

  const data = await response.json() as {
    data?: Array<{ embedding?: number[]; index?: number }>
  }

  const rows = [...(data.data || [])].sort((a, b) => (a.index || 0) - (b.index || 0))
  return rows.map((row) => normalizeVector(row.embedding || []))
}

async function embedWithLocalProvider(
  texts: string[],
  model: string,
  options: EmbeddingOptions
): Promise<number[][]> {
  const preferredUrl = options.localEmbeddingUrl || process.env.LOCAL_EMBEDDING_URL
  const derivedUrl = inferLocalEmbeddingUrl(options.localUrl || process.env.LOCAL_LLM_URL)
  const url = preferredUrl || derivedUrl || 'http://localhost:11434/api/embeddings'

  if (url.endsWith('/api/embed')) {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: texts
      })
    }, options.timeoutMs)

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status}`)
    }

    const data = await response.json() as {
      embeddings?: number[][]
    }

    return (data.embeddings || []).map((embedding) => normalizeVector(embedding || []))
  }

  const vectors: number[][] = []
  for (const text of texts) {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        prompt: text
      })
    }, options.timeoutMs)

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status}`)
    }

    const data = await response.json() as {
      embedding?: number[]
    }

    vectors.push(normalizeVector(data.embedding || []))
  }

  return vectors
}

function inferLocalEmbeddingUrl(localUrl: string | undefined): string | undefined {
  if (!localUrl || localUrl.trim().length === 0) {
    return undefined
  }

  if (localUrl.endsWith('/api/generate')) {
    return localUrl.replace(/\/api\/generate$/, '/api/embeddings')
  }

  return undefined
}

function extractFeatures(text: string): Array<{ value: string; weight: number }> {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  const tokens = normalized.split(/\s+/).filter((token) => token.length > 0)
  const counts = new Map<string, number>()

  for (const token of tokens) {
    counts.set(`tok:${token}`, (counts.get(`tok:${token}`) || 0) + 1)

    if (token.length >= 6) {
      for (let index = 0; index <= token.length - 3; index++) {
        const gram = token.slice(index, index + 3)
        counts.set(`tri:${gram}`, (counts.get(`tri:${gram}`) || 0) + 1)
      }
    }
  }

  for (let index = 0; index < tokens.length - 1; index++) {
    const bigram = `${tokens[index]}_${tokens[index + 1]}`
    counts.set(`bi:${bigram}`, (counts.get(`bi:${bigram}`) || 0) + 1)
  }

  return Array.from(counts.entries()).map(([value, count]) => ({
    value,
    weight: 1 + Math.log1p(count)
  }))
}

function hashFeature(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash | 0
}

function mixHash(value: number): number {
  let hash = value | 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b)
  hash ^= hash >>> 16
  return hash | 0
}

function normalizeVector(vector: number[]): number[] {
  if (vector.length === 0) {
    return vector
  }

  let norm = 0
  for (const value of vector) {
    norm += value * value
  }

  if (norm === 0) {
    return vector.map(() => 0)
  }

  const scale = 1 / Math.sqrt(norm)
  return vector.map((value) => value * scale)
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number = DEFAULT_EMBEDDING_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}
