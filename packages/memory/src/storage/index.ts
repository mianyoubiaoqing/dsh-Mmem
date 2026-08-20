import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { lock as acquireProperLock } from 'proper-lockfile'
import type { MemoryCandidate, MemoryRecord } from '../contracts.js'
import { parseCandidateExtractionReceiptV1 } from '../candidate-extraction.js'
import {
  memoryScopeEquals,
  memorySourceKey,
  parseMemoryKind,
  parseMemoryObservationSourceKind,
  parseMemoryScopeV1,
  validateMemoryValidity,
  type MemoryObservationV1,
  type MemoryObservationSourceKind,
  type MemoryScopeV1,
} from '../domain.js'

export interface MemoryForgottenEvent {
  schemaVersion: 2
  event: 'forgotten'
  id: string
  createdAt: string
  ownerId: string
  scope: MemoryScopeV1
  observationId: string
  memoryId: string
  sourceMessageId: string
}

export interface MemoryCandidateResolutionEvent {
  schemaVersion: 2
  event: 'candidate-resolution'
  id: string
  createdAt: string
  ownerId: string
  scope: MemoryScopeV1
  observationId: string
  candidateId: string
  decision: 'approved' | 'rejected' | 'superseded'
  sourceMessageId: string
  memoryId?: string
  replacementCandidateId?: string
}

export interface MemoryLifecycleEvent {
  schemaVersion: 2
  event: 'lifecycle'
  id: string
  createdAt: string
  ownerId: string
  scope: MemoryScopeV1
  observationId: string
  memoryId: string
  action: 'decay' | 'archive' | 'restore'
  tier: 'hot' | 'cold' | 'archived'
  rankMultiplier: number
  sourceMessageId: string
}

export type MemoryDomainEvent = MemoryObservationV1 | MemoryRecord | MemoryCandidate
  | MemoryForgottenEvent | MemoryCandidateResolutionEvent | MemoryLifecycleEvent

export type ArchiveIssueCode =
  | 'trailing-partial-transaction'
  | 'interior-invalid-json'
  | 'unsupported-archive-version'
  | 'invalid-header'
  | 'invalid-transaction'
  | 'digest-mismatch'
  | 'broken-previous-digest'
  | 'duplicate-id'
  | 'duplicate-source'
  | 'invalid-state-transition'
  | 'unknown-required-event'
  | 'archive-too-large'
  | 'transaction-too-large'
  | 'checkpoint-mismatch'
  | 'scope-migration-required'

export interface ArchiveIssue {
  code: ArchiveIssueCode
  line: number
  offset: number
}

export interface ArchiveInspection {
  state: 'ready' | 'migration-required' | 'scope-migration-required' | 'quarantined'
  format: 'v1' | 'v2' | 'unknown'
  sizeBytes: number
  transactionCount: number
  eventCount: number
  lastValidOffset: number
  digest: string
  issues: ArchiveIssue[]
}

export interface SourceUse {
  kind: 'memory' | 'candidate' | 'forget' | 'replace' | 'approve' | 'reject' | 'lifecycle'
  transactionId: string
  memoryId?: string
  memoryIds?: string[]
  candidateId?: string
  candidateIds?: string[]
  targetMemoryId?: string
  content?: string
  visibility?: 'personal' | 'confidential'
  createdAt?: string
  memoryKind?: MemoryRecord['memoryKind']
  recordedAt?: string
  validFrom?: string
  validTo?: string
}

export interface FoldedMemoryState {
  records: MemoryRecord[]
  candidates: MemoryCandidate[]
  byId: Map<string, MemoryRecord>
  candidateById: Map<string, MemoryCandidate>
  observations: Map<string, MemoryObservationV1>
  eventIds: Set<string>
  sources: Map<string, SourceUse>
}

interface ArchiveHeaderV2 {
  kind: 'mistymoon-memory-archive'
  schemaVersion: 2
  archiveId: string
  createdAt: string
  integrity: {
    algorithm: 'sha256'
    canonicalization: 'sorted-json-v1'
  }
}

interface ArchiveTransactionV2<TEvent = MemoryDomainEvent> {
  kind: 'transaction'
  schemaVersion: 2
  id: string
  committedAt: string
  previousDigest: string
  events: TEvent[]
  digest: string
}

interface ArchiveCheckpointV1 {
  schemaVersion: 1
  archiveDigest: string
  archiveSize: number
  transactionCount: number
  eventCount: number
  lastTransactionDigest: string
}

export interface ParsedArchive {
  inspection: ArchiveInspection
  state?: FoldedMemoryState
  header?: ArchiveHeaderV2
  lastDigest?: string
}

export interface MemoryArchiveStorageOptions {
  path: string
  now?: () => Date
  createTransactionId?: () => string
  leaseTimeoutMs?: number
  leaseStaleMs?: number
  maxArchiveBytes?: number
  maxTransactionBytes?: number
  disposeTimeoutMs?: number
  /** @internal Deterministic lease seam for storage fault tests. */
  leaseAdapter?: ArchiveLeaseAdapter
  /** @internal Deterministic append/fsync seam for storage fault tests. */
  commitWriter?: ArchiveCommitWriter
  /** @internal Deterministic checkpoint seam for storage fault tests. */
  checkpointWriter?: ArchiveCheckpointWriter
}

/** A held archive lease that can report asynchronous compromise before publication. */
export interface ArchiveLease {
  assertHeld(): void
}

/** Options required from the production file-lock implementation. */
export interface ArchiveLeaseAcquireOptions {
  stale: number
  update: number
  retries: { retries: number, minTimeout: number, maxTimeout: number, randomize: boolean }
  realpath: false
  onCompromised: (error: Error) => void
}

/** @internal Injectable acquire primitive used to verify timeout, compromise, and release failures. */
export type ArchiveLeaseAcquire = (
  path: string,
  options: ArchiveLeaseAcquireOptions,
) => Promise<() => Promise<void>>

/** Exclusive cross-process lease boundary. */
export interface ArchiveLeaseAdapter {
  withExclusiveLease<T>(
    path: string,
    timeoutMs: number,
    action: (lease: ArchiveLease) => Promise<T>,
    staleMs?: number,
  ): Promise<T>
}

/** Append one complete transaction and flush its file handle before resolving. */
export interface ArchiveCommitWriter {
  appendAndFlush(path: string, bytes: Buffer): Promise<void>
}

/** Publish the adjacent durability checkpoint for one verified archive generation. */
export interface ArchiveCheckpointWriter {
  write(path: string, parsed: ParsedArchive): Promise<void>
}

export interface ArchiveMutation<T> {
  events: MemoryDomainEvent[]
  result: T
}

export class MemoryArchiveError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'MEMORY_ARCHIVE_MIGRATION_REQUIRED'
      | 'MEMORY_ARCHIVE_SCOPE_MIGRATION_REQUIRED'
      | 'MEMORY_ARCHIVE_QUARANTINED'
      | 'MEMORY_LEASE_TIMEOUT'
      | 'MEMORY_LEASE_COMPROMISED'
      | 'MEMORY_LEASE_RELEASE_FAILED'
      | 'MEMORY_SOURCE_CONFLICT'
      | 'MEMORY_SCOPE_MISMATCH'
      | 'MEMORY_CONFLICT_DECISION_REQUIRED'
      | 'MEMORY_CONFLICT_TARGET_INVALID'
      | 'MEMORY_ARCHIVE_DISPOSED'
      | 'MEMORY_DISPOSE_TIMEOUT',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MemoryArchiveError'
  }
}

/**
 * Build the production lease adapter around a file-lock acquire primitive.
 * Release errors are deliberately surfaced because a caller must not mistake
 * an uncertain lease hand-off for an ordinary successful commit.
 */
