import type { MemoryCandidate, MemoryRecord } from './contracts.js'

export type MemoryConflictRelationV1 = 'duplicate' | 'conflict' | 'related'

/** One explainable relationship from a pending candidate to an active memory. */
export interface MemoryConflictRelationshipV1 {
  readonly memoryId: string
  readonly relation: MemoryConflictRelationV1
  readonly score: number
  readonly reason: 'exact-normalized-match' | 'same-kind-near-match' | 'lexical-overlap'
}

/** Current derived assessment; it is not a governance fact and may be recomputed. */
export interface MemoryConflictAssessmentV1 {
  readonly schemaVersion: 1
  readonly candidateId: string
  readonly evaluatedAt: string
  readonly relationships: readonly MemoryConflictRelationshipV1[]
}

/** Pure evaluator seam. Inputs have already passed Archive scope and visibility filters. */
export interface MemoryConflictEvaluator {
  evaluate(candidate: Readonly<MemoryCandidate>, active: readonly Readonly<MemoryRecord>[]): unknown
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

function units(value: string): Set<string> {
  const source = value.toLocaleLowerCase()
  const result = new Set(source.match(/[a-z0-9]{2,}/gu) ?? [])
  for (const sequence of source.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) result.add(sequence.slice(index, index + 2))
  }
  return result
}

function jaccard(left: string, right: string): number {
  const a = units(left)
  const b = units(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/** Conservative local baseline used before optional richer conflict adapters exist. */
export class DeterministicMemoryConflictEvaluator implements MemoryConflictEvaluator {
  evaluate(candidate: Readonly<MemoryCandidate>, active: readonly Readonly<MemoryRecord>[]): MemoryConflictRelationshipV1[] {
    const candidateNormalized = normalized(candidate.content)
    return active.flatMap((memory): MemoryConflictRelationshipV1[] => {
      const score = jaccard(candidate.content, memory.content)
      if (candidateNormalized === normalized(memory.content)) {
        return [{ memoryId: memory.id, relation: 'duplicate', score: 1, reason: 'exact-normalized-match' }]
      }
      if (candidate.memoryKind === memory.memoryKind && score >= 0.35) {
        const relation = candidate.memoryKind === 'episode' ? 'related' : 'conflict'
        return [{ memoryId: memory.id, relation, score, reason: 'same-kind-near-match' }]
      }
      if (score >= 0.2) return [{ memoryId: memory.id, relation: 'related', score, reason: 'lexical-overlap' }]
      return []
    }).toSorted((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId))
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('conflict relationship must be an object')
  return value as Record<string, unknown>
}

/** Validate evaluator output and discard IDs outside the Archive-selected active set. */
export function parseMemoryConflictRelationships(
  value: unknown,
  allowedMemoryIds: ReadonlySet<string>,
): MemoryConflictRelationshipV1[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('conflict evaluator output must be an array of at most 100 items')
  const seen = new Set<string>()
  const result: MemoryConflictRelationshipV1[] = []
  for (const item of value) {
    const input = record(item)
    const keys = Object.keys(input).toSorted()
    if (keys.join(',') !== ['memoryId', 'reason', 'relation', 'score'].toSorted().join(',')) {
      throw new TypeError('conflict relationship contains missing or unknown fields')
    }
    if (typeof input.memoryId !== 'string' || !allowedMemoryIds.has(input.memoryId) || seen.has(input.memoryId)) continue
    if (input.relation !== 'duplicate' && input.relation !== 'conflict' && input.relation !== 'related') {
      throw new TypeError('conflict relation is unsupported')
    }
    if (input.reason !== 'exact-normalized-match' && input.reason !== 'same-kind-near-match'
      && input.reason !== 'lexical-overlap') throw new TypeError('conflict reason is unsupported')
    if (typeof input.score !== 'number' || !Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
      throw new TypeError('conflict score must be from 0 through 1')
    }
    seen.add(input.memoryId)
    result.push({
      memoryId: input.memoryId,
      relation: input.relation,
      score: input.score,
      reason: input.reason,
    })
  }
  return result.toSorted((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId))
}
