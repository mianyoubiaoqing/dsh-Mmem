import type {
  AdvancedRecallProviderPlanV1,
  AdvancedRecallProviderSource,
  RecallIndexHitV1,
  RecallIndexProvider,
  RecallIndexRecordV1,
  RecallIndexRequestV1,
} from './retrieval.js'

export type AdvancedRetrievalCapabilityV1 = 'page-index' | 'graph-relations'
export type AdvancedRetrievalDataBoundaryV1 = 'local-process' | 'remote'
export type AdvancedRetrievalModeV1 = 'disabled' | 'shadow' | 'opt-in'

export interface PageIndexPageV1 {
  readonly schemaVersion: 1
  readonly pageId: string
  readonly memoryKind: RecallIndexRecordV1['memoryKind']
  readonly memoryIds: readonly string[]
  readonly entries: readonly RecallIndexRecordV1[]
}

export interface PageIndexSearchRequestV1 {
  readonly schemaVersion: 1
  readonly query: string
  readonly pages: readonly PageIndexPageV1[]
}

export interface GraphRelationshipNodeV1 extends RecallIndexRecordV1 {
  readonly nodeId: string
}

export interface GraphRelationshipEdgeV1 {
  readonly schemaVersion: 1
  readonly fromMemoryId: string
  readonly toMemoryId: string
  readonly relation: 'same-kind'
}

export interface GraphRelationshipSearchRequestV1 {
  readonly schemaVersion: 1
  readonly query: string
  readonly nodes: readonly GraphRelationshipNodeV1[]
  readonly edges: readonly GraphRelationshipEdgeV1[]
}

interface AdvancedAdapterOptions<Request> {
  readonly id: string
  readonly version: string
  readonly dataBoundary: AdvancedRetrievalDataBoundaryV1
  readonly search: (request: Request, signal: AbortSignal) => Promise<unknown> | unknown
}

/** Narrow advanced adapter consumed by the governed registry. */
export interface AdvancedRecallAdapterV1 extends RecallIndexProvider {
  readonly capability: AdvancedRetrievalCapabilityV1
  readonly dataBoundary: AdvancedRetrievalDataBoundaryV1
}

function validateIdentity(id: string, version: string): void {
  if (id.trim() === '' || version.trim() === '') {
    throw new TypeError('advanced retrieval Adapter identity must be non-empty')
  }
}

/** Groups the already-governed projection into stable memory-kind pages. */
export class PageIndexRecallAdapter implements AdvancedRecallAdapterV1 {
  readonly capability = 'page-index' as const
  readonly id: string
  readonly version: string
  readonly dataBoundary: AdvancedRetrievalDataBoundaryV1
  readonly #search: AdvancedAdapterOptions<PageIndexSearchRequestV1>['search']

  constructor(options: AdvancedAdapterOptions<PageIndexSearchRequestV1>) {
    validateIdentity(options.id, options.version)
    this.id = options.id
    this.version = options.version
    this.dataBoundary = options.dataBoundary
    this.#search = options.search
  }

  query(request: RecallIndexRequestV1, signal: AbortSignal): Promise<unknown> | unknown {
    const byKind = new Map<RecallIndexRecordV1['memoryKind'], RecallIndexRecordV1[]>()
    for (const record of request.records) {
      const records = byKind.get(record.memoryKind) ?? []
      records.push(record)
      byKind.set(record.memoryKind, records)
    }
    const pages = [...byKind.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([memoryKind, entries]) => ({
        schemaVersion: 1 as const,
        pageId: `memory-kind:${memoryKind}`,
        memoryKind,
        memoryIds: entries.map(entry => entry.id),
        entries,
      }))
    return this.#search({ schemaVersion: 1, query: request.query, pages }, signal)
  }
}

/** Builds a disposable local graph from the already-governed projection. */
export class GraphRelationshipRecallAdapter implements AdvancedRecallAdapterV1 {
  readonly capability = 'graph-relations' as const
  readonly id: string
  readonly version: string
  readonly dataBoundary: AdvancedRetrievalDataBoundaryV1
  readonly #search: AdvancedAdapterOptions<GraphRelationshipSearchRequestV1>['search']

