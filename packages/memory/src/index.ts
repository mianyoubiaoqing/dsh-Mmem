/**
 * Durable companion memory for MistyMoon on DSH.
 * @module @mistymoon/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {
  CompanionMemoryArchive,
  ConfirmedMemoryImport,
  ConfirmedMemoryImportResult,
  ExtractedMemoryCandidateBatch,
  ExplicitMemoryObservation,
  MemoryCandidate,
  MemoryCandidateAssessment,
  MemoryCandidateDecision,
  MemoryCandidateList,
  MemoryCandidateProposal,
  MemoryCandidateRevision,
  MemoryForget,
  MemoryBatchGovernanceRequestV1,
  MemoryBatchGovernanceResultV1,
  MemoryGovernanceService,
  MemoryGovernanceAuditEntryV1,
  MemoryGovernanceAuditList,
  MemoryManagementQueryV1,
  MemoryManagementSnapshotV1,
  MemoryLifecycleApplyRequestV1,
  MemoryLifecycleApplyResultV1,
  MemoryLifecyclePlanRequestV1,
  MemoryLifecyclePlanV1,
  MemoryList,
  MemoryRecall,
  MemoryRecallSnapshotV1,
  MemoryRecord,
  MemoryReplace,
  MemoryRetrievalRequestV1,
  MemorySourceViewRequestV1,
  MemorySourceViewV1,
  MemoryVisibility,
} from './contracts.js'
import { DEFAULT_RECALL_LIMIT, loadMemoryRuntimeSettings } from './runtime-settings.js'
import {
  CandidateExtractionRegistry,
  extractMemoryCandidates,
  type CandidateExtractionRequestV1,
} from './candidate-extraction.js'
import { AdvancedRetrievalRegistry } from './advanced-retrieval.js'
import { DerivedMemoryViewRegistry, type DerivedMemoryViewInvalidator } from './lifecycle.js'
import {
  DeterministicMemoryConflictEvaluator,
  parseMemoryConflictRelationships,
  type MemoryConflictAssessmentV1,
  type MemoryConflictEvaluator,
} from './conflict.js'
import { bm25RecallHits, MemoryRetrievalEngine } from './retrieval.js'
import {
  canDiscloseMemory,
  isMemoryCurrentlyValid,
  memoryScopeEquals,
  memorySourceKey,
  parseMemoryAccessContextV1,
  validateMemoryValidity,
  type MemoryAccessContextV1,
  type MemoryKind,
  type MemoryObservationSourceKind,
  type MemoryObservationV1,
} from './domain.js'
import {
  MemoryArchiveError,
  MemoryArchiveStorage,
  type ArchiveInspection,
  type FoldedMemoryState,
  type MemoryCandidateResolutionEvent,
  type MemoryForgottenEvent,
  type MemoryLifecycleEvent,
  type SourceUse,
} from './storage/index.js'

export * from './contracts.js'
export * from './candidate-extraction.js'
export * from './conflict.js'
export * from './retrieval.js'
export * from './advanced-retrieval.js'
export * from './lifecycle.js'
export * from './domain.js'
export * from './runtime-settings.js'

/** Cordis plugin name and durable user-message source id. */
export const name = 'mistymoon-memory'

/** Agent pre-step waterfall used for durable memory projection. */
export const inject = ['agents', 'tools', 'mistymoonOwnerEligibility']

/** Memory plugin configuration. */
export interface Config {
  /** Private append-only JSONL path. */
  path: string
  /** Maximum memories included in one model-visible snapshot. */
  recallLimit?: number
  /** Optional private owner settings document read before each recall. */
  settingsPath?: string
  /** Maximum time to wait for the cross-process archive lease. */
  leaseTimeoutMs?: number
  /** Age after which an unrefreshed archive lease may be reclaimed. */
  leaseStaleMs?: number
  /** Maximum time dispose waits for already-started commits. */
  disposeTimeoutMs?: number
  /** Maximum accepted archive size before fail-closed quarantine. */
  maxArchiveBytes?: number
  /** Maximum accepted size of one transaction envelope. */
  maxTransactionBytes?: number
  /** Trusted local-channel policy; request text alone can never expand this value. */
  channelDisclosure?: MemoryAccessContextV1['channelDisclosure']
  /** Deadline for one optional post-response candidate extraction call. */
  extractionTimeoutMs?: number
}

/** Runtime schema for the memory plugin. */
export const Config: z<Config> = z.object({
  path: z.string().required(),
  recallLimit: z.number().step(1).min(1).max(20).default(DEFAULT_RECALL_LIMIT),
  settingsPath: z.string(),
  leaseTimeoutMs: z.number().step(1).min(100).max(60_000).default(30_000),
  leaseStaleMs: z.number().step(1).min(5_000).max(600_000).default(120_000),
  disposeTimeoutMs: z.number().step(1).min(100).max(60_000).default(5_000),
  maxArchiveBytes: z.number().step(1).min(1_048_576).max(1_073_741_824).default(67_108_864),
  maxTransactionBytes: z.number().step(1).min(1_024).max(16_777_216).default(1_048_576),
  channelDisclosure: z.union(['personal-only', 'owner-confidential']).default('personal-only'),
  extractionTimeoutMs: z.number().step(1).min(100).max(60_000).default(3_000),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Process-wide MistyMoon archive shared by tools and local governance UI. */
    mistymoonMemory: CompanionMemoryArchive
    /** Loopback-only governance facade; clients cannot select Owner or scope. */
    mistymoonMemoryGovernance: MemoryGovernanceService
    /** Optional post-response extraction Provider registry; zero providers is the safe default. */
    mistymoonMemoryCandidateExtraction: CandidateExtractionRegistry
    /** Optional advanced retrieval registry; all newly registered Adapters remain disabled. */
    mistymoonMemoryAdvancedRetrieval: AdvancedRetrievalRegistry
    /** Payload-free invalidation registry for disposable derived memory views. */
    mistymoonMemoryDerivedViews: DerivedMemoryViewRegistry
  }
}

/** Construction inputs for a private memory archive. */
export interface OpenMemoryArchiveOptions {
  path: string
  createId?: () => string
  now?: () => Date
  leaseTimeoutMs?: number
  leaseStaleMs?: number
  maxArchiveBytes?: number
  maxTransactionBytes?: number
  disposeTimeoutMs?: number
  /** Optional pure evaluator seam used by deterministic contract tests and local adapters. */
  conflictEvaluator?: MemoryConflictEvaluator
  /** Optional retrieval engine seam; defaults to local BM25 only. */
  retrievalEngine?: MemoryRetrievalEngine
  /** Optional ID-only invalidation seam for disposable indexes and summaries. */
  derivedViewInvalidator?: DerivedMemoryViewInvalidator
}

function explicitContent(text: string): string | undefined {
  const match = text.match(/(?:请|帮我)?记住[：:，,\s]*(.+)$/su)
  return match?.[1]?.trim() || undefined
}

function conflict(sourceMessageId: string): never {
  throw new MemoryArchiveError(
    `memory sourceMessageId ${JSON.stringify(sourceMessageId)} conflicts with an earlier command`,
    'MEMORY_SOURCE_CONFLICT',
  )
}

function cloneLifecyclePlan(plan: MemoryLifecyclePlanV1): MemoryLifecyclePlanV1 {
  if (plan.action.kind === 'consolidate') {
    return { ...plan, action: { ...plan.action, sourceMemoryIds: [...plan.action.sourceMemoryIds] } }
  }
  if (plan.action.kind === 'decay') {
    return { ...plan, action: { ...plan.action, changes: plan.action.changes.map(change => ({ ...change })) } }
  }
  return { ...plan, action: { ...plan.action, memoryIds: [...plan.action.memoryIds] } }
}

function existingMemory(state: FoldedMemoryState, use: SourceUse): MemoryRecord {
  const memory = use.memoryId === undefined ? undefined : state.byId.get(use.memoryId)
  if (memory === undefined) throw new Error('memory archive source result is unavailable')
  return memory
}