export function createFileArchiveLeaseAdapter(
  acquire: ArchiveLeaseAcquire = acquireProperLock as ArchiveLeaseAcquire,
): ArchiveLeaseAdapter {
  return {
    async withExclusiveLease<T>(
      path: string,
      timeoutMs: number,
      action: (lease: ArchiveLease) => Promise<T>,
      staleMs?: number,
    ): Promise<T> {
      const interval = 50
      const effectiveStaleMs = staleMs ?? Math.max(30_000, timeoutMs * 4)
      let compromised: Error | undefined
      let release: (() => Promise<void>)
      try {
        release = await acquire(path, {
          stale: effectiveStaleMs,
          update: Math.max(1_000, Math.floor(effectiveStaleMs / 2)),
          retries: {
            retries: Math.max(0, Math.floor(timeoutMs / interval)),
            minTimeout: interval,
            maxTimeout: interval,
            randomize: false,
          },
          realpath: false,
          onCompromised: error => { compromised = error },
        })
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
        if (code === 'ELOCKED') {
          throw new MemoryArchiveError('memory archive lease acquisition timed out', 'MEMORY_LEASE_TIMEOUT', {
            cause: error,
          })
        }
        throw error
      }
      const lease: ArchiveLease = {
        assertHeld(): void {
          if (compromised !== undefined) {
            throw new MemoryArchiveError('memory archive lease was compromised', 'MEMORY_LEASE_COMPROMISED', {
              cause: compromised,
            })
          }
        },
      }
      let result: T | undefined
      let actionError: unknown
      try {
        lease.assertHeld()
        result = await action(lease)
        lease.assertHeld()
      } catch (error) {
        actionError = error
      }
      try {
        await release()
      } catch (error) {
        throw new MemoryArchiveError('memory archive lease release failed', 'MEMORY_LEASE_RELEASE_FAILED', {
          cause: actionError ?? error,
        })
      }
      if (actionError !== undefined) throw actionError
      return result as T
    },
  }
}

const fileArchiveLeaseAdapter = createFileArchiveLeaseAdapter()

class FormatIssue extends Error {
  constructor(readonly issue: ArchiveIssue) {
    super(issue.code)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('value must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('value must be a non-empty string')
  return value
}

interface LegacyMemoryRecordV1 {
  schemaVersion: 1
  id: string
  createdAt: string
  content: string
  visibility: 'personal' | 'confidential'
  sourceMessageId: string
  sourceCandidateId?: string
  supersedesMemoryId?: string
  status: 'confirmed'
}

interface LegacyMemoryCandidateV1 {
  schemaVersion: 1
  event: 'candidate'
  id: string
  createdAt: string
  content: string
  visibility: 'personal' | 'confidential'
  sourceMessageId: string
  status: 'pending'
}

interface LegacyMemoryForgottenEventV1 {
  schemaVersion: 1
  event: 'forgotten'
  id: string
  createdAt: string
  memoryId: string
  sourceMessageId: string
}

interface LegacyMemoryCandidateResolutionEventV1 {
  schemaVersion: 1
  event: 'candidate-resolution'
  id: string
  createdAt: string
  candidateId: string
  decision: 'approved' | 'rejected'
  sourceMessageId: string
  memoryId?: string
}

type LegacyMemoryDomainEventV1 = LegacyMemoryRecordV1 | LegacyMemoryCandidateV1
  | LegacyMemoryForgottenEventV1 | LegacyMemoryCandidateResolutionEventV1

function exactDomainKeys(entry: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in entry)) || Object.keys(entry).some(key => !allowed.has(key))) {
    throw new Error('domain event contains missing or unknown fields')
  }
}

function timestamp(value: unknown): string {
  return validateMemoryValidity({ recordedAt: requiredString(value) }).recordedAt
}

function visibility(value: unknown): 'personal' | 'confidential' {
  if (value !== 'personal' && value !== 'confidential') throw new Error('unsupported visibility')
  return value
}

function rankMultiplier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 1) {
    throw new Error('rank multiplier must be from 0.1 through 1')
  }
  return value
}

function parseLegacyDomainEvent(value: unknown, line: number, offset: number): LegacyMemoryDomainEventV1 {
  let entry: Record<string, unknown>
  try {
    entry = record(value)
  } catch {
    throw new FormatIssue({ code: 'invalid-transaction', line, offset })
  }
  if (entry.schemaVersion !== 1) {
    throw new FormatIssue({ code: 'unknown-required-event', line, offset })
  }
  try {
    if (entry.event === 'forgotten') {
      return {
        schemaVersion: 1,
        event: 'forgotten',
        id: requiredString(entry.id),
        createdAt: requiredString(entry.createdAt),
        memoryId: requiredString(entry.memoryId),
        sourceMessageId: requiredString(entry.sourceMessageId),
      }
    }
    if (entry.event === 'candidate') {
      if (entry.status !== 'pending') throw new Error('candidate must start pending')
      if (entry.visibility !== 'personal' && entry.visibility !== 'confidential') throw new Error('unsupported visibility')
      return {
        schemaVersion: 1,
        event: 'candidate',
        id: requiredString(entry.id),
        createdAt: requiredString(entry.createdAt),
        content: requiredString(entry.content),
        visibility: entry.visibility,
        sourceMessageId: requiredString(entry.sourceMessageId),
        status: 'pending',
      }
    }
    if (entry.event === 'candidate-resolution') {
      if (entry.decision !== 'approved' && entry.decision !== 'rejected') throw new Error('unsupported decision')
      return {
        schemaVersion: 1,
        event: 'candidate-resolution',
        id: requiredString(entry.id),
        createdAt: requiredString(entry.createdAt),
        candidateId: requiredString(entry.candidateId),
        decision: entry.decision,
        sourceMessageId: requiredString(entry.sourceMessageId),
        ...(entry.memoryId === undefined ? {} : { memoryId: requiredString(entry.memoryId) }),
      }
    }
    if (entry.event !== undefined) throw new FormatIssue({ code: 'unknown-required-event', line, offset })
    if (entry.status !== 'confirmed') throw new Error('memory must start confirmed')
    if (entry.visibility !== 'personal' && entry.visibility !== 'confidential') throw new Error('unsupported visibility')
    return {
      schemaVersion: 1,
      id: requiredString(entry.id),
      createdAt: requiredString(entry.createdAt),
      content: requiredString(entry.content),
      visibility: entry.visibility,
      sourceMessageId: requiredString(entry.sourceMessageId),
      ...(entry.sourceCandidateId === undefined ? {} : { sourceCandidateId: requiredString(entry.sourceCandidateId) }),
      ...(entry.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: requiredString(entry.supersedesMemoryId) }),
      status: 'confirmed',
    }
  } catch (error) {
    if (error instanceof FormatIssue) throw error
    throw new FormatIssue({ code: 'invalid-transaction', line, offset })
  }
}

