const TOKEN_PREFIX_LENGTH = 7

export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with',
  'this', 'these', 'those', 'or', 'if', 'then', 'than', 'but', 'not', 'no', 'yes', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'me', 'my', 'mine', 'them',
  'his', 'her', 'hers', 'who', 'whom', 'what', 'which', 'when', 'where', 'why', 'how', 'into', 'out', 'up', 'down', 'over', 'under', 'again', 'further', 'once',
  'during', 'without', 'near'
])

export function tokenizePlainText(
  input: string,
  options: { dropStopwords?: boolean } = {}
): string[] {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  const parts = cleaned.split(/\s+/)
  const unique = new Set<string>()

  for (const part of parts) {
    if (!part) {
      continue
    }
    if (options.dropStopwords !== false && STOPWORDS.has(part)) {
      continue
    }
    unique.add(part)
  }

  return Array.from(unique)
}

export function tokenizeSearchText(input: string): string[] {
  const baseTokens = tokenizePlainText(input)
  const unique = new Set<string>()

  for (const token of baseTokens) {
    for (const form of expandSearchToken(token)) {
      unique.add(form)
    }
  }

  return Array.from(unique)
}

export function expandSearchToken(token: string): string[] {
  const cleaned = normalizeWord(token)
  if (!cleaned) {
    return []
  }

  const unique = new Set<string>()
  unique.add(cleaned)

  const normalized = normalizeSearchRoot(cleaned)
  if (normalized.length >= 3) {
    unique.add(normalized)
  }

  for (const value of [cleaned, normalized]) {
    if (value.length >= TOKEN_PREFIX_LENGTH + 1) {
      unique.add(value.slice(0, TOKEN_PREFIX_LENGTH))
    }
  }

  return Array.from(unique)
}

export function extractSentences(text: string): string[] {
  const normalized = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')

  if (!normalized) {
    return []
  }

  const parts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  return parts.length > 0 ? parts : [normalized]
}

export function fitTextBlocksToLimit(blocks: string[], maxChars: number): string {
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
      const truncated = truncateTextBlock(block, maxChars)
      if (truncated.length > 0) {
        selected.push(truncated)
      }
    }
    break
  }

  return selected.join('\n\n')
}

export function truncateTextBlock(block: string, maxChars: number): string {
  if (block.length <= maxChars) {
    return block
  }

  const clipped = block.slice(0, maxChars)
  const sentenceBreak = findLastSentenceBreak(clipped)
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

export function findLastSentenceBreak(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '.' || ch === '!' || ch === '?') {
      return i + 1
    }
  }
  return -1
}

function normalizeWord(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeSearchRoot(token: string): string {
  let value = token

  if (value.endsWith('ization') && value.length > 8) {
    value = `${value.slice(0, -7)}ize`
  } else if (value.endsWith('ation') && value.length > 7) {
    value = value.slice(0, -5)
  } else if (value.endsWith('tion') && value.length > 6) {
    value = value.slice(0, -4)
  } else if (value.endsWith('ment') && value.length > 6) {
    value = value.slice(0, -4)
  } else if (value.endsWith('ing') && value.length > 5) {
    value = value.slice(0, -3)
  } else if (value.endsWith('ied') && value.length > 5) {
    value = `${value.slice(0, -3)}y`
  } else if (value.endsWith('ies') && value.length > 5) {
    value = `${value.slice(0, -3)}y`
  } else if (value.endsWith('ed') && value.length > 4) {
    value = value.slice(0, -2)
  } else if (value.endsWith('es') && value.length > 4) {
    value = value.slice(0, -2)
  } else if (value.endsWith('s') && value.length > 3) {
    value = value.slice(0, -1)
  }

  while (value.length > 4 && /([a-z0-9])\1$/.test(value)) {
    value = value.slice(0, -1)
  }

  return value
}