class StorageBackedMemoryArchive implements CompanionMemoryArchive {
  readonly #candidateReferences = new Map<string, Set<MemoryCandidate>>()
  readonly #lifecyclePlans = new Map<string, {
    plan: MemoryLifecyclePlanV1
    context: MemoryAccessContextV1
    expected: ReadonlyMap<string, string>
  }>()

  constructor(
    private readonly storage: MemoryArchiveStorage,
    private readonly createId: () => string,
    private readonly now: () => Date,
    private readonly conflictEvaluator: MemoryConflictEvaluator,
    private readonly retrievalEngine: MemoryRetrievalEngine,
    private readonly derivedViewInvalidator: DerivedMemoryViewInvalidator,
  ) {}

  inspection(): ArchiveInspection {
    return this.storage.inspection()
  }

  dispose(): Promise<void> {
    return this.storage.dispose()
  }

  #context(value: MemoryAccessContextV1): MemoryAccessContextV1 {
    return parseMemoryAccessContextV1(value)
  }

  #sourceKey(
    context: MemoryAccessContextV1,
    kind: MemoryObservationSourceKind,
    sourceId: string,
  ): string {
    return memorySourceKey({
      ownerId: context.ownerId,
      authority: context.authority,
      scope: context.scope,
      source: { kind, id: sourceId },
    })
  }

  #observation(
    context: MemoryAccessContextV1,
    kind: MemoryObservationSourceKind,
    sourceId: string,
    observedAt: string,
  ): MemoryObservationV1 {
    return {
      schemaVersion: 1,
      event: 'observation',
      id: this.createId(),
      ownerId: context.ownerId,
      authority: context.authority,
      scope: context.scope,
      source: { kind, id: sourceId },
      observedAt,
    }
  }

  #sameDomain(
    state: FoldedMemoryState,
    value: Pick<MemoryRecord | MemoryCandidate, 'ownerId' | 'scope' | 'observationId'>,
    context: MemoryAccessContextV1,
  ): boolean {
    const observation = state.observations.get(value.observationId)
    return value.ownerId === context.ownerId
      && memoryScopeEquals(value.scope, context.scope)
      && observation?.authority === context.authority
  }

  #target(
    state: FoldedMemoryState,
    memoryId: string,
    context: MemoryAccessContextV1,
  ): MemoryRecord {
    const memory = state.byId.get(memoryId)
    if (memory === undefined || !this.#sameDomain(state, memory, context)) {
      throw new MemoryArchiveError('memory target is unavailable in the trusted Owner/scope', 'MEMORY_SCOPE_MISMATCH')
    }
    return memory
  }

  #candidate(
    state: FoldedMemoryState,
    candidateId: string,
    context: MemoryAccessContextV1,
  ): MemoryCandidate {
    const candidate = state.candidateById.get(candidateId)
    if (candidate === undefined || !this.#sameDomain(state, candidate, context)
      || !canDiscloseMemory(candidate.visibility, context)) {
      throw new MemoryArchiveError('memory candidate is unavailable in the trusted Owner/scope', 'MEMORY_SCOPE_MISMATCH')
    }
    return candidate
  }

  #assessment(
    state: FoldedMemoryState,
    candidate: MemoryCandidate,
    context: MemoryAccessContextV1,
    evaluatedAt: string,
  ): MemoryConflictAssessmentV1 {
    const active = state.records.filter(memory => memory.status === 'confirmed'
      && this.#sameDomain(state, memory, context)
      && canDiscloseMemory(memory.visibility, context)
      && isMemoryCurrentlyValid(memory, evaluatedAt))
    return {
      schemaVersion: 1,
      candidateId: candidate.id,
      evaluatedAt,
      relationships: parseMemoryConflictRelationships(
        this.conflictEvaluator.evaluate(candidate, active),
        new Set(active.map(memory => memory.id)),
      ),
    }
  }

  async observeExplicit(input: ExplicitMemoryObservation): Promise<MemoryRecord | undefined> {
    const context = this.#context(input.context)
    const content = explicitContent(input.text)
    if (content === undefined) return undefined
    const visibility: MemoryVisibility = /保密|不要告诉|别告诉|不能告诉/u.test(input.text) ? 'confidential' : 'personal'
    return this.storage.transact(state => {
      const sourceKey = this.#sourceKey(context, 'dsh-message', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        if (used.kind === 'memory' && used.content === content && used.visibility === visibility
          && used.memoryKind === input.memoryKind) {
          return { events: [], result: existingMemory(state, used) }
        }
        return conflict(input.sourceMessageId)
      }
      const timestamp = this.now().toISOString()
      const observation = this.#observation(context, 'dsh-message', input.sourceMessageId, timestamp)
      const memory: MemoryRecord = {
        schemaVersion: 2,
        id: this.createId(),
        ownerId: context.ownerId,
        scope: context.scope,
        observationId: observation.id,
        memoryKind: input.memoryKind,
        createdAt: timestamp,
        recordedAt: timestamp,
        content,
        visibility,
        sourceMessageId: input.sourceMessageId,
        status: 'confirmed',
      }
      return { events: [observation, memory], result: memory }
    })
  }

  #eligibleRecords(
    state: FoldedMemoryState,
    context: MemoryAccessContextV1,
    at: string,
  ): MemoryRecord[] {
    return state.records.filter(memory => memory.status === 'confirmed'
      && this.#sameDomain(state, memory, context)
      && memory.lifecycle?.tier !== 'archived'
      && isMemoryCurrentlyValid(memory, at)
      && canDiscloseMemory(memory.visibility, context)
      && (memory.sourceMemoryIds === undefined || memory.sourceMemoryIds.every(memoryId => {
        const source = state.byId.get(memoryId)
        return source !== undefined && source.status === 'confirmed'
          && this.#sameDomain(state, source, context)
          && isMemoryCurrentlyValid(source, at)
      })))
  }

  recall(input: MemoryRecall): MemoryRecord[] {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    if (state === undefined) return []
    const limit = Math.max(0, input.limit ?? 8)
    const query = input.query.trim()
    const at = input.at ?? this.now().toISOString()
    const eligible = this.#eligibleRecords(state, context, at)
    const byId = new Map(eligible.map(memory => [memory.id, memory]))
    return bm25RecallHits(eligible, query)
      .flatMap(hit => {
        const memory = byId.get(hit.memoryId)
        return memory === undefined ? [] : [{ memory, score: hit.score }]
      })
      .toSorted((left, right) => right.score - left.score || right.memory.createdAt.localeCompare(left.memory.createdAt))
      .slice(0, limit)
      .map(item => item.memory)
  }

  async retrieve(input: MemoryRetrievalRequestV1): Promise<MemoryRecallSnapshotV1> {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    const createdAt = this.now().toISOString()
    if (state === undefined) return { schemaVersion: 1, query: input.query, createdAt, items: [] }
    const eligible = this.#eligibleRecords(state, context, input.at ?? createdAt)
    return this.retrievalEngine.retrieve(eligible, input, createdAt)
  }

  list(input: MemoryList): MemoryRecord[] {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    if (state === undefined) return []
    const limit = Math.max(0, input.limit ?? 100)
    return state.records
      .filter(memory => this.#sameDomain(state, memory, context)
        && canDiscloseMemory(memory.visibility, context)
        && (input.includeInactive === true || memory.status === 'confirmed'))
      .map((memory, index) => ({ memory, index }))
      .toSorted((left, right) => right.memory.createdAt.localeCompare(left.memory.createdAt) || right.index - left.index)
      .slice(0, limit)
      .map(item => item.memory)
  }

  async forget(input: MemoryForget): Promise<MemoryRecord> {
    const context = this.#context(input.context)
    return this.storage.transact(state => {
      const sourceKey = this.#sourceKey(context, 'governance-operation', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        if (used.kind === 'forget' && used.targetMemoryId === input.memoryId) return { events: [], result: existingMemory(state, used) }
        return conflict(input.sourceMessageId)
      }
      const memory = this.#target(state, input.memoryId, context)
      if (memory.status !== 'confirmed') throw new Error(`memory ${JSON.stringify(input.memoryId)} is already ${memory.status}`)
      const timestamp = this.now().toISOString()
      const observation = this.#observation(context, 'governance-operation', input.sourceMessageId, timestamp)
      const event: MemoryForgottenEvent = {
        schemaVersion: 2, event: 'forgotten', id: this.createId(), createdAt: timestamp,
        ownerId: context.ownerId, scope: context.scope, observationId: observation.id,
        memoryId: memory.id, sourceMessageId: input.sourceMessageId,
      }
      memory.status = 'forgotten'
      return { events: [observation, event], result: memory }
    })
  }

  async replace(input: MemoryReplace): Promise<MemoryRecord> {
    const context = this.#context(input.context)
    const content = input.content.trim()
    if (content === '') throw new Error('replacement memory content must be a non-empty string')
    return this.storage.transact(state => {
      const target = this.#target(state, input.memoryId, context)
      const memoryKind = input.memoryKind ?? target.memoryKind
      const validFrom = input.validFrom ?? target.validFrom
      const validTo = input.validTo ?? target.validTo
      const sourceKey = this.#sourceKey(context, 'governance-operation', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        if (used.kind === 'replace' && used.targetMemoryId === input.memoryId && used.content === content
          && used.memoryKind === memoryKind
          && (input.recordedAt === undefined || used.recordedAt === input.recordedAt)
          && used.validFrom === validFrom && used.validTo === validTo) {
          return { events: [], result: existingMemory(state, used) }
        }
        return conflict(input.sourceMessageId)
      }
      if (target.status !== 'confirmed') throw new Error(`memory ${JSON.stringify(input.memoryId)} is already ${target.status}`)
      const timestamp = this.now().toISOString()
      const validity = validateMemoryValidity({
        recordedAt: input.recordedAt ?? timestamp,
        ...(validFrom === undefined ? {} : { validFrom }),
        ...(validTo === undefined ? {} : { validTo }),
      })
      const observation = this.#observation(context, 'governance-operation', input.sourceMessageId, timestamp)
      const memory: MemoryRecord = {
        schemaVersion: 2, id: this.createId(), ownerId: context.ownerId, scope: context.scope,
        observationId: observation.id, memoryKind,
        createdAt: timestamp, ...validity, content, visibility: target.visibility, sourceMessageId: input.sourceMessageId,
        supersedesMemoryId: target.id, status: 'confirmed',
      }
      target.status = 'superseded'
      return { events: [observation, memory], result: memory }
    })
  }

  async importConfirmed(input: ConfirmedMemoryImport): Promise<ConfirmedMemoryImportResult> {
    const context = this.#context(input.context)
    const content = input.content.trim()
    if (content === '') throw new Error('imported memory content must be a non-empty string')
    const createdAt = new Date(input.createdAt)
    if (Number.isNaN(createdAt.getTime())) throw new Error(`invalid imported memory timestamp ${JSON.stringify(input.createdAt)}`)
    const timestamp = createdAt.toISOString()
    return this.storage.transact<ConfirmedMemoryImportResult>(state => {
      const sourceKey = this.#sourceKey(context, 'legacy-import', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        if (used.kind === 'memory' && used.content === content && used.visibility === input.visibility
          && used.createdAt === timestamp && used.memoryKind === input.memoryKind
          && used.validFrom === input.validFrom && used.validTo === input.validTo) {
          return { events: [], result: { memory: existingMemory(state, used), imported: false } }
        }
        return conflict(input.sourceMessageId)
      }
      const validity = validateMemoryValidity({
        recordedAt: timestamp,
        ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
        ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
      })
      const observation = this.#observation(context, 'legacy-import', input.sourceMessageId, timestamp)
      const memory: MemoryRecord = {
        schemaVersion: 2, id: this.createId(), ownerId: context.ownerId, scope: context.scope,
        observationId: observation.id, memoryKind: input.memoryKind, createdAt: timestamp, ...validity,
        content, visibility: input.visibility, sourceMessageId: input.sourceMessageId, status: 'confirmed',
      }
      return { events: [observation, memory], result: { memory, imported: true } }
    })
  }

  async propose(input: MemoryCandidateProposal): Promise<MemoryCandidate> {
    const context = this.#context(input.context)
    const content = input.content.trim()
    if (content === '') throw new Error('candidate memory content must be a non-empty string')
    const candidate = await this.storage.transact(state => {
      const sourceKey = this.#sourceKey(context, 'governance-operation', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        if (used.kind === 'candidate' && used.content === content && used.visibility === input.visibility
          && used.memoryKind === input.memoryKind
          && (input.recordedAt === undefined || used.recordedAt === input.recordedAt)
          && used.validFrom === input.validFrom && used.validTo === input.validTo) {
          const candidate = used.candidateId === undefined ? undefined : state.candidateById.get(used.candidateId)
          if (candidate !== undefined) return { events: [], result: candidate }
        }
        return conflict(input.sourceMessageId)
      }
      const timestamp = this.now().toISOString()
      const validity = validateMemoryValidity({
        recordedAt: input.recordedAt ?? timestamp,
        ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
        ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
      })
      const observation = this.#observation(context, 'governance-operation', input.sourceMessageId, timestamp)
      const candidate: MemoryCandidate = {
        schemaVersion: 2, event: 'candidate', id: this.createId(), ownerId: context.ownerId, scope: context.scope,
        observationId: observation.id, memoryKind: input.memoryKind, createdAt: timestamp, ...validity,
        content, visibility: input.visibility, sourceMessageId: input.sourceMessageId, status: 'pending',
      }
      return { events: [observation, candidate], result: candidate }
    })
    this.#rememberCandidateReference(candidate)
    return candidate
  }

  async proposeExtracted(input: ExtractedMemoryCandidateBatch): Promise<MemoryCandidate[]> {
    const context = this.#context(input.context)
    const providerId = input.providerId.trim()
    const providerVersion = input.providerVersion.trim()
    if (providerId === '' || providerVersion === '') throw new TypeError('extraction provider identity must be non-empty')
    if (input.drafts.length === 0) return []
    if (input.drafts.length > 8) throw new TypeError('an extracted source batch may contain at most 8 drafts')
    const normalized = input.drafts.map((draft) => {
      const content = draft.content.trim()
      if (content === '' || content.length > 2_000) throw new TypeError('extracted candidate content is invalid')
      const validity = validateMemoryValidity({
        recordedAt: draft.recordedAt ?? this.now().toISOString(),
        ...(draft.validFrom === undefined ? {} : { validFrom: draft.validFrom }),
        ...(draft.validTo === undefined ? {} : { validTo: draft.validTo }),
      })
      return { ...draft, ...validity, content }
    })
    const candidates = await this.storage.transact(state => {
      const sourceKey = this.#sourceKey(context, 'dsh-message', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        const existing = (used.candidateIds ?? (used.candidateId === undefined ? [] : [used.candidateId]))
          .map(id => state.candidateById.get(id))
        if (used.kind === 'candidate' && existing.length === normalized.length && existing.every((candidate, index) => {
          const draft = normalized[index]
          const supplied = input.drafts[index]
          return candidate !== undefined && draft !== undefined
            && supplied !== undefined
            && candidate.content === draft.content
            && candidate.visibility === draft.visibility
            && candidate.memoryKind === draft.memoryKind
            && (supplied.recordedAt === undefined || candidate.recordedAt === draft.recordedAt)
            && candidate.validFrom === draft.validFrom
            && candidate.validTo === draft.validTo
            && candidate.extraction?.providerId === providerId
            && candidate.extraction.providerVersion === providerVersion
            && JSON.stringify(candidate.extraction.receipt) === JSON.stringify(input.receipt)
        })) return { events: [], result: existing as MemoryCandidate[] }
        return conflict(input.sourceMessageId)
      }
      const timestamp = this.now().toISOString()
      const observation = this.#observation(context, 'dsh-message', input.sourceMessageId, timestamp)
      const created = normalized.map<MemoryCandidate>(draft => ({
        schemaVersion: 2,
        event: 'candidate',
        id: this.createId(),
        ownerId: context.ownerId,
        scope: context.scope,
        observationId: observation.id,
        memoryKind: draft.memoryKind,
        createdAt: timestamp,
        recordedAt: draft.recordedAt,
        ...(draft.validFrom === undefined ? {} : { validFrom: draft.validFrom }),
        ...(draft.validTo === undefined ? {} : { validTo: draft.validTo }),
        content: draft.content,
        visibility: draft.visibility,
        sourceMessageId: input.sourceMessageId,
        status: 'pending',
        extraction: {
          schemaVersion: 1,
          providerId,
          providerVersion,
          receipt: input.receipt,
        },
      }))
      return { events: [observation, ...created], result: created }
    })
    for (const candidate of candidates) this.#rememberCandidateReference(candidate)
    return candidates
  }

  listCandidates(input: MemoryCandidateList): MemoryCandidate[] {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    if (state === undefined) return []
    const limit = Math.max(0, input.limit ?? 100)
    const candidates = state.candidates
      .filter(candidate => this.#sameDomain(state, candidate, context)
        && canDiscloseMemory(candidate.visibility, context)
        && (input.includeResolved === true || candidate.status === 'pending'))
      .map((candidate, index) => ({ candidate, index }))
      .toSorted((left, right) => right.candidate.createdAt.localeCompare(left.candidate.createdAt) || right.index - left.index)
      .slice(0, limit)
      .map(item => item.candidate)
    for (const candidate of candidates) this.#rememberCandidateReference(candidate)
    return candidates
  }

  async #reviseCandidates(input: MemoryCandidateRevision, mode: 'edit' | 'merge'): Promise<MemoryCandidate> {
    const context = this.#context(input.context)
    const candidateIds = [...input.candidateIds]
    if ((mode === 'edit' && candidateIds.length !== 1) || (mode === 'merge' && candidateIds.length < 2)) {
      throw new TypeError(mode === 'edit' ? 'candidate edit requires exactly one source' : 'candidate merge requires at least two sources')
    }
    if (new Set(candidateIds).size !== candidateIds.length) throw new TypeError('candidate revision sources must be unique')
    const content = input.content.trim()
    if (content === '') throw new TypeError('candidate revision content must be non-empty')
    const revised = await this.storage.transact(state => {
      const sourceKey = this.#sourceKey(context, 'governance-operation', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        const existing = used.candidateId === undefined ? undefined : state.candidateById.get(used.candidateId)
        if (used.kind === 'candidate' && existing !== undefined
          && JSON.stringify(existing.sourceCandidateIds) === JSON.stringify(candidateIds)
          && existing.content === content && existing.visibility === input.visibility
          && existing.memoryKind === input.memoryKind
          && (input.recordedAt === undefined || existing.recordedAt === input.recordedAt)
          && existing.validFrom === input.validFrom && existing.validTo === input.validTo) {
          return { events: [], result: existing }
        }
        return conflict(input.sourceMessageId)
      }
      const sources = candidateIds.map(id => this.#candidate(state, id, context))
      if (sources.some(candidate => candidate.status !== 'pending')) throw new Error('candidate revision sources must all be pending')
      const timestamp = this.now().toISOString()
      const validity = validateMemoryValidity({
        recordedAt: input.recordedAt ?? timestamp,
        ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
        ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
      })
      const observation = this.#observation(context, 'governance-operation', input.sourceMessageId, timestamp)
      const candidate: MemoryCandidate = {
        schemaVersion: 2,
        event: 'candidate',
        id: this.createId(),
        ownerId: context.ownerId,
        scope: context.scope,
        observationId: observation.id,
        memoryKind: input.memoryKind,
        createdAt: timestamp,
        ...validity,
        content,
        visibility: input.visibility,
        sourceMessageId: input.sourceMessageId,
        sourceCandidateIds: candidateIds,
        status: 'pending',
      }
      const resolutions: MemoryCandidateResolutionEvent[] = sources.map(source => ({
        schemaVersion: 2,
        event: 'candidate-resolution',
        id: this.createId(),
        createdAt: timestamp,
        ownerId: context.ownerId,
        scope: context.scope,
        observationId: observation.id,
        candidateId: source.id,
        decision: 'superseded',
        sourceMessageId: input.sourceMessageId,
        replacementCandidateId: candidate.id,
      }))
      for (const source of sources) source.status = 'superseded'
      return { events: [observation, candidate, ...resolutions], result: candidate }
    })
    for (const candidateId of candidateIds) {
      for (const reference of this.#candidateReferences.get(candidateId) ?? []) reference.status = 'superseded'
    }
    this.#rememberCandidateReference(revised)
    return revised
  }

  editCandidate(input: MemoryCandidateRevision): Promise<MemoryCandidate> {
    return this.#reviseCandidates(input, 'edit')
  }

  mergeCandidates(input: MemoryCandidateRevision): Promise<MemoryCandidate> {
    return this.#reviseCandidates(input, 'merge')
  }

  listGovernanceAudit(input: MemoryGovernanceAuditList): MemoryGovernanceAuditEntryV1[] {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    if (state === undefined) return []
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000) throw new TypeError('governance audit limit must be from 0 through 1000')
    return state.candidates
      .filter(candidate => candidate.sourceCandidateIds !== undefined
        && this.#sameDomain(state, candidate, context)
        && canDiscloseMemory(candidate.visibility, context))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map(candidate => ({
        schemaVersion: 1,
        action: candidate.sourceCandidateIds!.length === 1 ? 'candidate-edited' : 'candidates-merged',
        sourceCandidateIds: [...candidate.sourceCandidateIds!],
        resultCandidateId: candidate.id,
        createdAt: candidate.createdAt,
        sourceMessageId: candidate.sourceMessageId,
      }))
  }

  manage(input: MemoryManagementQueryV1): MemoryManagementSnapshotV1 {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    if (state === undefined) return { schemaVersion: 1, records: [], candidates: [], audit: [] }
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('memory management limit must be from 1 through 500')
    const query = input.query?.trim().toLocaleLowerCase() ?? ''
    const matches = (content: string): boolean => query === '' || content.toLocaleLowerCase().includes(query)
    const recordStatus = input.recordStatus ?? 'active'
    const candidateStatus = input.candidateStatus ?? 'pending'
    const records = state.records
      .filter(memory => this.#sameDomain(state, memory, context)
        && canDiscloseMemory(memory.visibility, context)
        && matches(memory.content)
        && (input.memoryKind === undefined || memory.memoryKind === input.memoryKind)
        && (input.visibility === undefined || memory.visibility === input.visibility)
        && (recordStatus === 'all'
          || (recordStatus === 'active' ? memory.status === 'confirmed' : memory.status !== 'confirmed')))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, limit)
    const candidates = state.candidates
      .filter(candidate => this.#sameDomain(state, candidate, context)
        && canDiscloseMemory(candidate.visibility, context)
        && matches(candidate.content)
        && (input.memoryKind === undefined || candidate.memoryKind === input.memoryKind)
        && (input.visibility === undefined || candidate.visibility === input.visibility)
        && (candidateStatus === 'all' || candidate.status === candidateStatus))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, limit)
    return {
      schemaVersion: 1,
      records,
      candidates,
      audit: this.listGovernanceAudit({ context, limit }),
    }
  }

  sourceView(input: MemorySourceViewRequestV1): MemorySourceViewV1 {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    if (state === undefined) throw new Error('memory archive is unavailable')
    const entity = input.entity === 'record'
      ? state.byId.get(input.id)
      : state.candidateById.get(input.id)
    if (entity === undefined || !this.#sameDomain(state, entity, context)
      || !canDiscloseMemory(entity.visibility, context)) {
      throw new MemoryArchiveError('memory source is unavailable in the trusted Owner/scope', 'MEMORY_SCOPE_MISMATCH')
    }
    const observation = state.observations.get(entity.observationId)
    if (observation === undefined) throw new Error('memory source observation is unavailable')
    return {
      schemaVersion: 1,
      entity: input.entity,
      id: entity.id,
      observation: {
        id: observation.id,
        sourceKind: observation.source.kind,
        sourceId: observation.source.id,
        observedAt: observation.observedAt,
      },
      ...('sourceCandidateId' in entity && entity.sourceCandidateId !== undefined
        ? { sourceCandidateId: entity.sourceCandidateId }
        : {}),
      ...('sourceCandidateIds' in entity && entity.sourceCandidateIds !== undefined
        ? { sourceCandidateIds: [...entity.sourceCandidateIds] }
        : {}),
      ...('supersedesMemoryId' in entity && entity.supersedesMemoryId !== undefined
        ? { supersedesMemoryId: entity.supersedesMemoryId }
        : {}),
      ...('sourceMemoryIds' in entity && entity.sourceMemoryIds !== undefined
        ? { sourceMemoryIds: [...entity.sourceMemoryIds] }
        : {}),
    }
  }

  async batchDecide(input: MemoryBatchGovernanceRequestV1): Promise<MemoryBatchGovernanceResultV1> {
    const context = this.#context(input.context)
    const requestId = input.requestId.trim()
    if (requestId === '') throw new TypeError('memory batch requestId must be non-empty')
    if (input.decisions.length < 1 || input.decisions.length > 50) {
      throw new TypeError('memory batch decisions must contain from 1 through 50 items')
    }
    const ids = input.decisions.map(item => item.candidateId)
    if (ids.some(id => id.trim() === '') || new Set(ids).size !== ids.length) {
      throw new TypeError('memory batch candidate IDs must be non-empty and unique')
    }
    for (const decision of input.decisions) {
      if (decision.action === 'reject' && decision.resolution !== undefined) {
        throw new TypeError('rejected candidates cannot carry a conflict resolution')
      }
    }
    const results: MemoryBatchGovernanceResultV1['results'] = []
    for (const [index, decision] of input.decisions.entries()) {
      try {
        const sourceMessageId = `memory-batch:${requestId}:${index}`
        if (decision.action === 'approve') {
          await this.approveCandidate({
            context,
            candidateId: decision.candidateId,
            sourceMessageId,
            ...(decision.resolution === undefined ? {} : { resolution: decision.resolution }),
          })
        } else {
          await this.rejectCandidate({ context, candidateId: decision.candidateId, sourceMessageId })
        }
        results.push({ candidateId: decision.candidateId, status: 'succeeded' })
      } catch (error) {
        const code = error instanceof MemoryArchiveError ? error.code : 'MEMORY_GOVERNANCE_FAILED'
        results.push({ candidateId: decision.candidateId, status: 'failed', code })
      }
    }
    return { schemaVersion: 1, results }
  }

  assessCandidate(input: MemoryCandidateAssessment): MemoryConflictAssessmentV1 {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    if (state === undefined) throw new Error('memory archive is unavailable')
    const candidate = this.#candidate(state, input.candidateId, context)
    if (candidate.status !== 'pending') throw new Error(`memory candidate ${JSON.stringify(input.candidateId)} is already ${candidate.status}`)
    return this.#assessment(state, candidate, context, this.now().toISOString())
  }

  async approveCandidate(input: MemoryCandidateDecision): Promise<MemoryRecord> {
    const context = this.#context(input.context)
    const memory = await this.storage.transact(state => {
      const sourceKey = this.#sourceKey(context, 'governance-operation', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        const targetMemoryId = input.resolution?.kind === 'supersede' ? input.resolution.memoryId : undefined
        if (used.kind === 'approve' && used.candidateId === input.candidateId
          && used.targetMemoryId === targetMemoryId) return { events: [], result: existingMemory(state, used) }
        return conflict(input.sourceMessageId)
      }
      const candidate = this.#candidate(state, input.candidateId, context)
      if (candidate.status !== 'pending') throw new Error(`memory candidate ${JSON.stringify(input.candidateId)} is already ${candidate.status}`)
      const timestamp = this.now().toISOString()
      const assessment = this.#assessment(state, candidate, context, timestamp)
      const conflicts = assessment.relationships.filter(item => item.relation === 'duplicate' || item.relation === 'conflict')
      if (conflicts.length > 0 && input.resolution === undefined) {
        throw new MemoryArchiveError(
          'memory candidate approval requires an explicit conflict decision',
          'MEMORY_CONFLICT_DECISION_REQUIRED',
        )
      }
      let superseded: MemoryRecord | undefined
      if (input.resolution?.kind === 'supersede') {
        superseded = this.#target(state, input.resolution.memoryId, context)
        if (superseded.status !== 'confirmed') throw new Error('memory supersession target must be active')
        if (!conflicts.some(item => item.memoryId === superseded?.id)) {
          throw new MemoryArchiveError('memory supersession target is not an assessed conflict', 'MEMORY_CONFLICT_TARGET_INVALID')
        }
      }
      const observation = this.#observation(context, 'governance-operation', input.sourceMessageId, timestamp)
      const approved: MemoryRecord = {
        schemaVersion: 2, id: this.createId(), ownerId: candidate.ownerId, scope: candidate.scope,
        observationId: observation.id, memoryKind: candidate.memoryKind, createdAt: timestamp,
        recordedAt: candidate.recordedAt,
        ...(candidate.validFrom === undefined ? {} : { validFrom: candidate.validFrom }),
        ...(candidate.validTo === undefined ? {} : { validTo: candidate.validTo }),
        content: candidate.content, visibility: candidate.visibility, sourceMessageId: input.sourceMessageId,
        sourceCandidateId: candidate.id,
        ...(superseded === undefined ? {} : { supersedesMemoryId: superseded.id }),
        status: 'confirmed',
      }
      const resolution: MemoryCandidateResolutionEvent = {
        schemaVersion: 2, event: 'candidate-resolution', id: this.createId(), createdAt: timestamp,
        ownerId: context.ownerId, scope: context.scope, observationId: observation.id,
        candidateId: candidate.id, decision: 'approved', sourceMessageId: input.sourceMessageId,
        memoryId: approved.id,
      }
      candidate.status = 'approved'
      if (superseded !== undefined) superseded.status = 'superseded'
      return { events: [observation, approved, resolution], result: approved }
    })
    for (const candidate of this.#candidateReferences.get(input.candidateId) ?? []) candidate.status = 'approved'
    return memory
  }

  async rejectCandidate(input: MemoryCandidateDecision): Promise<MemoryCandidate> {
    const context = this.#context(input.context)
    const candidate = await this.storage.transact(state => {
      const sourceKey = this.#sourceKey(context, 'governance-operation', input.sourceMessageId)
      const used = state.sources.get(sourceKey)
      if (used !== undefined) {
        if (used.kind === 'reject' && used.candidateId === input.candidateId) {
          const existing = state.candidateById.get(input.candidateId)
          if (existing !== undefined) return { events: [], result: existing }
        }
        return conflict(input.sourceMessageId)
      }
      const pending = state.candidateById.get(input.candidateId)
      if (pending === undefined || !this.#sameDomain(state, pending, context)) {
        throw new MemoryArchiveError('memory candidate is unavailable in the trusted Owner/scope', 'MEMORY_SCOPE_MISMATCH')
      }
      if (pending.status !== 'pending') throw new Error(`memory candidate ${JSON.stringify(input.candidateId)} is already ${pending.status}`)
      const timestamp = this.now().toISOString()
      const observation = this.#observation(context, 'governance-operation', input.sourceMessageId, timestamp)
      const resolution: MemoryCandidateResolutionEvent = {
        schemaVersion: 2, event: 'candidate-resolution', id: this.createId(), createdAt: timestamp,
        ownerId: context.ownerId, scope: context.scope, observationId: observation.id,
        candidateId: pending.id, decision: 'rejected', sourceMessageId: input.sourceMessageId,
      }
      pending.status = 'rejected'
      return { events: [observation, resolution], result: pending }
    })
    for (const reference of this.#candidateReferences.get(input.candidateId) ?? []) reference.status = 'rejected'
    this.#rememberCandidateReference(candidate)
    return candidate
  }

  planLifecycle(input: MemoryLifecyclePlanRequestV1): MemoryLifecyclePlanV1 {
    const context = this.#context(input.context)
    const state = this.storage.snapshot()
    if (state === undefined) throw new MemoryArchiveError('memory archive is unavailable', 'MEMORY_ARCHIVE_QUARANTINED')
    const createdAt = this.now().toISOString()
    let plan: MemoryLifecyclePlanV1
    let targets: MemoryRecord[]
    if (input.action.kind === 'consolidate') {
      const sourceMemoryIds = [...input.action.sourceMemoryIds]
      if (sourceMemoryIds.length < 2 || sourceMemoryIds.length > 50
        || new Set(sourceMemoryIds).size !== sourceMemoryIds.length) {
        throw new TypeError('memory consolidation requires 2 through 50 unique sourceMemoryIds')
      }
      const content = input.action.content.trim()
      if (content === '' || content.length > 8_000) {
        throw new TypeError('memory consolidation content must contain 1 through 8000 characters')
      }
      targets = sourceMemoryIds.map(memoryId => this.#target(state, memoryId, context))
      if (targets.some(memory => !canDiscloseMemory(memory.visibility, context))) {
        throw new MemoryArchiveError('memory lifecycle source is unavailable under the disclosure policy', 'MEMORY_SCOPE_MISMATCH')
      }
      if (targets.some(memory => memory.status !== 'confirmed' || memory.sourceMemoryIds !== undefined
        || !isMemoryCurrentlyValid(memory, createdAt))) {
        throw new Error('memory consolidation sources must be active leaf memories')
      }
      plan = {
        schemaVersion: 1,
        id: this.createId(),
        createdAt,
        action: {
          kind: 'consolidate',
          sourceMemoryIds,
          content,
          visibility: targets.some(memory => memory.visibility === 'confidential') ? 'confidential' : 'personal',
        },
      }
    } else if (input.action.kind === 'decay') {
      const action = input.action
      if (!Number.isSafeInteger(action.coldAfterDays)
        || action.coldAfterDays < 1 || action.coldAfterDays > 3_650) {
        throw new TypeError('memory decay coldAfterDays must be an integer from 1 through 3650')
      }
      if (!Number.isFinite(action.minimumRankMultiplier)
        || action.minimumRankMultiplier < 0.1 || action.minimumRankMultiplier > 1) {
        throw new TypeError('memory decay minimumRankMultiplier must be from 0.1 through 1')
      }
      const nowMs = new Date(createdAt).getTime()
      const dayMs = 86_400_000
      targets = state.records.filter(memory => memory.status === 'confirmed'
        && this.#sameDomain(state, memory, context)
        && canDiscloseMemory(memory.visibility, context)
        && memory.lifecycle?.tier !== 'archived'
        && isMemoryCurrentlyValid(memory, createdAt)
        && memory.memoryKind !== 'boundary'
        && memory.memoryKind !== 'commitment'
        && memory.memoryKind !== 'state'
        && Math.floor((nowMs - new Date(memory.recordedAt).getTime()) / dayMs) >= action.coldAfterDays)
      const changes = targets.map(memory => {
        const ageDays = Math.max(0, (nowMs - new Date(memory.recordedAt).getTime()) / dayMs)
        const calculated = action.coldAfterDays / (ageDays + action.coldAfterDays)
        return {
          memoryId: memory.id,
          toTier: 'cold' as const,
          rankMultiplier: Math.max(action.minimumRankMultiplier, Math.min(1, calculated)),
        }
      }).filter(change => {
        const memory = state.byId.get(change.memoryId)
        const currentMultiplier = memory?.lifecycle?.rankMultiplier ?? 1
        return change.rankMultiplier < currentMultiplier || memory?.lifecycle?.tier !== 'cold'
      })
      const changedIds = new Set(changes.map(change => change.memoryId))
      targets = targets.filter(memory => changedIds.has(memory.id))
      plan = {
        schemaVersion: 1,
        id: this.createId(),
        createdAt,
        action: { kind: 'decay', changes },
      }
    } else {
      const memoryIds = [...input.action.memoryIds]
      if (memoryIds.length < 1 || memoryIds.length > 100 || new Set(memoryIds).size !== memoryIds.length) {
        throw new TypeError('memory archive/restore requires 1 through 100 unique memoryIds')
      }
      targets = memoryIds.map(memoryId => this.#target(state, memoryId, context))
      if (targets.some(memory => !canDiscloseMemory(memory.visibility, context))) {
        throw new MemoryArchiveError('memory lifecycle target is unavailable under the disclosure policy', 'MEMORY_SCOPE_MISMATCH')
      }
      if (input.action.kind === 'archive'
        ? targets.some(memory => memory.status !== 'confirmed' || memory.lifecycle?.tier === 'archived')
        : targets.some(memory => memory.status !== 'confirmed' || memory.lifecycle?.tier !== 'archived')) {
        throw new Error(`memory ${input.action.kind} targets are not in the required recall tier`)
      }
      plan = {
        schemaVersion: 1,
        id: this.createId(),
        createdAt,
        action: { kind: input.action.kind, memoryIds },
      }
    }
    this.#lifecyclePlans.set(plan.id, {
      plan: cloneLifecyclePlan(plan),
      context,
      expected: new Map(targets.map(memory => [memory.id, JSON.stringify({
        status: memory.status,
        validFrom: memory.validFrom,
        validTo: memory.validTo,
        lifecycle: memory.lifecycle,
      })])),
    })
    return cloneLifecyclePlan(plan)
  }

  async applyLifecycle(input: MemoryLifecycleApplyRequestV1): Promise<MemoryLifecycleApplyResultV1> {
    if (!input.ownerConfirmed) throw new Error('Owner confirmation is required to apply a memory lifecycle plan')
    if (input.sourceMessageId.trim() === '') throw new TypeError('memory lifecycle sourceMessageId must be non-empty')
    const context = this.#context(input.context)
    const pending = this.#lifecyclePlans.get(input.planId)
    if (pending === undefined || pending.context.ownerId !== context.ownerId
      || pending.context.authority !== context.authority
      || !memoryScopeEquals(pending.context.scope, context.scope)) {
      throw new Error('memory lifecycle plan is unavailable in the trusted Owner/scope')
    }
    const result = await this.storage.transact<MemoryLifecycleApplyResultV1>(state => {
      const targetIds = pending.plan.action.kind === 'consolidate'
        ? pending.plan.action.sourceMemoryIds
        : pending.plan.action.kind === 'decay'
          ? pending.plan.action.changes.map(change => change.memoryId)
          : pending.plan.action.memoryIds
      const targets = targetIds.map(memoryId => this.#target(state, memoryId, context))
      for (const target of targets) {
        const actual = JSON.stringify({
          status: target.status,
          validFrom: target.validFrom,
          validTo: target.validTo,
          lifecycle: target.lifecycle,
        })
        if (pending.expected.get(target.id) !== actual
          || (pending.plan.action.kind === 'consolidate' && target.sourceMemoryIds !== undefined)) {
          throw new Error('memory lifecycle plan is stale')
        }
      }
      const timestamp = this.now().toISOString()
      const observation = this.#observation(context, 'governance-operation', input.sourceMessageId, timestamp)
      if (pending.plan.action.kind === 'decay') {
        const events: MemoryLifecycleEvent[] = pending.plan.action.changes.map(change => ({
          schemaVersion: 2,
          event: 'lifecycle',
          id: this.createId(),
          createdAt: timestamp,
          ownerId: context.ownerId,
          scope: context.scope,
          observationId: observation.id,
          memoryId: change.memoryId,
          action: 'decay',
          tier: change.toTier,
          rankMultiplier: change.rankMultiplier,
          sourceMessageId: input.sourceMessageId,
        }))
        return {
          events: events.length === 0 ? [] : [observation, ...events],
          result: {
            schemaVersion: 1 as const,
            action: 'decay' as const,
            affectedMemoryIds: pending.plan.action.changes.map(change => change.memoryId),
          },
        }
      }
      if (pending.plan.action.kind === 'archive' || pending.plan.action.kind === 'restore') {
        const action = pending.plan.action.kind
        const events: MemoryLifecycleEvent[] = targets.map(target => {
          const currentMultiplier = target.lifecycle?.rankMultiplier ?? 1
          return {
            schemaVersion: 2,
            event: 'lifecycle',
            id: this.createId(),
            createdAt: timestamp,
            ownerId: context.ownerId,
            scope: context.scope,
            observationId: observation.id,
            memoryId: target.id,
            action,
            tier: action === 'archive' ? 'archived' : currentMultiplier < 1 ? 'cold' : 'hot',
            rankMultiplier: currentMultiplier,
            sourceMessageId: input.sourceMessageId,
          }
        })
        return {
          events: [observation, ...events],
          result: {
            schemaVersion: 1 as const,
            action,
            affectedMemoryIds: targets.map(target => target.id),
          },
        }
      }
      if (pending.plan.action.kind !== 'consolidate') throw new Error('memory lifecycle action is unsupported')
      const action = pending.plan.action
      const memory: MemoryRecord = {
        schemaVersion: 2,
        id: this.createId(),
        ownerId: context.ownerId,
        scope: context.scope,
        observationId: observation.id,
        memoryKind: 'summary',
        createdAt: timestamp,
        recordedAt: timestamp,
        content: action.content,
        visibility: action.visibility,
        sourceMessageId: input.sourceMessageId,
        sourceMemoryIds: [...action.sourceMemoryIds],
        status: 'confirmed',
      }
      return {
        events: [observation, memory],
        result: {
          schemaVersion: 1 as const,
          action: 'consolidate' as const,
          affectedMemoryIds: [...action.sourceMemoryIds, memory.id],
          createdMemory: memory,
        },
      }
    })
    this.#lifecyclePlans.delete(input.planId)
    const derivedViews = await this.derivedViewInvalidator.invalidate(result.affectedMemoryIds)
    return { ...result, ...(derivedViews.length === 0 ? {} : { derivedViews }) }
  }

  #rememberCandidateReference(candidate: MemoryCandidate): void {
    const references = this.#candidateReferences.get(candidate.id) ?? new Set<MemoryCandidate>()
    references.add(candidate)
    this.#candidateReferences.set(candidate.id, references)
  }
}

