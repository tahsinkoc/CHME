import { Node } from './Collection'
import { extractSentences, tokenizePlainText, tokenizeSearchText, truncateTextBlock } from './text'

type SentenceCandidate = {
  text: string
  docId: string
  sourceId: string
  baseScore: number
  rawTokenSet: Set<string>
}

export function synthesizeAnswer(
  question: string,
  nodes: Array<Pick<Node, 'id' | 'text' | 'docId'>>,
  maxChars: number
): string {
  if (maxChars <= 0 || nodes.length === 0) {
    return ''
  }

  const rawQuestionTokens = tokenizePlainText(question)
  const candidates = buildSentenceCandidates(question, nodes)
  if (candidates.length === 0) {
    return truncateTextBlock(nodes.map((node) => node.text).join(' '), maxChars)
  }

  const selected: string[] = []
  const coveredTokens = new Set<string>()
  const docCounts = new Map<string, number>()
  const seenTexts = new Set<string>()
  let usedChars = 0

  while (selected.length < candidates.length) {
    let bestIndex = -1
    let bestScore = Number.NEGATIVE_INFINITY

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]
      if (!candidate || seenTexts.has(candidate.text)) {
        continue
      }

      const uncoveredMatches = rawQuestionTokens.reduce((count, token) => {
        return count + (candidate.rawTokenSet.has(token) && !coveredTokens.has(token) ? 1 : 0)
      }, 0)
      const repeatedDocPenalty = (docCounts.get(candidate.docId) || 0) * 0.15
      const adjustedScore = candidate.baseScore + (uncoveredMatches * 4) - repeatedDocPenalty

      if (adjustedScore > bestScore) {
        bestIndex = index
        bestScore = adjustedScore
        continue
      }

      if (adjustedScore === bestScore && candidate.text.localeCompare(candidates[bestIndex]?.text || '') < 0) {
        bestIndex = index
      }
    }

    if (bestIndex < 0) {
      break
    }

    const candidate = candidates[bestIndex]
    if (!candidate) {
      break
    }

    const separator = selected.length === 0 ? 0 : 1
    const nextLength = usedChars + separator + candidate.text.length
    if (nextLength > maxChars) {
      if (selected.length === 0) {
        selected.push(truncateTextBlock(candidate.text, maxChars))
      }
      break
    }

    selected.push(candidate.text)
    seenTexts.add(candidate.text)
    usedChars = nextLength
    docCounts.set(candidate.docId, (docCounts.get(candidate.docId) || 0) + 1)

    for (const token of candidate.rawTokenSet) {
      coveredTokens.add(token)
    }
  }

  if (selected.length === 0) {
    return truncateTextBlock(candidates[0].text, maxChars)
  }

  return selected.join(' ').trim()
}

function buildSentenceCandidates(
  question: string,
  nodes: Array<Pick<Node, 'id' | 'text' | 'docId'>>
): SentenceCandidate[] {
  const rawQuestionTokens = tokenizePlainText(question)
  const searchQuestionTokens = tokenizeSearchText(question)
  const candidates: SentenceCandidate[] = []

  for (const node of nodes) {
    const sentences = extractSentences(node.text)
    const sourceSentences = sentences.length > 0 ? sentences : [node.text.trim()]

    for (const sentence of sourceSentences) {
      const trimmed = sentence.trim()
      if (!trimmed) {
        continue
      }

      const rawTokenSet = new Set(tokenizePlainText(trimmed))
      const searchTokenSet = new Set(tokenizeSearchText(trimmed))

      let rawMatches = 0
      let expandedMatches = 0

      for (const token of rawQuestionTokens) {
        if (rawTokenSet.has(token)) {
          rawMatches += 1
        }
      }

      for (const token of searchQuestionTokens) {
        if (searchTokenSet.has(token)) {
          expandedMatches += 1
        }
      }

      let baseScore = (rawMatches * 5) + expandedMatches
      if (/must enforce|include|failure modes|recovery starts/i.test(trimmed)) {
        baseScore += 2
      }
      if (/^step\s+\d+/i.test(trimmed)) {
        baseScore -= 3
      }
      if (trimmed.length > 320) {
        baseScore -= 1
      }

      candidates.push({
        text: trimmed,
        docId: node.docId,
        sourceId: node.id,
        baseScore,
        rawTokenSet
      })
    }
  }

  candidates.sort((a, b) => {
    if (b.baseScore !== a.baseScore) {
      return b.baseScore - a.baseScore
    }
    if (a.docId !== b.docId) {
      return a.docId.localeCompare(b.docId)
    }
    return a.sourceId.localeCompare(b.sourceId)
  })

  return candidates
}
