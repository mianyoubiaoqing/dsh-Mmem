import type {
  MemoryRecallSnapshotV1,
  MemoryRecord,
  MemoryRetrievalRequestV1,
} from './contracts.js'

/** Minimal confirmed projection supplied only after Archive hard filters. */
export interface RecallIndexRecordV1 {
  readonly id: string
  readonly content: string
  readonly memoryKind: MemoryRecord['memoryKind']
  readonly createdAt: string
  readonly recordedAt: string
}

export interface RecallIndexRequestV1 {
  readonly schemaVersion: 1
  readonly query: string
  readonly records: readonly RecallIndexRecordV1[]
}

export interface RecallIndexHitV1 {
  readonly memoryId: string
  readonly score: number
  readonly reason: string
}

/** Derived index seam. Providers never receive the Archive or trusted context. */
export interface RecallIndexProvider {
  readonly id: string
  readonly version: string
  query(request: RecallIndexRequestV1, signal: AbortSignal): Promise<unknown> | unknown
}

export interface AdvancedRecallProviderPlanV1 {
  readonly provider: RecallIndexProvider
  readonly capability: 'page-index' | 'graph-relations'
  readonly mode: 'shadow' | 'opt-in'
  readonly timeoutMs: number
  readonly weight: number
}

/** Dynamic, policy-owning source implemented by the optional advanced registry. */
export interface AdvancedRecallProviderSource {
  plans(): readonly AdvancedRecallProviderPlanV1[]
}

function tokens(value: string): string[] {
  const normalized = value.toLocaleLowerCase()
  const result: string[] = [...(normalized.match(/[a-z0-9]{2,}/gu) ?? [])]
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) result.push(sequence.slice(index, index + 2))
  }
  return result
}

/** Stable local BM25 implementation shared by async retrieval and sync compatibility recall. */
export function bm25RecallHits(records: readonly RecallIndexRecordV1[], query: string): RecallIndexHitV1[] {
  const queryTokens = [...new Set(tokens(query))]
  if (queryTokens.length === 0) {
    return [...records]
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((record, index) => ({
      memoryId: record.id,
      score: 1 / (index + 1),
      reason: 'recent-active',
      }))
  }
  const documents = records.map(record => tokens(record.content))
  const averageLength = documents.length === 0
    ? 1
    : documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1
  const k1 = 1.2
  const b = 0.75
  const hits: RecallIndexHitV1[] = []
  for (const [index, record] of records.entries()) {
    const document = documents[index] ?? []
    const frequencies = new Map<string, number>()
    for (const token of document) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    let score = 0
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0
      if (frequency === 0) continue
      const documentFrequency = documents.filter(candidate => candidate.includes(token)).length
      const inverseDocumentFrequency = Math.log(1 + (records.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
      score += inverseDocumentFrequency * (frequency * (k1 + 1))
        / (frequency + k1 * (1 - b + b * document.length / averageLength))
    }
    if (score > 0) hits.push({ memoryId: record.id, score, reason: 'bm25-term-match' })
  }
  return hits.toSorted((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId))
}

export class Bm25RecallIndexProvider implements RecallIndexProvider {
  readonly id = 'mistymoon-bm25'
  readonly version = '1'

  query(request: RecallIndexRequestV1): RecallIndexHitV1[] {
    return bm25RecallHits(request.records, request.query)
  }
}

function parseHits(value: unknown, allowed: ReadonlySet<string>): RecallIndexHitV1[] {
  if (!Array.isArray(value) || value.length > 2_000) throw new TypeError('recall index output must be a bounded array')
  const byId = new Map<string, RecallIndexHitV1>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new TypeError('recall index hit must be an object')
    const hit = item as Record<string, unknown>
    if (Object.keys(hit).toSorted().join(',') !== ['memoryId', 'reason', 'score'].toSorted().join(',')) {
      throw new TypeError('recall index hit contains missing or unknown fields')
    }
    if (typeof hit.memoryId !== 'string' || !allowed.has(hit.memoryId)) continue
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score) || hit.score < 0) {
      throw new TypeError('recall index score must be a non-negative finite number')
    }
    if (typeof hit.reason !== 'string' || hit.reason.trim() === '' || hit.reason.length > 128) {
      throw new TypeError('recall index reason must be a bounded non-empty string')
    }
    const canonical = { memoryId: hit.memoryId, score: hit.score, reason: hit.reason.trim() }
    const existing = byId.get(hit.memoryId)
    if (existing === undefined || canonical.score > existing.score) byId.set(hit.memoryId, canonical)
  }
  return [...byId.values()]
}