/** Open the owner-private v2 archive; legacy or damaged archives remain inspectable but fail closed. */
export async function openMemoryArchive(options: OpenMemoryArchiveOptions): Promise<CompanionMemoryArchive> {
  const now = options.now ?? (() => new Date())
  const storage = await MemoryArchiveStorage.open({
    path: options.path,
    now,
    leaseTimeoutMs: options.leaseTimeoutMs,
    leaseStaleMs: options.leaseStaleMs,
    maxArchiveBytes: options.maxArchiveBytes,
    maxTransactionBytes: options.maxTransactionBytes,
    disposeTimeoutMs: options.disposeTimeoutMs,
  })
  return new StorageBackedMemoryArchive(
    storage,
    options.createId ?? randomUUID,
    now,
    options.conflictEvaluator ?? new DeterministicMemoryConflictEvaluator(),
    options.retrievalEngine ?? new MemoryRetrievalEngine(),
    options.derivedViewInvalidator ?? new DerivedMemoryViewRegistry(),
  )
}

function userText(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
}

function recallSnapshot(snapshot: MemoryRecallSnapshotV1): string {
  return 'Relevant confirmed companion memories. Use them only when relevant; '
    + 'do not reveal confidential details without owner intent:\n'
    + snapshot.items.map(({ memory, reasons }) => {
      const receipt = reasons.map(reason => `${reason.providerId}:${reason.reason}`).join(',')
      return `- [memory:${memory.id}; source:${memory.sourceMessageId}; reason:${receipt}] ${memory.content}`
    }).join('\n')
}

const memoryValueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', required: true },
    id: { type: 'string', required: true },
    ownerId: { type: 'string', required: true },
    scope: {
      type: 'object', required: true, additionalProperties: false,
      properties: {
        version: { type: 'integer', required: true },
        kind: { type: 'string', required: true, enum: ['companion-reality', 'character-scene', 'campaign-branch'] },
        sceneId: { type: 'string' }, campaignId: { type: 'string' }, branchId: { type: 'string' },
      },
    },
    observationId: { type: 'string', required: true },
    memoryKind: {
      type: 'string', required: true,
      enum: ['preference', 'biographical', 'boundary', 'commitment', 'relationship', 'episode', 'state', 'summary'],
    },
    createdAt: { type: 'string', required: true },
    recordedAt: { type: 'string', required: true },
    validFrom: { type: 'string' },
    validTo: { type: 'string' },
    content: { type: 'string', required: true },
    visibility: { type: 'string', required: true, enum: ['personal', 'confidential'] },
    sourceMessageId: { type: 'string', required: true },
    sourceCandidateId: { type: 'string' },
    supersedesMemoryId: { type: 'string' },
    sourceMemoryIds: { type: 'array', items: { type: 'string' } },
    lifecycle: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tier: { type: 'string', required: true, enum: ['hot', 'cold', 'archived'] },
        rankMultiplier: { type: 'number', required: true },
        updatedAt: { type: 'string', required: true },
      },
    },
    status: { type: 'string', required: true, enum: ['confirmed', 'forgotten', 'superseded'] },
  },
} as const satisfies ValueSchemaSpec

const memoryCandidateValueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', required: true },
    event: { type: 'string', required: true, enum: ['candidate'] },
    id: { type: 'string', required: true },
    ownerId: memoryValueSchema.properties.ownerId,
    scope: memoryValueSchema.properties.scope,
    observationId: memoryValueSchema.properties.observationId,
    memoryKind: memoryValueSchema.properties.memoryKind,
    createdAt: { type: 'string', required: true },
    recordedAt: { type: 'string', required: true },
    validFrom: { type: 'string' },
    validTo: { type: 'string' },
    content: { type: 'string', required: true },
    visibility: { type: 'string', required: true, enum: ['personal', 'confidential'] },
    sourceMessageId: { type: 'string', required: true },
    sourceCandidateIds: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', required: true, enum: ['pending', 'approved', 'rejected', 'superseded'] },
    extraction: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'integer', required: true },
        providerId: { type: 'string', required: true },
        providerVersion: { type: 'string', required: true },
        receipt: {
          type: 'object', required: true, additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: ['local-deterministic', 'dsh-session'] },
            implementationVersion: { type: 'string' },
            sessionId: { type: 'string' },
            requestSeq: { type: 'integer' },
            responseSeq: { type: 'integer' },
          },
        },
      },
    },
  },
} as const satisfies ValueSchemaSpec