function parseDomainEvent(value: unknown, line: number, offset: number): MemoryDomainEvent {
  let entry: Record<string, unknown>
  try {
    entry = record(value)
  } catch {
    throw new FormatIssue({ code: 'invalid-transaction', line, offset })
  }
  try {
    if (entry.schemaVersion === 1 && entry.event === 'observation') {
      exactDomainKeys(entry, [
        'schemaVersion', 'event', 'id', 'ownerId', 'authority', 'scope', 'source', 'observedAt',
      ])
      const source = record(entry.source)
      exactDomainKeys(source, ['kind', 'id'])
      return {
        schemaVersion: 1,
        event: 'observation',
        id: requiredString(entry.id),
        ownerId: requiredString(entry.ownerId),
        authority: requiredString(entry.authority),
        scope: parseMemoryScopeV1(entry.scope),
        source: {
          kind: parseMemoryObservationSourceKind(source.kind),
          id: requiredString(source.id),
        },
        observedAt: timestamp(entry.observedAt),
      }
    }
    if (entry.schemaVersion !== 2) throw new FormatIssue({ code: 'unknown-required-event', line, offset })
    if (entry.event === 'forgotten') {
      exactDomainKeys(entry, [
        'schemaVersion', 'event', 'id', 'createdAt', 'ownerId', 'scope', 'observationId', 'memoryId', 'sourceMessageId',
      ])
      return {
        schemaVersion: 2,
        event: 'forgotten',
        id: requiredString(entry.id),
        createdAt: timestamp(entry.createdAt),
        ownerId: requiredString(entry.ownerId),
        scope: parseMemoryScopeV1(entry.scope),
        observationId: requiredString(entry.observationId),
        memoryId: requiredString(entry.memoryId),
        sourceMessageId: requiredString(entry.sourceMessageId),
      }
    }
    if (entry.event === 'lifecycle') {
      exactDomainKeys(entry, [
        'schemaVersion', 'event', 'id', 'createdAt', 'ownerId', 'scope', 'observationId',
        'memoryId', 'action', 'tier', 'rankMultiplier', 'sourceMessageId',
      ])
      if (entry.action !== 'decay' && entry.action !== 'archive' && entry.action !== 'restore') {
        throw new Error('unsupported lifecycle action')
      }
      if (entry.tier !== 'hot' && entry.tier !== 'cold' && entry.tier !== 'archived') {
        throw new Error('unsupported memory recall tier')
      }
      return {
        schemaVersion: 2,
        event: 'lifecycle',
        id: requiredString(entry.id),
        createdAt: timestamp(entry.createdAt),
        ownerId: requiredString(entry.ownerId),
        scope: parseMemoryScopeV1(entry.scope),
        observationId: requiredString(entry.observationId),
        memoryId: requiredString(entry.memoryId),
        action: entry.action,
        tier: entry.tier,
        rankMultiplier: rankMultiplier(entry.rankMultiplier),
        sourceMessageId: requiredString(entry.sourceMessageId),
      }
    }
    if (entry.event === 'candidate-resolution') {
      exactDomainKeys(entry, [
        'schemaVersion', 'event', 'id', 'createdAt', 'ownerId', 'scope', 'observationId', 'candidateId',
        'decision', 'sourceMessageId',
      ], ['memoryId', 'replacementCandidateId'])
      if (entry.decision !== 'approved' && entry.decision !== 'rejected' && entry.decision !== 'superseded') {
        throw new Error('unsupported decision')
      }
      return {
        schemaVersion: 2,
        event: 'candidate-resolution',
        id: requiredString(entry.id),
        createdAt: timestamp(entry.createdAt),
        ownerId: requiredString(entry.ownerId),
        scope: parseMemoryScopeV1(entry.scope),
        observationId: requiredString(entry.observationId),
        candidateId: requiredString(entry.candidateId),
        decision: entry.decision,
        sourceMessageId: requiredString(entry.sourceMessageId),
        ...(entry.memoryId === undefined ? {} : { memoryId: requiredString(entry.memoryId) }),
        ...(entry.replacementCandidateId === undefined ? {} : {
          replacementCandidateId: requiredString(entry.replacementCandidateId),
        }),
      }
    }
    if (entry.event !== undefined && entry.event !== 'candidate') {
      throw new FormatIssue({ code: 'unknown-required-event', line, offset })
    }
    const commonRequired = [
      'schemaVersion', 'id', 'createdAt', 'ownerId', 'scope', 'observationId', 'memoryKind',
      'recordedAt', 'content', 'visibility', 'sourceMessageId', 'status',
    ] as const
    const validity = validateMemoryValidity({
      recordedAt: requiredString(entry.recordedAt),
      ...(entry.validFrom === undefined ? {} : { validFrom: requiredString(entry.validFrom) }),
      ...(entry.validTo === undefined ? {} : { validTo: requiredString(entry.validTo) }),
    })
    const common = {
      schemaVersion: 2 as const,
      id: requiredString(entry.id),
      createdAt: timestamp(entry.createdAt),
      ownerId: requiredString(entry.ownerId),
      scope: parseMemoryScopeV1(entry.scope),
      observationId: requiredString(entry.observationId),
      memoryKind: parseMemoryKind(entry.memoryKind),
      ...validity,
      content: requiredString(entry.content),
      visibility: visibility(entry.visibility),
      sourceMessageId: requiredString(entry.sourceMessageId),
    }
    if (entry.event === 'candidate') {
      exactDomainKeys(entry, [...commonRequired, 'event'], ['validFrom', 'validTo', 'extraction', 'sourceCandidateIds'])
      if (entry.status !== 'pending') throw new Error('candidate must start pending')
      let sourceCandidateIds: string[] | undefined
      if (entry.sourceCandidateIds !== undefined) {
        if (!Array.isArray(entry.sourceCandidateIds) || entry.sourceCandidateIds.length === 0) {
          throw new Error('candidate source lineage must be a non-empty array')
        }
        sourceCandidateIds = entry.sourceCandidateIds.map(requiredString)
        if (new Set(sourceCandidateIds).size !== sourceCandidateIds.length) throw new Error('candidate source lineage must be unique')
      }
      let extraction: MemoryCandidate['extraction']
      if (entry.extraction !== undefined) {
        const value = record(entry.extraction)
        exactDomainKeys(value, ['schemaVersion', 'providerId', 'providerVersion', 'receipt'])
        if (value.schemaVersion !== 1) throw new Error('unsupported extraction metadata')
        extraction = {
          schemaVersion: 1,
          providerId: requiredString(value.providerId),
          providerVersion: requiredString(value.providerVersion),
          receipt: parseCandidateExtractionReceiptV1(value.receipt),
        }
      }
      return {
        ...common,
        event: 'candidate',
        status: 'pending',
        ...(sourceCandidateIds === undefined ? {} : { sourceCandidateIds }),
        ...(extraction === undefined ? {} : { extraction }),
      }
    }
    if (entry.event !== undefined) throw new FormatIssue({ code: 'unknown-required-event', line, offset })
    exactDomainKeys(entry, commonRequired, [
      'validFrom', 'validTo', 'sourceCandidateId', 'supersedesMemoryId', 'sourceMemoryIds',
    ])
    if (entry.status !== 'confirmed') throw new Error('memory must start confirmed')
    let sourceMemoryIds: string[] | undefined
    if (entry.sourceMemoryIds !== undefined) {
      if (!Array.isArray(entry.sourceMemoryIds) || entry.sourceMemoryIds.length < 2) {
        throw new Error('summary source lineage must contain at least two memory IDs')
      }
      sourceMemoryIds = entry.sourceMemoryIds.map(requiredString)
      if (new Set(sourceMemoryIds).size !== sourceMemoryIds.length) {
        throw new Error('summary source lineage must be unique')
      }
    }
    return {
      ...common,
      ...(entry.sourceCandidateId === undefined ? {} : { sourceCandidateId: requiredString(entry.sourceCandidateId) }),
      ...(entry.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: requiredString(entry.supersedesMemoryId) }),
      ...(sourceMemoryIds === undefined ? {} : { sourceMemoryIds }),
      status: 'confirmed',
    }
  } catch (error) {
    if (error instanceof FormatIssue) throw error
    throw new FormatIssue({ code: 'invalid-transaction', line, offset })
  }
}

function emptyState(): FoldedMemoryState {
  return {
    records: [],
    candidates: [],
    byId: new Map(),
    candidateById: new Map(),
    observations: new Map(),
    eventIds: new Set(),
    sources: new Map(),
  }
}

function cloneMemory(memory: MemoryRecord): MemoryRecord {
  return {
    ...memory,
    ...(memory.sourceMemoryIds === undefined ? {} : { sourceMemoryIds: [...memory.sourceMemoryIds] }),
    ...(memory.lifecycle === undefined ? {} : { lifecycle: { ...memory.lifecycle } }),
  }
}

function cloneCandidate(candidate: MemoryCandidate): MemoryCandidate {
  return {
    ...candidate,
    ...(candidate.sourceCandidateIds === undefined ? {} : { sourceCandidateIds: [...candidate.sourceCandidateIds] }),
    ...(candidate.extraction === undefined ? {} : {
      extraction: {
        ...candidate.extraction,
        receipt: { ...candidate.extraction.receipt },
      },
    }),
  }
}

export function cloneFoldedState(source: FoldedMemoryState): FoldedMemoryState {
  const records = source.records.map(cloneMemory)
  const candidates = source.candidates.map(cloneCandidate)
  return {
    records,
    candidates,
    byId: new Map(records.map(memory => [memory.id, memory])),
    candidateById: new Map(candidates.map(candidate => [candidate.id, candidate])),
    observations: new Map([...source.observations].map(([id, observation]) => [id, {
      ...observation,
      scope: { ...observation.scope },
      source: { ...observation.source },
    }])),
    eventIds: new Set(source.eventIds),
    sources: new Map([...source.sources].map(([id, use]) => [id, {
      ...use,
      ...(use.candidateIds === undefined ? {} : { candidateIds: [...use.candidateIds] }),
      ...(use.memoryIds === undefined ? {} : { memoryIds: [...use.memoryIds] }),
    }])),
  }
}

function issue(code: ArchiveIssueCode, line: number, offset: number): never {
  throw new FormatIssue({ code, line, offset })
}

function reserveId(state: FoldedMemoryState, id: string, line: number, offset: number): void {
  if (state.eventIds.has(id)) issue('duplicate-id', line, offset)
  state.eventIds.add(id)
}

function reserveSource(
  state: FoldedMemoryState,
  sourceKey: string,
  use: SourceUse,
  line: number,
  offset: number,
  allowApprovalPair = false,
): void {
  const existing = state.sources.get(sourceKey)
  if (existing === undefined) {
    state.sources.set(sourceKey, use)
    return
  }
  if (allowApprovalPair && existing.transactionId === use.transactionId && existing.kind === 'approve') return
  issue('duplicate-source', line, offset)
}