/** Provider fusion plus authoritative ID backcheck and final projection budgeting. */
export class MemoryRetrievalEngine {
  readonly #providers: readonly RecallIndexProvider[]
  readonly #advancedProviderSource: AdvancedRecallProviderSource | undefined

  constructor(options: {
    readonly additionalProviders?: readonly RecallIndexProvider[]
    readonly advancedProviderSource?: AdvancedRecallProviderSource
  } = {}) {
    this.#providers = [new Bm25RecallIndexProvider(), ...(options.additionalProviders ?? [])]
    this.#advancedProviderSource = options.advancedProviderSource
    const identities = new Set<string>()
    for (const provider of this.#providers) {
      if (provider.id.trim() === '' || provider.version.trim() === '') throw new TypeError('recall Provider identity must be non-empty')
      if (identities.has(provider.id)) throw new Error(`duplicate recall Provider ${JSON.stringify(provider.id)}`)
      identities.add(provider.id)
    }
  }

  async retrieve(
    records: readonly MemoryRecord[],
    input: MemoryRetrievalRequestV1,
    createdAt: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MemoryRecallSnapshotV1> {
    const limit = input.limit ?? 8
    const maxCharacters = input.maxCharacters ?? 4_000
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) throw new TypeError('retrieval limit must be from 0 through 100')
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 100_000) {
      throw new TypeError('retrieval maxCharacters must be from 1 through 100000')
    }
    const projection = records.map(record => ({
      id: record.id,
      content: record.content,
      memoryKind: record.memoryKind,
      createdAt: record.createdAt,
      recordedAt: record.recordedAt,
    }))
    const allowed = new Set(records.map(record => record.id))
    const advanced = this.#advancedProviderSource?.plans() ?? []
    const executions = [
      ...this.#providers.map(provider => ({
        provider,
        mode: 'opt-in' as const,
        capability: undefined,
        timeoutMs: undefined,
        weight: 1,
      })),
      ...advanced,
    ]
    const settled = await Promise.all(executions.map(async execution => {
      const started = performance.now()
      const controller = new AbortController()
      const forwardAbort = (): void => controller.abort(signal.reason)
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', forwardAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      const timeout = execution.timeoutMs === undefined
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              const error = new Error(`recall Provider timed out after ${execution.timeoutMs}ms`)
              controller.abort(error)
              reject(error)
            }, execution.timeoutMs)
            timer.unref?.()
          })
      try {
        const providerRequest: RecallIndexRequestV1 = {
          schemaVersion: 1,
          query: input.query,
          records: projection.map(record => ({ ...record })),
        }
        const call = Promise.resolve(execution.provider.query(providerRequest, controller.signal))
        const value = timeout === undefined ? await call : await Promise.race([call, timeout])
        return {
          ...execution,
          status: 'completed' as const,
          latencyMs: performance.now() - started,
          hits: parseHits(value, allowed),
        }
      } catch {
        return {
          ...execution,
          status: (timedOut ? 'timed-out' : 'failed') as 'timed-out' | 'failed',
          latencyMs: performance.now() - started,
          hits: [] as RecallIndexHitV1[],
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', forwardAbort)
      }
    }))
    const fused = new Map<string, {
      score: number
      reasons: MemoryRecallSnapshotV1['items'][number]['reasons']
    }>()
    for (const result of settled) {
      if (result.status !== 'completed' || result.mode === 'shadow') continue
      for (const hit of result.hits) {
        const current = fused.get(hit.memoryId) ?? { score: 0, reasons: [] }
        current.score += hit.score * result.weight
        current.reasons.push({
          providerId: result.provider.id,
          providerVersion: result.provider.version,
          reason: hit.reason,
          score: hit.score,
        })
        fused.set(hit.memoryId, current)
      }
    }
    const byId = new Map(records.map(record => [record.id, record]))
    const ranked = [...fused]
      .flatMap(([memoryId, value]) => {
        const memory = byId.get(memoryId)
        return memory === undefined ? [] : [{
          memory,
          ...value,
          score: value.score * (memory.lifecycle?.rankMultiplier ?? 1),
        }]
      })
      .toSorted((left, right) => right.score - left.score || right.memory.createdAt.localeCompare(left.memory.createdAt))
    const items: MemoryRecallSnapshotV1['items'] = []
    let usedCharacters = 0
    for (const item of ranked) {
      if (items.length >= limit) break
      if (usedCharacters + item.memory.content.length > maxCharacters) continue
      usedCharacters += item.memory.content.length
      items.push({ memory: item.memory, score: item.score, reasons: item.reasons })
    }
    const baseline = new Set(
      settled.find(result => result.provider.id === 'mistymoon-bm25')?.hits.slice(0, limit).map(hit => hit.memoryId) ?? [],
    )
    const shadowComparisons = settled.flatMap(result => {
      if (result.mode !== 'shadow' || result.capability === undefined) return []
      const returnedMemoryIds = result.hits.slice(0, limit).map(hit => hit.memoryId)
      const overlap = returnedMemoryIds.filter(id => baseline.has(id)).length
      return [{
        providerId: result.provider.id,
        providerVersion: result.provider.version,
        capability: result.capability,
        status: result.status,
        latencyMs: result.latencyMs,
        overlapAtK: returnedMemoryIds.length === 0 ? 0 : overlap / returnedMemoryIds.length,
        returnedMemoryIds,
      }]
    })
    return {
      schemaVersion: 1,
      query: input.query,
      createdAt,
      items,
      ...(shadowComparisons.length === 0 ? {} : { shadowComparisons }),
    }
  }
}