function toolSourceMessageId(callId: unknown, agentId?: unknown): string {
  return `memory-tool:${agentId === undefined ? 'unowned' : String(agentId)}:${String(callId)}`
}

function boundedListLimit(limit: number | undefined): number {
  const resolved = limit ?? 20
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100) {
    throw new Error(`memory list limit must be an integer from 1 through 100, got ${String(resolved)}`)
  }
  return resolved
}

interface MemoryOwnerEligibility {
  ownerMessages(agent: Agent, messages: readonly UserMessage[]): readonly UserMessage[]
  evaluateMessage(agent: Agent, message: UserMessage): {
    readonly eligible: boolean
    readonly ownerId?: string
    readonly authority?: string
  }
  evaluateCurrentTurn(agent: Agent): {
    readonly eligible: boolean
    readonly ownerId?: string
    readonly authority?: string
  }
  trustedLocalOwner?(): { readonly ownerId: string; readonly authority: string }
}

function ownerEligibility(ctx: Context): MemoryOwnerEligibility {
  return ctx.get('mistymoonOwnerEligibility', true) as MemoryOwnerEligibility
}

const MEMORY_TOOL_NAMES = new Set([
  'memory_candidate_propose',
  'memory_candidate_list',
  'memory_candidate_assess',
  'memory_candidate_approve',
  'memory_candidate_reject',
  'memory_list',
  'memory_forget',
  'memory_replace',
])