function eventObservation(
  state: FoldedMemoryState,
  event: Exclude<MemoryDomainEvent, MemoryObservationV1>,
  line: number,
  offset: number,
): { observation: MemoryObservationV1; sourceKey: string } {
  const observation = state.observations.get(event.observationId)
  if (observation === undefined || observation.ownerId !== event.ownerId
    || !memoryScopeEquals(observation.scope, event.scope)) {
    issue('invalid-state-transition', line, offset)
  }
  return { observation, sourceKey: memorySourceKey(observation) }
}

function foldEvent(
  state: FoldedMemoryState,
  event: MemoryDomainEvent,
  transactionId: string,
  line: number,
  offset: number,
): void {
  reserveId(state, event.id, line, offset)
  if (event.schemaVersion === 1 && event.event === 'observation') {
    const sourceKey = memorySourceKey(event)
    if (state.sources.has(sourceKey)) issue('duplicate-source', line, offset)
    state.observations.set(event.id, event)
    return
  }
  if ('event' in event && event.event === 'forgotten') {
    const { sourceKey } = eventObservation(state, event, line, offset)
    const target = state.byId.get(event.memoryId)
    if (target === undefined || target.status !== 'confirmed' || target.ownerId !== event.ownerId
      || !memoryScopeEquals(target.scope, event.scope)) issue('invalid-state-transition', line, offset)
    reserveSource(state, sourceKey, {
      kind: 'forget', transactionId, memoryId: target.id, targetMemoryId: target.id,
    }, line, offset)
    target.status = 'forgotten'
    return
  }
  if ('event' in event && event.event === 'lifecycle') {
    const { observation, sourceKey } = eventObservation(state, event, line, offset)
    const target = state.byId.get(event.memoryId)
    if (target === undefined || target.status !== 'confirmed' || target.ownerId !== event.ownerId
      || !memoryScopeEquals(target.scope, event.scope)) issue('invalid-state-transition', line, offset)
    const targetObservation = state.observations.get(target.observationId)
    if (targetObservation?.authority !== observation.authority) issue('invalid-state-transition', line, offset)
    const currentTier = target.lifecycle?.tier ?? 'hot'
    const currentMultiplier = target.lifecycle?.rankMultiplier ?? 1
    if (event.action === 'decay') {
      if (event.tier !== 'cold' || currentTier === 'archived'
        || target.memoryKind === 'boundary' || target.memoryKind === 'commitment' || target.memoryKind === 'state'
        || event.rankMultiplier > currentMultiplier) issue('invalid-state-transition', line, offset)
    } else if (event.action === 'archive') {
      if (event.tier !== 'archived' || currentTier === 'archived'
        || event.rankMultiplier !== currentMultiplier) issue('invalid-state-transition', line, offset)
    } else if (currentTier !== 'archived' || event.tier === 'archived'
      || event.rankMultiplier !== currentMultiplier) {
      issue('invalid-state-transition', line, offset)
    }
    const existing = state.sources.get(sourceKey)
    if (existing === undefined) {
      state.sources.set(sourceKey, {
        kind: 'lifecycle', transactionId, memoryId: target.id, memoryIds: [target.id],
      })
    } else if (existing.kind === 'lifecycle' && existing.transactionId === transactionId) {
      if (existing.memoryIds?.includes(target.id)) issue('invalid-state-transition', line, offset)
      existing.memoryIds = [...(existing.memoryIds ?? []), target.id]
    } else {
      issue('duplicate-source', line, offset)
    }
    target.lifecycle = {
      tier: event.tier,
      rankMultiplier: event.rankMultiplier,
      updatedAt: event.createdAt,
    }
    return
  }
  if ('event' in event && event.event === 'candidate') {
    const { sourceKey } = eventObservation(state, event, line, offset)
    if (event.sourceCandidateIds !== undefined) {
      for (const sourceCandidateId of event.sourceCandidateIds) {
        const source = state.candidateById.get(sourceCandidateId)
        if (source === undefined || source.status !== 'pending' || source.ownerId !== event.ownerId
          || !memoryScopeEquals(source.scope, event.scope)) issue('invalid-state-transition', line, offset)
      }
    }
    const existing = state.sources.get(sourceKey)
    if (existing === undefined) {
      state.sources.set(sourceKey, {
        kind: 'candidate', transactionId, candidateId: event.id, candidateIds: [event.id], content: event.content,
        visibility: event.visibility, memoryKind: event.memoryKind, recordedAt: event.recordedAt,
        validFrom: event.validFrom, validTo: event.validTo,
      })
    } else if (existing.kind === 'candidate' && existing.transactionId === transactionId) {
      existing.candidateIds = [...(existing.candidateIds ?? (existing.candidateId === undefined ? [] : [existing.candidateId])), event.id]
    } else {
      issue('duplicate-source', line, offset)
    }
    state.candidates.push(event)
    state.candidateById.set(event.id, event)
    return
  }
  if ('event' in event && event.event === 'candidate-resolution') {
    const { sourceKey } = eventObservation(state, event, line, offset)
    const candidate = state.candidateById.get(event.candidateId)
    if (candidate === undefined || candidate.status !== 'pending' || candidate.ownerId !== event.ownerId
      || !memoryScopeEquals(candidate.scope, event.scope)) issue('invalid-state-transition', line, offset)
    if (event.decision === 'approved') {
      const memory = event.memoryId === undefined ? undefined : state.byId.get(event.memoryId)
      const source = state.sources.get(sourceKey)
      if (memory === undefined || memory.sourceCandidateId !== candidate.id || source?.kind !== 'approve'
        || source.transactionId !== transactionId || source.memoryId !== memory.id) {
        issue('invalid-state-transition', line, offset)
      }
      reserveSource(state, sourceKey, source, line, offset, true)
      candidate.status = 'approved'
    } else if (event.decision === 'rejected') {
      reserveSource(state, sourceKey, {
        kind: 'reject', transactionId, candidateId: candidate.id,
      }, line, offset)
      candidate.status = 'rejected'
    } else {
      const replacement = event.replacementCandidateId === undefined
        ? undefined
        : state.candidateById.get(event.replacementCandidateId)
      const source = state.sources.get(sourceKey)
      if (replacement === undefined || replacement.status !== 'pending'
        || !replacement.sourceCandidateIds?.includes(candidate.id)
        || source?.kind !== 'candidate' || source.transactionId !== transactionId
        || source.candidateId !== replacement.id) issue('invalid-state-transition', line, offset)
      candidate.status = 'superseded'
    }
    return
  }
  const memory = event
  const { observation, sourceKey } = eventObservation(state, memory, line, offset)
  if (memory.sourceMemoryIds !== undefined) {
    if (memory.memoryKind !== 'summary' || memory.sourceCandidateId !== undefined
      || memory.supersedesMemoryId !== undefined) issue('invalid-state-transition', line, offset)
    const sources = memory.sourceMemoryIds.map(memoryId => state.byId.get(memoryId))
    if (sources.some(source => source === undefined || source.sourceMemoryIds !== undefined
      || source.status !== 'confirmed' || source.ownerId !== memory.ownerId
      || !memoryScopeEquals(source.scope, memory.scope)
      || state.observations.get(source.observationId)?.authority !== observation.authority)) {
      issue('invalid-state-transition', line, offset)
    }
    if (sources.some(source => source?.visibility === 'confidential') && memory.visibility !== 'confidential') {
      issue('invalid-state-transition', line, offset)
    }
  }
  if (memory.sourceCandidateId !== undefined) {
    const candidate = state.candidateById.get(memory.sourceCandidateId)
    if (candidate === undefined || candidate.status !== 'pending' || candidate.ownerId !== memory.ownerId
      || !memoryScopeEquals(candidate.scope, memory.scope)) issue('invalid-state-transition', line, offset)
    let targetMemoryId: string | undefined
    if (memory.supersedesMemoryId !== undefined) {
      const target = state.byId.get(memory.supersedesMemoryId)
      if (target === undefined || target.status !== 'confirmed' || target.ownerId !== memory.ownerId
        || !memoryScopeEquals(target.scope, memory.scope)) issue('invalid-state-transition', line, offset)
      target.status = 'superseded'
      targetMemoryId = target.id
    }
    reserveSource(state, sourceKey, {
      kind: 'approve', transactionId, memoryId: memory.id, candidateId: candidate.id,
      ...(targetMemoryId === undefined ? {} : { targetMemoryId }),
      content: memory.content, visibility: memory.visibility, memoryKind: memory.memoryKind,
      recordedAt: memory.recordedAt, validFrom: memory.validFrom, validTo: memory.validTo,
    }, line, offset)
  } else if (memory.supersedesMemoryId !== undefined) {
    const target = state.byId.get(memory.supersedesMemoryId)
    if (target === undefined || target.status !== 'confirmed' || target.ownerId !== memory.ownerId
      || !memoryScopeEquals(target.scope, memory.scope)) issue('invalid-state-transition', line, offset)
    reserveSource(state, sourceKey, {
      kind: 'replace', transactionId, memoryId: memory.id, targetMemoryId: target.id,
      content: memory.content, visibility: memory.visibility, memoryKind: memory.memoryKind,
      recordedAt: memory.recordedAt, validFrom: memory.validFrom, validTo: memory.validTo,
    }, line, offset)
    target.status = 'superseded'
  } else {
    reserveSource(state, sourceKey, {
      kind: 'memory', transactionId, memoryId: memory.id, content: memory.content,
      visibility: memory.visibility, createdAt: memory.createdAt, memoryKind: memory.memoryKind,
      recordedAt: memory.recordedAt, validFrom: memory.validFrom, validTo: memory.validTo,
    }, line, offset)
  }
  state.records.push(memory)
  state.byId.set(memory.id, memory)
}