  constructor(options: AdvancedAdapterOptions<GraphRelationshipSearchRequestV1>) {
    validateIdentity(options.id, options.version)
    this.id = options.id
    this.version = options.version
    this.dataBoundary = options.dataBoundary
    this.#search = options.search
  }

  query(request: RecallIndexRequestV1, signal: AbortSignal): Promise<unknown> | unknown {
    const nodes = request.records.map(record => ({ ...record, nodeId: record.id }))
    const edges: GraphRelationshipEdgeV1[] = []
    const previousByKind = new Map<RecallIndexRecordV1['memoryKind'], string>()
    for (const node of nodes) {
      const previous = previousByKind.get(node.memoryKind)
      if (previous !== undefined) {
        edges.push({
          schemaVersion: 1,
          fromMemoryId: previous,
          toMemoryId: node.id,
          relation: 'same-kind',
        })
      }
      previousByKind.set(node.memoryKind, node.id)
    }
    return this.#search({ schemaVersion: 1, query: request.query, nodes, edges }, signal)
  }
}

export interface AdvancedRetrievalConfigurationV1 {
  readonly mode: AdvancedRetrievalModeV1
  readonly ownerConfirmed: boolean
  readonly timeoutMs: number
  readonly weight: number
}

interface RegisteredAdapter {
  readonly adapter: AdvancedRecallAdapterV1
  configuration: AdvancedRetrievalConfigurationV1
}

const DISABLED_CONFIGURATION: AdvancedRetrievalConfigurationV1 = {
  mode: 'disabled',
  ownerConfirmed: false,
  timeoutMs: 500,
  weight: 1,
}

/** Owns fail-closed activation policy; registering an Adapter never enables it. */
export class AdvancedRetrievalRegistry implements AdvancedRecallProviderSource {
  readonly #registered = new Map<string, RegisteredAdapter>()

  register(adapter: AdvancedRecallAdapterV1): () => void {
    validateIdentity(adapter.id, adapter.version)
    if (this.#registered.has(adapter.id)) {
      throw new Error(`duplicate advanced retrieval Adapter ${JSON.stringify(adapter.id)}`)
    }
    const registered = { adapter, configuration: DISABLED_CONFIGURATION }
    this.#registered.set(adapter.id, registered)
    return () => {
      if (this.#registered.get(adapter.id) === registered) this.#registered.delete(adapter.id)
    }
  }

  configure(id: string, configuration: AdvancedRetrievalConfigurationV1): void {
    const registered = this.#registered.get(id)
    if (registered === undefined) throw new Error(`unknown advanced retrieval Adapter ${JSON.stringify(id)}`)
    if (!Number.isSafeInteger(configuration.timeoutMs)
      || configuration.timeoutMs < 10 || configuration.timeoutMs > 5_000) {
      throw new TypeError('advanced retrieval timeoutMs must be an integer from 10 through 5000')
    }
    if (!Number.isFinite(configuration.weight) || configuration.weight <= 0) {
      throw new TypeError('advanced retrieval weight must be a positive finite number')
    }
    if (configuration.mode === 'opt-in' && !configuration.ownerConfirmed) {
      throw new Error('Owner confirmation is required for advanced retrieval opt-in')
    }
    if (configuration.mode !== 'disabled' && registered.adapter.dataBoundary === 'remote') {
      throw new Error('remote advanced retrieval is disabled in RC.6')
    }
    registered.configuration = { ...configuration }
  }

  plans(): readonly AdvancedRecallProviderPlanV1[] {
    return [...this.#registered.values()].flatMap(({ adapter, configuration }) => {
      if (configuration.mode === 'disabled') return []
      return [{
        provider: adapter,
        capability: adapter.capability,
        mode: configuration.mode,
        timeoutMs: configuration.timeoutMs,
        weight: configuration.weight,
      }]
    })
  }
}

export type { RecallIndexHitV1 }