function memoryOwnerGuard(ctx: Context, execution: Readonly<ToolExecution>): string | undefined {
  if (!MEMORY_TOOL_NAMES.has(execution.name)) return undefined
  const agent = execution.agent
  if (agent !== undefined && ownerEligibility(ctx).evaluateCurrentTurn(agent).eligible) {
    return undefined
  }
  return 'MistyMoon memory tools require an authenticated Owner request in the active top-level turn.'
}

const COMPANION_SCOPE = { version: 1, kind: 'companion-reality' } as const

function explicitConfidentialRecallIntent(text: string): boolean {
  return /(?:回忆|想起|告诉|查看|列出|召回).*(?:保密|秘密|私密)|(?:保密|秘密|私密).*(?:回忆|想起|告诉|查看|列出|召回)/u.test(text)
}

function currentTurnText(agent: Agent): string {
  const events = agent.session.events
  let start = events.length
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      start = index + 1
      break
    }
  }
  return events.slice(start).flatMap(event => event.type === 'user/message' ? [userText(event.data)] : []).join('\n')
}

function currentTurnOwnerMessages(agent: Agent, turn: number, eligibility: MemoryOwnerEligibility): UserMessage[] {
  const events = agent.session.events
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data.turn === turn) {
      start = index + 1
      break
    }
  }
  if (start < 0) return []
  const messages = events.slice(start)
    .filter(event => event.type === 'user/message')
    .map(event => event.data)
  return [...eligibility.ownerMessages(agent, messages)]
}

function turnHasCompletedReply(agent: Agent, turn: number): boolean {
  return agent.session.events.some(event => event.type === 'assistant/message'
    && event.data.turn === turn
    && event.data.message.content.some(block => block.type === 'text' && block.text.trim() !== ''))
}

function ownerContext(
  decision: ReturnType<MemoryOwnerEligibility['evaluateCurrentTurn']>,
  channelDisclosure: MemoryAccessContextV1['channelDisclosure'],
  text: string,
): MemoryAccessContextV1 {
  if (!decision.eligible || decision.ownerId === undefined || decision.authority === undefined) {
    throw new Error('memory access requires an authenticated Owner decision')
  }
  return {
    version: 1,
    ownerId: decision.ownerId,
    authority: decision.authority,
    scope: COMPANION_SCOPE,
    channelDisclosure,
    requestIntent: explicitConfidentialRecallIntent(text) ? 'explicit-confidential-recall' : 'ordinary',
  }
}

function toolContext(
  ctx: Context,
  execution: Readonly<ToolExecution>,
  channelDisclosure: MemoryAccessContextV1['channelDisclosure'],
): MemoryAccessContextV1 {
  const agent = execution.agent
  if (agent === undefined) throw new Error('memory tool requires an active Owner agent')
  return ownerContext(ownerEligibility(ctx).evaluateCurrentTurn(agent), channelDisclosure, currentTurnText(agent))
}