function foldTransactions(transactions: readonly ArchiveTransactionV2<MemoryDomainEvent>[]): FoldedMemoryState {
  const state = emptyState()
  for (const [transactionIndex, transaction] of transactions.entries()) {
    for (const event of transaction.events) {
      foldEvent(state, { ...event }, transaction.id, transactionIndex + 2, 0)
    }
  }
  return state
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().filter(key => source[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalValue(source[key])}`).join(',')}}`
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`)
}

/** Canonical sorted JSON used by the v2 integrity protocol. */
export function canonicalArchiveJson(value: unknown): string {
  return canonicalValue(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalValue(value), 'utf8').digest('hex')
}

function headerDigest(header: ArchiveHeaderV2): string {
  return digest(header)
}

function transactionDigest<TEvent>(transaction: Omit<ArchiveTransactionV2<TEvent>, 'digest'>): string {
  return digest(transaction)
}

function contentDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function lineOffsets(bytes: Buffer): Array<{ bytes: Buffer, line: number, offset: number, complete: boolean }> {
  const lines: Array<{ bytes: Buffer, line: number, offset: number, complete: boolean }> = []
  let offset = 0
  let line = 1
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset)
    if (newline < 0) {
      lines.push({ bytes: bytes.subarray(offset), line, offset, complete: false })
      break
    }
    const end = newline > offset && bytes[newline - 1] === 0x0d ? newline - 1 : newline
    lines.push({ bytes: bytes.subarray(offset, end), line, offset, complete: true })
    offset = newline + 1
    line += 1
  }
  return lines
}

function quarantine(
  bytes: Buffer,
  format: ArchiveInspection['format'],
  transactions: number,
  events: number,
  lastValidOffset: number,
  issueValue: ArchiveIssue,
): ParsedArchive {
  return {
    inspection: {
      state: 'quarantined',
      format,
      sizeBytes: bytes.length,
      transactionCount: transactions,
      eventCount: events,
      lastValidOffset,
      digest: contentDigest(bytes),
      issues: [issueValue],
    },
  }
}

function validateLegacyTransactions(
  transactions: readonly ArchiveTransactionV2<LegacyMemoryDomainEventV1>[],
): void {
  const ids = new Set<string>()
  const sources = new Map<string, { transactionId: string; kind: SourceUse['kind']; memoryId?: string }>()
  const memories = new Map<string, Omit<LegacyMemoryRecordV1, 'status'> & { status: MemoryRecord['status'] }>()
  const candidates = new Map<string, Omit<LegacyMemoryCandidateV1, 'status'> & { status: MemoryCandidate['status'] }>()
  for (const [transactionIndex, transaction] of transactions.entries()) {
    const line = transactionIndex + 2
    for (const event of transaction.events) {
      if (ids.has(event.id)) issue('duplicate-id', line, 0)
      ids.add(event.id)
      if ('event' in event && event.event === 'forgotten') {
        const target = memories.get(event.memoryId)
        if (target === undefined || target.status !== 'confirmed' || sources.has(event.sourceMessageId)) {
          issue('invalid-state-transition', line, 0)
        }
        sources.set(event.sourceMessageId, { transactionId: transaction.id, kind: 'forget', memoryId: target.id })
        target.status = 'forgotten'
        continue
      }
      if ('event' in event && event.event === 'candidate') {
        if (sources.has(event.sourceMessageId)) issue('duplicate-source', line, 0)
        sources.set(event.sourceMessageId, { transactionId: transaction.id, kind: 'candidate' })
        candidates.set(event.id, { ...event })
        continue
      }
      if ('event' in event && event.event === 'candidate-resolution') {
        const candidate = candidates.get(event.candidateId)
        if (candidate === undefined || candidate.status !== 'pending') issue('invalid-state-transition', line, 0)
        const source = sources.get(event.sourceMessageId)
        if (event.decision === 'approved') {
          const memory = event.memoryId === undefined ? undefined : memories.get(event.memoryId)
          if (memory === undefined || memory.sourceCandidateId !== candidate.id || source?.kind !== 'approve'
            || source.transactionId !== transaction.id || source.memoryId !== memory.id) {
            issue('invalid-state-transition', line, 0)
          }
          candidate.status = 'approved'
        } else {
          if (source !== undefined) issue('duplicate-source', line, 0)
          sources.set(event.sourceMessageId, { transactionId: transaction.id, kind: 'reject' })
          candidate.status = 'rejected'
        }
        continue
      }
      const memory = { ...event } as Omit<LegacyMemoryRecordV1, 'status'> & { status: MemoryRecord['status'] }
      const existingSource = sources.get(memory.sourceMessageId)
      if (memory.sourceCandidateId !== undefined) {
        const candidate = candidates.get(memory.sourceCandidateId)
        if (candidate === undefined || candidate.status !== 'pending' || existingSource !== undefined) {
          issue('invalid-state-transition', line, 0)
        }
        sources.set(memory.sourceMessageId, { transactionId: transaction.id, kind: 'approve', memoryId: memory.id })
      } else if (memory.supersedesMemoryId !== undefined) {
        const target = memories.get(memory.supersedesMemoryId)
        if (target === undefined || target.status !== 'confirmed' || existingSource !== undefined) {
          issue('invalid-state-transition', line, 0)
        }
        sources.set(memory.sourceMessageId, { transactionId: transaction.id, kind: 'replace', memoryId: memory.id })
        target.status = 'superseded'
      } else {
        if (existingSource !== undefined) issue('duplicate-source', line, 0)
        sources.set(memory.sourceMessageId, { transactionId: transaction.id, kind: 'memory', memoryId: memory.id })
      }
      memories.set(memory.id, memory)
    }
  }
}

export function inspectArchiveBytes(
  bytes: Buffer,
  limits: { maxArchiveBytes: number, maxTransactionBytes: number },
): ParsedArchive {
  if (bytes.length > limits.maxArchiveBytes) {
    return quarantine(bytes, 'unknown', 0, 0, 0, { code: 'archive-too-large', line: 1, offset: 0 })
  }
  const lines = lineOffsets(bytes)
  if (lines.length === 0) {
    return {
      inspection: {
        state: 'ready', format: 'v2', sizeBytes: 0, transactionCount: 0, eventCount: 0,
        lastValidOffset: 0, digest: contentDigest(bytes), issues: [],
      },
      state: emptyState(),
    }
  }
  let first: Record<string, unknown>
  try {
    first = record(JSON.parse(lines[0]!.bytes.toString('utf8')) as unknown)
  } catch {
    const code = lines[0]!.complete ? 'interior-invalid-json' : 'trailing-partial-transaction'
    return quarantine(bytes, 'unknown', 0, 0, 0, { code, line: 1, offset: 0 })
  }
  if (first.schemaVersion === 1) {
    const legacyEvents: LegacyMemoryDomainEventV1[] = []
    try {
      for (const line of lines) {
        if (line.bytes.length === 0) continue
        if (!line.complete) issue('trailing-partial-transaction', line.line, line.offset)
        let value: unknown
        try {
          value = JSON.parse(line.bytes.toString('utf8')) as unknown
        } catch {
          issue('interior-invalid-json', line.line, line.offset)
        }
        legacyEvents.push(parseLegacyDomainEvent(value, line.line, line.offset))
      }
      validateLegacyTransactions([{
        kind: 'transaction', schemaVersion: 2, id: 'legacy-v1', committedAt: '1970-01-01T00:00:00.000Z',
        previousDigest: '', events: legacyEvents, digest: '',
      }])
      return {
        inspection: {
          state: 'scope-migration-required', format: 'v1', sizeBytes: bytes.length, transactionCount: 0,
          eventCount: legacyEvents.length, lastValidOffset: bytes.length, digest: contentDigest(bytes),
          issues: [{ code: 'scope-migration-required', line: 1, offset: 0 }],
        },
      }
    } catch (error) {
      const found = error instanceof FormatIssue
        ? error.issue
        : { code: 'invalid-transaction' as const, line: 1, offset: 0 }
      return quarantine(bytes, 'v1', 0, legacyEvents.length, 0, found)
    }
  }
  if (first.schemaVersion !== 2 || first.kind !== 'mistymoon-memory-archive') {
    return quarantine(bytes, 'unknown', 0, 0, 0, { code: 'unsupported-archive-version', line: 1, offset: 0 })
  }
  let header: ArchiveHeaderV2
  try {
    const integrity = record(first.integrity)
    if (integrity.algorithm !== 'sha256' || integrity.canonicalization !== 'sorted-json-v1') throw new Error()
    header = {
      kind: 'mistymoon-memory-archive', schemaVersion: 2,
      archiveId: requiredString(first.archiveId), createdAt: requiredString(first.createdAt),
      integrity: { algorithm: 'sha256', canonicalization: 'sorted-json-v1' },
    }
  } catch {
    return quarantine(bytes, 'v2', 0, 0, 0, { code: 'invalid-header', line: 1, offset: 0 })
  }
  const transactions: ArchiveTransactionV2<MemoryDomainEvent>[] = []
  const legacyTransactions: ArchiveTransactionV2<LegacyMemoryDomainEventV1>[] = []
  let domainGeneration: 'unknown' | 'legacy' | 'scoped' = 'unknown'
  let previousDigest = headerDigest(header)
  let eventCount = 0
  let lastValidOffset = lines[0]!.offset + lines[0]!.bytes.length + (lines[0]!.complete ? 1 : 0)
  for (const line of lines.slice(1)) {
    if (line.bytes.length === 0 && line.complete) {
      lastValidOffset = line.offset + 1
      continue
    }
    if (line.bytes.length > limits.maxTransactionBytes) {
      return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, {
        code: 'transaction-too-large', line: line.line, offset: line.offset,
      })
    }
    if (!line.complete) {
      return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, {
        code: 'trailing-partial-transaction', line: line.line, offset: line.offset,
      })
    }
    let value: Record<string, unknown>
    try {
      value = record(JSON.parse(line.bytes.toString('utf8')) as unknown)
    } catch {
      return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, {
        code: 'interior-invalid-json', line: line.line, offset: line.offset,
      })
    }
    let transaction: ArchiveTransactionV2<MemoryDomainEvent>
    try {
      if (value.kind !== 'transaction' || value.schemaVersion !== 2 || !Array.isArray(value.events) || value.events.length === 0) {
        issue('invalid-transaction', line.line, line.offset)
      }
      const legacyFlags = value.events.map(event => {
        const entry = record(event)
        return entry.schemaVersion === 1 && entry.event !== 'observation'
      })
      const hasLegacy = legacyFlags.some(Boolean)
      const hasScoped = legacyFlags.some(flag => !flag)
      if (hasLegacy && hasScoped) issue('invalid-transaction', line.line, line.offset)
      if ((hasLegacy && domainGeneration === 'scoped') || (hasScoped && domainGeneration === 'legacy')) {
        issue('invalid-state-transition', line.line, line.offset)
      }
      domainGeneration = hasLegacy ? 'legacy' : 'scoped'
      const events = hasLegacy
        ? value.events.map(event => parseLegacyDomainEvent(event, line.line, line.offset))
        : value.events.map(event => parseDomainEvent(event, line.line, line.offset))
      transaction = {
        kind: 'transaction', schemaVersion: 2, id: requiredString(value.id),
        committedAt: requiredString(value.committedAt), previousDigest: requiredString(value.previousDigest),
        events: events as MemoryDomainEvent[], digest: requiredString(value.digest),
      }
      if (transaction.previousDigest !== previousDigest) issue('broken-previous-digest', line.line, line.offset)
      const { digest: suppliedDigest, ...unsigned } = transaction
      if (transactionDigest(unsigned) !== suppliedDigest) issue('digest-mismatch', line.line, line.offset)
      if (hasLegacy) {
        const legacyTransaction = { ...transaction, events: events as LegacyMemoryDomainEventV1[] }
        validateLegacyTransactions([...legacyTransactions, legacyTransaction])
        legacyTransactions.push(legacyTransaction)
      } else {
        foldEventValidation(transactions, transaction, line.line, line.offset)
      }
    } catch (error) {
      const found = error instanceof FormatIssue
        ? error.issue
        : { code: 'invalid-transaction' as const, line: line.line, offset: line.offset }
      return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, found)
    }
    transactions.push(transaction)
    eventCount += transaction.events.length
    previousDigest = transaction.digest
    lastValidOffset = line.offset + line.bytes.length + 1
  }
  if (domainGeneration === 'legacy') {
    return {
      inspection: {
        state: 'scope-migration-required', format: 'v2', sizeBytes: bytes.length,
        transactionCount: legacyTransactions.length, eventCount, lastValidOffset,
        digest: contentDigest(bytes), issues: [{ code: 'scope-migration-required', line: 2, offset: 0 }],
      },
      header,
      lastDigest: previousDigest,
    }
  }
  let state: FoldedMemoryState
  try {
    state = foldTransactions(transactions)
  } catch (error) {
    const found = error instanceof FormatIssue
      ? error.issue
      : { code: 'invalid-state-transition' as const, line: 1, offset: 0 }
    return quarantine(bytes, 'v2', transactions.length, eventCount, lastValidOffset, found)
  }
  return {
    inspection: {
      state: 'ready', format: 'v2', sizeBytes: bytes.length, transactionCount: transactions.length,
      eventCount, lastValidOffset, digest: contentDigest(bytes), issues: [],
    },
    state,
    header,
    lastDigest: previousDigest,
  }
}

/** Convert one already-inspected v1 archive into one atomic v2 migration transaction. */
export function migrateV1ArchiveBytes(
  bytes: Buffer,
  options: { now?: () => Date, createId?: () => string } = {},
): Buffer {
  const limits = { maxArchiveBytes: Number.MAX_SAFE_INTEGER, maxTransactionBytes: Number.MAX_SAFE_INTEGER }
  const parsed = inspectArchiveBytes(bytes, limits)
  if (parsed.inspection.state !== 'scope-migration-required' || parsed.inspection.format !== 'v1') {
    throw new Error('only a valid v1 memory archive can be migrated')
  }
  const events = lineOffsets(bytes).flatMap(line => {
    if (line.bytes.length === 0) return []
    return [parseLegacyDomainEvent(JSON.parse(line.bytes.toString('utf8')) as unknown, line.line, line.offset)]
  })
  const now = options.now ?? (() => new Date())
  const createId = options.createId ?? randomUUID
  const timestamp = now().toISOString()
  const header: ArchiveHeaderV2 = {
    kind: 'mistymoon-memory-archive', schemaVersion: 2, archiveId: createId(), createdAt: timestamp,
    integrity: { algorithm: 'sha256', canonicalization: 'sorted-json-v1' },
  }
  const unsigned = {
    kind: 'transaction' as const,
    schemaVersion: 2 as const,
    id: createId(),
    committedAt: timestamp,
    previousDigest: headerDigest(header),
    events,
  }
  const transaction: ArchiveTransactionV2<LegacyMemoryDomainEventV1> = {
    ...unsigned,
    digest: transactionDigest(unsigned),
  }
  return Buffer.from(`${canonicalValue(header)}\n${canonicalValue(transaction)}\n`, 'utf8')
}

/** Explicit policy required to assign authority-bearing fields to legacy domain events. */
export interface LegacyScopeMigrationPolicy {
  ownerId: string
  authority: string
  scope: MemoryScopeV1
  memoryKind: MemoryRecord['memoryKind']
  recordedAtPolicy: 'legacy-created-at'
}

function legacyTransactionsFromBytes(bytes: Buffer): LegacyMemoryDomainEventV1[][] {
  const lines = lineOffsets(bytes).filter(line => line.bytes.length > 0)
  const first = record(JSON.parse(lines[0]!.bytes.toString('utf8')) as unknown)
  if (first.schemaVersion === 1) {
    return [lines.map(line => parseLegacyDomainEvent(
      JSON.parse(line.bytes.toString('utf8')) as unknown,
      line.line,
      line.offset,
    ))]
  }
  return lines.slice(1).map(line => {
    const transaction = record(JSON.parse(line.bytes.toString('utf8')) as unknown)
    if (!Array.isArray(transaction.events)) throw new Error('legacy storage transaction is invalid')
    return transaction.events.map(event => parseLegacyDomainEvent(event, line.line, line.offset))
  })
}

/** Convert raw-v1 or storage-v2/domain-v1 bytes using only an explicit Owner policy. */
export function migrateLegacyArchiveToScopedBytes(
  bytes: Buffer,
  policyValue: LegacyScopeMigrationPolicy,
  options: { now?: () => Date; createId?: () => string } = {},
): Buffer {
  const parsed = inspectArchiveBytes(bytes, {
    maxArchiveBytes: Number.MAX_SAFE_INTEGER,
    maxTransactionBytes: Number.MAX_SAFE_INTEGER,
  })
  if (parsed.inspection.state !== 'scope-migration-required') {
    throw new Error('only a valid legacy-domain archive can be scope migrated')
  }
  const policy: LegacyScopeMigrationPolicy = {
    ownerId: requiredString(policyValue.ownerId),
    authority: requiredString(policyValue.authority),
    scope: parseMemoryScopeV1(policyValue.scope),
    memoryKind: parseMemoryKind(policyValue.memoryKind),
    recordedAtPolicy: policyValue.recordedAtPolicy === 'legacy-created-at'
      ? 'legacy-created-at'
      : (() => { throw new Error('unsupported recordedAt policy') })(),
  }
  const now = options.now ?? (() => new Date())
  const createId = options.createId ?? randomUUID
  const migratedAt = now().toISOString()
  const header: ArchiveHeaderV2 = {
    kind: 'mistymoon-memory-archive', schemaVersion: 2, archiveId: createId(), createdAt: migratedAt,
    integrity: { algorithm: 'sha256', canonicalization: 'sorted-json-v1' },
  }
  let previousDigest = headerDigest(header)
  const transactions: ArchiveTransactionV2[] = []
  for (const legacyEvents of legacyTransactionsFromBytes(bytes)) {
    const observations = new Map<string, MemoryObservationV1>()
    const observationFor = (event: LegacyMemoryDomainEventV1): MemoryObservationV1 => {
      const existing = observations.get(event.sourceMessageId)
      if (existing !== undefined) return existing
      const sourceKind: MemoryObservationSourceKind = 'event' in event
        || ('sourceCandidateId' in event && event.sourceCandidateId !== undefined)
        || ('supersedesMemoryId' in event && event.supersedesMemoryId !== undefined)
        ? 'governance-operation'
        : 'legacy-import'
      const observation: MemoryObservationV1 = {
        schemaVersion: 1,
        event: 'observation',
        id: createId(),
        ownerId: policy.ownerId,
        authority: policy.authority,
        scope: policy.scope,
        source: { kind: sourceKind, id: event.sourceMessageId },
        observedAt: timestamp(event.createdAt),
      }
      observations.set(event.sourceMessageId, observation)
      return observation
    }
    const events: MemoryDomainEvent[] = []
    for (const legacy of legacyEvents) {
      const observation = observationFor(legacy)
      if (!events.includes(observation)) events.push(observation)
      if ('event' in legacy && legacy.event === 'forgotten') {
        events.push({
          schemaVersion: 2, event: 'forgotten', id: legacy.id, createdAt: timestamp(legacy.createdAt),
          ownerId: policy.ownerId, scope: policy.scope, observationId: observation.id,
          memoryId: legacy.memoryId, sourceMessageId: legacy.sourceMessageId,
        })
      } else if ('event' in legacy && legacy.event === 'candidate-resolution') {
        events.push({
          schemaVersion: 2, event: 'candidate-resolution', id: legacy.id, createdAt: timestamp(legacy.createdAt),
          ownerId: policy.ownerId, scope: policy.scope, observationId: observation.id,
          candidateId: legacy.candidateId, decision: legacy.decision, sourceMessageId: legacy.sourceMessageId,
          ...(legacy.memoryId === undefined ? {} : { memoryId: legacy.memoryId }),
        })
      } else if ('event' in legacy && legacy.event === 'candidate') {
        events.push({
          schemaVersion: 2, event: 'candidate', id: legacy.id, ownerId: policy.ownerId, scope: policy.scope,
          observationId: observation.id, memoryKind: policy.memoryKind,
          createdAt: timestamp(legacy.createdAt), recordedAt: timestamp(legacy.createdAt),
          content: legacy.content, visibility: legacy.visibility, sourceMessageId: legacy.sourceMessageId,
          status: 'pending',
        })
      } else {
        events.push({
          schemaVersion: 2, id: legacy.id, ownerId: policy.ownerId, scope: policy.scope,
          observationId: observation.id, memoryKind: policy.memoryKind,
          createdAt: timestamp(legacy.createdAt), recordedAt: timestamp(legacy.createdAt),
          content: legacy.content, visibility: legacy.visibility, sourceMessageId: legacy.sourceMessageId,
          ...(legacy.sourceCandidateId === undefined ? {} : { sourceCandidateId: legacy.sourceCandidateId }),
          ...(legacy.supersedesMemoryId === undefined ? {} : { supersedesMemoryId: legacy.supersedesMemoryId }),
          status: 'confirmed',
        })
      }
    }
    const unsigned = {
      kind: 'transaction' as const,
      schemaVersion: 2 as const,
      id: createId(),
      committedAt: migratedAt,
      previousDigest,
      events,
    }
    const transaction = { ...unsigned, digest: transactionDigest(unsigned) }
    transactions.push(transaction)
    previousDigest = transaction.digest
  }
  const result = Buffer.from(
    `${canonicalValue(header)}\n${transactions.map(transaction => canonicalValue(transaction)).join('\n')}\n`,
    'utf8',
  )
  if (inspectArchiveBytes(result, {
    maxArchiveBytes: Number.MAX_SAFE_INTEGER,
    maxTransactionBytes: Number.MAX_SAFE_INTEGER,
  }).inspection.state !== 'ready') {
    throw new Error('scoped memory migration output did not validate')
  }
  return result
}

function foldEventValidation(
  previous: readonly ArchiveTransactionV2[],
  transaction: ArchiveTransactionV2,
  line: number,
  offset: number,
): void {
  try {
    foldTransactions([...previous, transaction])
  } catch (error) {
    if (error instanceof FormatIssue) throw new FormatIssue({ ...error.issue, line, offset })
    throw error
  }
}

function copyInspection(value: ArchiveInspection): ArchiveInspection {
  return { ...value, issues: value.issues.map(issueValue => ({ ...issueValue })) }
}

async function readArchive(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
    throw error
  }
}

const fileArchiveCommitWriter: ArchiveCommitWriter = {
  async appendAndFlush(path, bytes): Promise<void> {
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
}

const fileArchiveCheckpointWriter: ArchiveCheckpointWriter = {
  write: writeArchiveCheckpoint,
}

function checkpointPath(path: string): string {
  return `${path}.checkpoint`
}

function checkpointFor(parsed: ParsedArchive): ArchiveCheckpointV1 {
  if (parsed.inspection.state !== 'ready' || parsed.lastDigest === undefined) {
    throw new Error('cannot checkpoint an unavailable memory archive')
  }
  return {
    schemaVersion: 1,
    archiveDigest: parsed.inspection.digest,
    archiveSize: parsed.inspection.sizeBytes,
    transactionCount: parsed.inspection.transactionCount,
    eventCount: parsed.inspection.eventCount,
    lastTransactionDigest: parsed.lastDigest,
  }
}

export async function writeArchiveCheckpoint(path: string, parsed: ParsedArchive): Promise<void> {
  const target = checkpointPath(path)
  const temporary = `${target}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${canonicalValue(checkpointFor(parsed))}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function verifyArchiveCheckpoint(
  path: string,
  parsed: ParsedArchive,
  createIfMissing = false,
): Promise<ParsedArchive> {
  if (parsed.inspection.state !== 'ready') return parsed
  let value: unknown
  try {
    value = JSON.parse(await readFile(checkpointPath(path), 'utf8')) as unknown
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT' && createIfMissing) {
      await writeArchiveCheckpoint(path, parsed)
      return parsed
    }
    return {
      inspection: {
        ...parsed.inspection,
        state: 'quarantined',
        issues: [{ code: 'checkpoint-mismatch', line: 0, offset: 0 }],
      },
    }
  }
  let checkpoint: ArchiveCheckpointV1
  try {
    const source = record(value)
    checkpoint = {
      schemaVersion: source.schemaVersion === 1 ? 1 : (() => { throw new Error() })(),
      archiveDigest: requiredString(source.archiveDigest),
      archiveSize: typeof source.archiveSize === 'number' ? source.archiveSize : (() => { throw new Error() })(),
      transactionCount: typeof source.transactionCount === 'number' ? source.transactionCount : (() => { throw new Error() })(),
      eventCount: typeof source.eventCount === 'number' ? source.eventCount : (() => { throw new Error() })(),
      lastTransactionDigest: requiredString(source.lastTransactionDigest),
    }
  } catch {
    return {
      inspection: {
        ...parsed.inspection,
        state: 'quarantined',
        issues: [{ code: 'checkpoint-mismatch', line: 0, offset: 0 }],
      },
    }
  }
  const expected = checkpointFor(parsed)
  if (canonicalValue(checkpoint) !== canonicalValue(expected)) {
    return {
      inspection: {
        ...parsed.inspection,
        state: 'quarantined',
        issues: [{ code: 'checkpoint-mismatch', line: 0, offset: 0 }],
      },
    }
  }
  return parsed
}

export class MemoryArchiveStorage {
  readonly #path: string
  readonly #now: () => Date
  readonly #createTransactionId: () => string
  readonly #leaseTimeoutMs: number
  readonly #leaseStaleMs: number
  readonly #maxArchiveBytes: number
  readonly #maxTransactionBytes: number
  readonly #disposeTimeoutMs: number
  readonly #leaseAdapter: ArchiveLeaseAdapter
  readonly #commitWriter: ArchiveCommitWriter
  readonly #checkpointWriter: ArchiveCheckpointWriter
  #parsed: ParsedArchive
  #disposed = false
  readonly #inflight = new Set<Promise<unknown>>()

  private constructor(options: MemoryArchiveStorageOptions, parsed: ParsedArchive) {
    this.#path = options.path
    this.#now = options.now ?? (() => new Date())
    this.#createTransactionId = options.createTransactionId ?? randomUUID
    this.#leaseTimeoutMs = options.leaseTimeoutMs ?? 30_000
    this.#leaseStaleMs = options.leaseStaleMs ?? 120_000
    this.#maxArchiveBytes = options.maxArchiveBytes ?? 64 * 1024 * 1024
    this.#maxTransactionBytes = options.maxTransactionBytes ?? 1024 * 1024
    this.#disposeTimeoutMs = options.disposeTimeoutMs ?? 5_000
    this.#leaseAdapter = options.leaseAdapter ?? fileArchiveLeaseAdapter
    this.#commitWriter = options.commitWriter ?? fileArchiveCommitWriter
    this.#checkpointWriter = options.checkpointWriter ?? fileArchiveCheckpointWriter
    this.#parsed = parsed
  }

  static async open(options: MemoryArchiveStorageOptions): Promise<MemoryArchiveStorage> {
    const limits = {
      maxArchiveBytes: options.maxArchiveBytes ?? 64 * 1024 * 1024,
      maxTransactionBytes: options.maxTransactionBytes ?? 1024 * 1024,
    }
    const now = options.now ?? (() => new Date())
    await mkdir(dirname(options.path), { recursive: true })
    const parsed = await MemoryArchiveStorage.withExclusiveLease(options.path, options.leaseTimeoutMs ?? 30_000, async () => {
      const bytes = await readArchive(options.path)
      const created = bytes.length === 0
      if (created) {
        const header: ArchiveHeaderV2 = {
          kind: 'mistymoon-memory-archive', schemaVersion: 2, archiveId: randomUUID(),
          createdAt: now().toISOString(), integrity: { algorithm: 'sha256', canonicalization: 'sorted-json-v1' },
        }
        const handle = await open(options.path, 'w')
        try {
          await handle.writeFile(`${canonicalValue(header)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      return verifyArchiveCheckpoint(
        options.path,
        inspectArchiveBytes(await readArchive(options.path), limits),
        created,
      )
    }, options.leaseAdapter ?? fileArchiveLeaseAdapter, options.leaseStaleMs ?? 120_000)
    return new MemoryArchiveStorage(options, parsed)
  }

  static async withExclusiveLease<T>(
    path: string,
    timeoutMs: number,
    action: (lease: ArchiveLease) => Promise<T>,
    adapter: ArchiveLeaseAdapter = fileArchiveLeaseAdapter,
    staleMs?: number,
  ): Promise<T> {
    return adapter.withExclusiveLease(path, timeoutMs, action, staleMs)
  }

  inspection(): ArchiveInspection {
    return copyInspection(this.#parsed.inspection)
  }

  snapshot(): FoldedMemoryState | undefined {
    return this.#parsed.inspection.state === 'ready' && this.#parsed.state !== undefined
      ? cloneFoldedState(this.#parsed.state)
      : undefined
  }

  async transact<T>(mutate: (state: FoldedMemoryState) => ArchiveMutation<T>): Promise<T> {
    if (this.#disposed) throw new MemoryArchiveError('memory archive is disposed', 'MEMORY_ARCHIVE_DISPOSED')
    const operation = this.#transact(mutate)
    this.#inflight.add(operation)
    try {
      return await operation
    } finally {
      this.#inflight.delete(operation)
    }
  }

  async #transact<T>(mutate: (state: FoldedMemoryState) => ArchiveMutation<T>): Promise<T> {
    const next = await this.#leaseAdapter.withExclusiveLease(this.#path, this.#leaseTimeoutMs, async lease => {
      const parsed = await verifyArchiveCheckpoint(this.#path, inspectArchiveBytes(await readArchive(this.#path), {
        maxArchiveBytes: this.#maxArchiveBytes,
        maxTransactionBytes: this.#maxTransactionBytes,
      }))
      if (parsed.inspection.state === 'migration-required') {
        throw new MemoryArchiveError('memory archive requires explicit v1 migration', 'MEMORY_ARCHIVE_MIGRATION_REQUIRED')
      }
      if (parsed.inspection.state === 'scope-migration-required') {
        throw new MemoryArchiveError(
          'memory archive requires explicit scoped-record migration',
          'MEMORY_ARCHIVE_SCOPE_MIGRATION_REQUIRED',
        )
      }
      if (parsed.inspection.state !== 'ready' || parsed.state === undefined || parsed.lastDigest === undefined) {
        throw new MemoryArchiveError('memory archive is quarantined', 'MEMORY_ARCHIVE_QUARANTINED')
      }
      const mutation = mutate(cloneFoldedState(parsed.state))
      if (mutation.events.length === 0) return { parsed, result: mutation.result }
      lease.assertHeld()
      const unsigned = {
        kind: 'transaction' as const,
        schemaVersion: 2 as const,
        id: this.#createTransactionId(),
        committedAt: this.#now().toISOString(),
        previousDigest: parsed.lastDigest,
        events: mutation.events,
      }
      const transaction: ArchiveTransactionV2 = { ...unsigned, digest: transactionDigest(unsigned) }
      const bytes = Buffer.from(`${canonicalValue(transaction)}\n`, 'utf8')
      if (bytes.length > this.#maxTransactionBytes) {
        throw new Error('memory transaction exceeds configured maximum bytes')
      }
      if (parsed.inspection.sizeBytes + bytes.length > this.#maxArchiveBytes) {
        throw new Error('memory archive exceeds configured maximum bytes')
      }
      await this.#commitWriter.appendAndFlush(this.#path, bytes)
      lease.assertHeld()
      const verified = inspectArchiveBytes(await readArchive(this.#path), {
        maxArchiveBytes: this.#maxArchiveBytes,
        maxTransactionBytes: this.#maxTransactionBytes,
      })
      if (verified.inspection.state !== 'ready') {
        throw new MemoryArchiveError('memory archive became quarantined after commit', 'MEMORY_ARCHIVE_QUARANTINED')
      }
      await this.#checkpointWriter.write(this.#path, verified)
      lease.assertHeld()
      return { parsed: verified, result: mutation.result }
    }, this.#leaseStaleMs)
    this.#parsed = next.parsed
    return next.result
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    const inflight = [...this.#inflight]
    if (inflight.length === 0) return
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.allSettled(inflight).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new MemoryArchiveError('memory archive dispose timed out', 'MEMORY_DISPOSE_TIMEOUT'))
          }, this.#disposeTimeoutMs)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}