export interface MemoryRetrievalEvaluationCaseV1 {
  readonly name: string
  readonly expectedMemoryIds: readonly string[]
  readonly forbiddenMemoryIds?: readonly string[]
  readonly run: () => Promise<MemoryRecallSnapshotV1>
}

export interface MemoryRetrievalEvaluationReportV1 {
  readonly schemaVersion: 1
  readonly caseCount: number
  readonly precisionAtK: number
  readonly criticalRecallRate: number
  readonly scopeLeakageCount: number
  readonly explanationCompleteness: number
  readonly p95LatencyMs: number
}

/** Run a neutral, caller-supplied evaluation suite without retaining query or memory payloads. */
export async function evaluateMemoryRetrieval(
  cases: readonly MemoryRetrievalEvaluationCaseV1[],
): Promise<MemoryRetrievalEvaluationReportV1> {
  if (cases.length === 0) throw new TypeError('memory retrieval evaluation requires at least one case')
  let relevantReturned = 0
  let returned = 0
  let criticalHits = 0
  let criticalTotal = 0
  let leakage = 0
  let explained = 0
  const latencies: number[] = []
  for (const testCase of cases) {
    const started = performance.now()
    const snapshot = await testCase.run()
    latencies.push(performance.now() - started)
    const expected = new Set(testCase.expectedMemoryIds)
    const forbidden = new Set(testCase.forbiddenMemoryIds ?? [])
    const returnedIds = snapshot.items.map(item => item.memory.id)
    returned += returnedIds.length
    relevantReturned += returnedIds.filter(id => expected.has(id)).length
    criticalTotal += expected.size
    criticalHits += [...expected].filter(id => returnedIds.includes(id)).length
    leakage += returnedIds.filter(id => forbidden.has(id)).length
    explained += snapshot.items.filter(item => item.reasons.length > 0
      && item.reasons.every(reason => reason.providerId !== '' && reason.reason !== '')).length
  }
  const sorted = latencies.toSorted((left, right) => left - right)
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  return {
    schemaVersion: 1,
    caseCount: cases.length,
    precisionAtK: returned === 0 ? 0 : relevantReturned / returned,
    criticalRecallRate: criticalTotal === 0 ? 1 : criticalHits / criticalTotal,
    scopeLeakageCount: leakage,
    explanationCompleteness: returned === 0 ? 1 : explained / returned,
    p95LatencyMs: sorted[p95Index] ?? 0,
  }
}