function registerMemoryTools(
  ctx: Context,
  archive: CompanionMemoryArchive,
  channelDisclosure: MemoryAccessContextV1['channelDisclosure'],
): void {
  ctx.tools.register(defineTool({
    name: 'memory_candidate_propose',
    description: 'Propose a durable companion memory inferred from the owner\'s messages. The proposal is not recalled '
      + 'until the owner explicitly reviews and approves it. Never use this for secrets unless the owner clearly asks.',
    parameters: {
      content: { type: 'string', required: true, description: 'One complete, durable fact stated without speculation.' },
      visibility: {
        type: 'string',
        enum: ['personal', 'confidential'],
        description: 'Use confidential for sensitive facts; defaults to personal.',
      },
      memoryKind: {
        type: 'string',
        enum: ['preference', 'biographical', 'boundary', 'commitment', 'relationship', 'episode', 'state', 'summary'],
        description: 'Governed fact category; defaults to summary when the source does not establish a narrower kind.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { candidate: { ...memoryCandidateValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Proposed companion memory ${result.candidate.id} for owner review.` }],
    },
    async execute(args, exec) {
      return {
        candidate: await archive.propose({
          context: toolContext(ctx, exec, channelDisclosure),
          content: args.content,
          visibility: args.visibility ?? 'personal',
          memoryKind: args.memoryKind ?? 'summary',
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Propose companion memory', kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_candidate_list',
    description: 'List companion-memory proposals awaiting owner review. Include resolved history only for an audit request.',
    parameters: {
      includeResolved: { type: 'boolean', description: 'Include approved and rejected candidates.' },
      limit: { type: 'integer', description: 'Maximum results from 1 through 100.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidates: { type: 'array', required: true, items: memoryCandidateValueSchema },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.candidates.length === 0
          ? 'No companion-memory proposals await review.'
          : `Found ${result.candidates.length} companion-memory ${result.candidates.length === 1 ? 'proposal' : 'proposals'}.`,
      }],
    },
    execute(args, exec) {
      return Promise.resolve({
        candidates: archive.listCandidates({
          context: toolContext(ctx, exec, channelDisclosure),
          includeResolved: args.includeResolved,
          limit: boundedListLimit(args.limit),
        }),
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Review memory proposals', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_candidate_assess',
    description: 'Assess one pending candidate against active memories in the same trusted scope. '
      + 'The result is explanatory only and never changes memory state.',
    parameters: {
      candidateId: { type: 'string', required: true, description: 'Exact candidate id returned by memory_candidate_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assessment: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              schemaVersion: { type: 'integer', required: true },
              candidateId: { type: 'string', required: true },
              evaluatedAt: { type: 'string', required: true },
              relationships: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    memoryId: { type: 'string', required: true },
                    relation: { type: 'string', required: true, enum: ['duplicate', 'conflict', 'related'] },
                    score: { type: 'number', required: true },
                    reason: {
                      type: 'string', required: true,
                      enum: ['exact-normalized-match', 'same-kind-near-match', 'lexical-overlap'],
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.assessment.relationships.length === 0
          ? 'No active duplicate or conflict was detected.'
          : `Found ${result.assessment.relationships.length} explainable memory relationship(s).`,
      }],
    },
    execute(args, exec) {
      const assessment = archive.assessCandidate({
        context: toolContext(ctx, exec, channelDisclosure),
        candidateId: args.candidateId,
      })
      return Promise.resolve({
        assessment: { ...assessment, relationships: [...assessment.relationships] },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Assess memory proposal', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_candidate_approve',
    description: 'Approve one pending companion-memory proposal only after clear owner authorization. '
      + 'When assessment reports a duplicate or conflict, also supply the owner\'s keep-both or supersede decision.',
    parameters: {
      candidateId: { type: 'string', required: true, description: 'Exact candidate id returned by memory_candidate_list.' },
      resolution: {
        type: 'string',
        enum: ['keep-both', 'supersede'],
        description: 'Owner decision required when the candidate conflicts with an active memory.',
      },
      supersedesMemoryId: {
        type: 'string',
        description: 'Exact active memory id selected by the owner when resolution is supersede.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { memory: { ...memoryValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Approved companion memory ${result.memory.id}.` }],
    },
    async execute(args, exec) {
      if ((args.resolution === 'supersede') !== (args.supersedesMemoryId !== undefined)) {
        throw new Error('supersede resolution requires exactly one supersedesMemoryId')
      }
      if (args.resolution === 'keep-both' && args.supersedesMemoryId !== undefined) {
        throw new Error('keep-both resolution cannot select a supersession target')
      }
      return {
        memory: await archive.approveCandidate({
          context: toolContext(ctx, exec, channelDisclosure),
          candidateId: args.candidateId,
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
          ...(args.resolution === undefined ? {} : {
            resolution: args.resolution === 'keep-both'
              ? { kind: 'keep-both' as const }
              : { kind: 'supersede' as const, memoryId: args.supersedesMemoryId! },
          }),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Approve companion memory', kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_candidate_reject',
    description: 'Reject one pending companion-memory proposal only after clear owner authorization. '
      + 'The rejected proposal remains in private audit history and is never recalled.',
    parameters: {
      candidateId: { type: 'string', required: true, description: 'Exact candidate id returned by memory_candidate_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { candidate: { ...memoryCandidateValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Rejected companion-memory proposal ${result.candidate.id}.` }],
    },
    async execute(args, exec) {
      return {
        candidate: await archive.rejectCandidate({
          context: toolContext(ctx, exec, channelDisclosure),
          candidateId: args.candidateId,
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Reject memory proposal', kind: 'delete', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List the owner\'s confirmed companion memories. Use a query to find relevant active memories; '
      + 'omit it to review recent memories. Include inactive history only when the owner asks to audit past changes.',
    parameters: {
      query: { type: 'string', description: 'Optional lexical search query over active memories.' },
      includeInactive: { type: 'boolean', description: 'Include forgotten and superseded memories when no query is supplied.' },
      limit: { type: 'integer', description: 'Maximum results from 1 through 100.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: { type: 'array', required: true, items: memoryValueSchema },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: result.memories.length === 0
          ? 'No matching companion memories.'
          : `Found ${result.memories.length} companion ${result.memories.length === 1 ? 'memory' : 'memories'}.`,
      }],
    },
    execute(args, exec) {
      const limit = boundedListLimit(args.limit)
      const query = args.query?.trim()
      const memories = query === undefined || query === ''
        ? archive.list({ context: toolContext(ctx, exec, channelDisclosure), includeInactive: args.includeInactive, limit })
        : archive.recall({ context: toolContext(ctx, exec, channelDisclosure), query, limit })
      return Promise.resolve({ memories })
    },
    presentCall: args => ({ card: 'generic', title: 'Review companion memory', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Forget one companion memory only when the owner clearly asks. The value stops being recalled, '
      + 'while an append-only audit event keeps the action recoverable.',
    parameters: {
      memoryId: { type: 'string', required: true, description: 'Exact memory id returned by memory_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { memory: { ...memoryValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Forgot companion memory ${result.memory.id}.` }],
    },
    async execute(args, exec) {
      return {
        memory: await archive.forget({
          context: toolContext(ctx, exec, channelDisclosure),
          memoryId: args.memoryId,
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Forget companion memory', kind: 'delete', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_replace',
    description: 'Correct one companion memory only when the owner clearly supplies the replacement. '
      + 'The previous value stops being recalled and remains in append-only audit history.',
    parameters: {
      memoryId: { type: 'string', required: true, description: 'Exact memory id returned by memory_list.' },
      content: { type: 'string', required: true, description: 'Complete corrected memory content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { memory: { ...memoryValueSchema, required: true } },
      },
      render: (_args, result) => [{ type: 'text', text: `Replaced companion memory ${result.memory.supersedesMemoryId ?? ''}.` }],
    },
    async execute(args, exec) {
      return {
        memory: await archive.replace({
          context: toolContext(ctx, exec, channelDisclosure),
          memoryId: args.memoryId,
          content: args.content,
          sourceMessageId: toolSourceMessageId(exec.callId, exec.agent?.id),
        }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Correct companion memory', kind: 'edit', rawInput: args }),
  }))
}

function memoryGovernanceService(
  eligibility: MemoryOwnerEligibility,
  archive: CompanionMemoryArchive,
): MemoryGovernanceService {
  const identity = eligibility.trustedLocalOwner?.()
  if (identity === undefined) throw new Error('memory governance requires a trusted local Owner adapter')
  const context: MemoryAccessContextV1 = {
    version: 1,
    ownerId: identity.ownerId,
    authority: identity.authority,
    scope: COMPANION_SCOPE,
    channelDisclosure: 'owner-confidential',
    requestIntent: 'explicit-confidential-recall',
  }
  return {
    listCandidates: input => archive.listCandidates({ context, ...input }),
    assessCandidate: input => archive.assessCandidate({ context, ...input }),
    editCandidate: input => archive.editCandidate({ context, ...input }),
    mergeCandidates: input => archive.mergeCandidates({ context, ...input }),
    listGovernanceAudit: input => archive.listGovernanceAudit({ context, ...input }),
    manage: input => archive.manage({ context, ...input }),
    sourceView: input => archive.sourceView({ context, ...input }),
    batchDecide: input => archive.batchDecide({ context, ...input }),
    approveCandidate: input => archive.approveCandidate({ context, ...input }),
    rejectCandidate: input => archive.rejectCandidate({ context, ...input }),
  }
}

/**
 * Observe explicit owner memories and append recalled context through DSH's logged pre-step path.
 * @param ctx - Plugin context with the agent event registry.
 * @param config - Private archive path and recall limit.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const recallLimit = config.recallLimit ?? DEFAULT_RECALL_LIMIT
  const channelDisclosure = config.channelDisclosure ?? 'personal-only'
  if (!Number.isSafeInteger(recallLimit) || recallLimit < 1 || recallLimit > 20) {
    throw new TypeError(`mistymoon-memory: recallLimit must be an integer from 1 through 20, got ${String(recallLimit)}`)
  }
  const maxArchiveBytes = config.maxArchiveBytes ?? 67_108_864
  const maxTransactionBytes = config.maxTransactionBytes ?? 1_048_576
  if (maxTransactionBytes > maxArchiveBytes) {
    throw new TypeError('mistymoon-memory: maxTransactionBytes must not exceed maxArchiveBytes')
  }
  const advancedRetrieval = new AdvancedRetrievalRegistry()
  const derivedViews = new DerivedMemoryViewRegistry()
  const archive = await openMemoryArchive({
    path: config.path,
    leaseTimeoutMs: config.leaseTimeoutMs ?? 30_000,
    leaseStaleMs: config.leaseStaleMs ?? 120_000,
    disposeTimeoutMs: config.disposeTimeoutMs ?? 5_000,
    maxArchiveBytes,
    maxTransactionBytes,
    retrievalEngine: new MemoryRetrievalEngine({ advancedProviderSource: advancedRetrieval }),
    derivedViewInvalidator: derivedViews,
  })
  const extraction = new CandidateExtractionRegistry()
  ctx.effect(() => ctx.provide('mistymoonMemory', archive), 'mistymoon-memory: shared archive')
  ctx.effect(
    () => ctx.provide('mistymoonMemoryCandidateExtraction', extraction),
    'mistymoon-memory: candidate extraction Provider registry',
  )
  ctx.effect(
    () => ctx.provide('mistymoonMemoryAdvancedRetrieval', advancedRetrieval),
    'mistymoon-memory: advanced retrieval Provider registry',
  )
  ctx.effect(
    () => ctx.provide('mistymoonMemoryDerivedViews', derivedViews),
    'mistymoon-memory: derived view invalidation registry',
  )
  ctx.effect(
    () => ctx.provide('mistymoonMemoryGovernance', memoryGovernanceService(ownerEligibility(ctx), archive)),
    'mistymoon-memory: loopback governance facade',
  )
  ctx.effect(() => () => archive.dispose(), 'mistymoon-memory: bounded archive disposal')
  ctx.effect(
    () => ctx.tools.guard((execution) => memoryOwnerGuard(ctx, execution)),
    'mistymoon-memory: Owner Eligibility tool guard',
  )
  registerMemoryTools(ctx, archive, channelDisclosure)
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const ownerMessages = ownerEligibility(ctx).ownerMessages(agent, decision.messages)
    try {
      if (archive.inspection().state !== 'ready') return decision
      for (const message of ownerMessages) {
        const text = userText(message)
        if (text !== '') {
          await archive.observeExplicit({
            context: ownerContext(ownerEligibility(ctx).evaluateMessage(agent, message), channelDisclosure, text),
            sourceMessageId: message.id,
            text,
            memoryKind: 'summary',
          })
        }
      }
      const query = ownerMessages.map(userText).filter(Boolean).join('\n')
      if (query === '') return decision
      const firstOwnerMessage = ownerMessages[0]
      if (firstOwnerMessage === undefined) return decision
      const context = ownerContext(
        ownerEligibility(ctx).evaluateMessage(agent, firstOwnerMessage),
        channelDisclosure,
        query,
      )
      const effectiveRecallLimit = config.settingsPath === undefined
        ? recallLimit
        : (await loadMemoryRuntimeSettings(config.settingsPath, recallLimit)).recallLimit
      const snapshot = await archive.retrieve({ context, query, limit: effectiveRecallLimit })
      if (snapshot.items.length === 0) return decision
      const text = recallSnapshot(snapshot)
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: 'plugin',
              plugin: name,
              form: 'snapshot',
              sections: [{ name: 'memory:recall', text }],
            },
          }),
        ],
      }
    } catch {
      // Memory augmentation is optional for the current DSH turn. Governance
      // commands still surface failures, while the Agent Loop continues without recall.
      return decision
    }
  }, { prepend: true })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const provider = extraction.current()
    if (provider === undefined || archive.inspection().state !== 'ready' || !turnHasCompletedReply(agent, turn)) return
    const eligibility = ownerEligibility(ctx)
    const ownerMessages = currentTurnOwnerMessages(agent, turn, eligibility)
    for (const message of ownerMessages) {
      const text = userText(message)
      if (text === '') continue
      const request: CandidateExtractionRequestV1 = {
        schemaVersion: 1,
        sessionId: String(agent.session.id),
        turn,
        context: ownerContext(eligibility.evaluateMessage(agent, message), channelDisclosure, text),
        evidence: [{ messageId: String(message.id), text }],
      }
      try {
        await extractMemoryCandidates(provider, request, archive, {
          signal,
          timeoutMs: config.extractionTimeoutMs ?? 3_000,
        })
      } catch {
        ctx.logger.warn('mistymoon-memory: optional candidate extraction failed closed')
      }
    }
  })
}
