const DEFAULT_MODEL = 'qwen2.5:7b'
const DEFAULT_TEMPERATURE = 0
const DEFAULT_MAX_TOKENS = 300
const DEFAULT_TIMEOUT_MS = 30000

export type LLMProvider = 'local' | 'openai'

export type LLMCallOptions = {
  provider?: LLMProvider
  localUrl?: string
  openAIBaseUrl?: string
  openAIApiKey?: string
  timeoutMs?: number
}

export async function callLLM(
  prompt: string,
  model: string = DEFAULT_MODEL,
  temperature: number = DEFAULT_TEMPERATURE,
  maxTokens: number = DEFAULT_MAX_TOKENS,
  options: LLMCallOptions = {}
): Promise<string> {
  try {
    const provider = (options.provider || process.env.LLM_PROVIDER || 'local').toLowerCase()
    if (provider === 'local') {
      return await callLocalModel(prompt, model, temperature, maxTokens, options)
    }
    return await callOpenAICompatible(prompt, model, temperature, maxTokens, options)
  } catch {
    return ''
  }
}

async function callOpenAICompatible(
  prompt: string,
  model: string,
  temperature: number,
  maxTokens: number,
  options: LLMCallOptions
): Promise<string> {
  const baseUrl = (options.openAIBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = options.openAIApiKey ?? process.env.OPENAI_API_KEY ?? ''

  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      messages: [{ role: 'user', content: prompt }]
    })
  }, options.timeoutMs)

  if (!response.ok) {
    return ''
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> }; text?: string }>
  }

  const first = data.choices?.[0]
  if (!first) {
    return ''
  }

  if (typeof first.message?.content === 'string') {
    return first.message.content.trim()
  }

  if (Array.isArray(first.message?.content)) {
    return first.message.content.map((p) => p.text || '').join('').trim()
  }

  if (typeof first.text === 'string') {
    return first.text.trim()
  }

  return ''
}

async function callLocalModel(
  prompt: string,
  model: string,
  temperature: number,
  maxTokens: number,
  options: LLMCallOptions
): Promise<string> {
  const url = options.localUrl || process.env.LOCAL_LLM_URL || 'http://localhost:11434/api/generate'

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      prompt,
      temperature,
      max_tokens: maxTokens,
      num_predict: maxTokens,
      stream: false
    })
  }, options.timeoutMs)

  if (!response.ok) {
    return ''
  }

  const data = await response.json() as {
    response?: string
    text?: string
    choices?: Array<{ text?: string; message?: { content?: string } }>
  }

  if (typeof data.response === 'string') {
    return data.response.trim()
  }

  if (typeof data.text === 'string') {
    return data.text.trim()
  }

  const first = data.choices?.[0]
  if (!first) {
    return ''
  }

  if (typeof first.message?.content === 'string') {
    return first.message.content.trim()
  }

  if (typeof first.text === 'string') {
    return first.text.trim()
  }

  return ''
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}
