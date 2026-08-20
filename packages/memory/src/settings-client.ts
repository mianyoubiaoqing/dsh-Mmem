/** Browser-safe caller for the standalone dsh-Mmem Settings RPC. */

import { parseCandidateExtractionReceiptV1 } from './candidate-extraction.js'
import type {
  MemoryCandidate,
  MemoryBatchDecisionV1,
  MemoryCandidateDecision,
  MemoryManagementQueryV1,
  MemoryRecord,
  MemoryVisibility,
} from './contracts.js'
import { parseMemoryKind, parseMemoryScopeV1, validateMemoryValidity, type MemoryKind } from './domain.js'
import type {
  MemoryAssessmentRpcSnapshotV1,
  MemoryBatchRpcSnapshotV1,
  MemoryCandidateApprovalSnapshotV1,
  MemoryCandidateQueueSnapshotV1,
  MemoryCandidateRejectionSnapshotV1,
  MemoryCandidateRevisionRpcSnapshotV1,
  MemoryManagementRpcSnapshotV1,
  MemorySourceRpcSnapshotV1,
} from './settings-host.js'

const SETTINGS_CHANNEL = '/dsh-mmem-settings'

type MemorySettingsRpcResult =
  | { ok: true; value: unknown }
  | {
      ok: false
      error: {
        code: string
        message: string
        details?: unknown
      }
    }

/** Structural subset of the DSH browser Connection RPC used by this client. */
export interface MemorySettingsRpcCallerV1 {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<MemorySettingsRpcResult>
}

/** Trusted browser state required to address one live DSH Session. */
export interface MemorySettingsClientOptionsV1 {
  readonly rpc: MemorySettingsRpcCallerV1
  readonly sessionId: string
  readonly requestedSpaceId?: string
  /** Browser-local idempotency key source; defaults to `crypto.randomUUID`. */
  readonly createRequestId?: () => string
}

/** Operations exposed to the standalone Memory settings surface. */
export interface MemorySettingsClientV1 {
  listCandidates(signal?: AbortSignal): Promise<MemoryCandidateQueueSnapshotV1>
  search(
    filters?: Omit<MemoryManagementQueryV1, 'context'>,
    signal?: AbortSignal,
  ): Promise<MemoryManagementRpcSnapshotV1>
  source(
    entity: 'record' | 'candidate',
    id: string,
    signal?: AbortSignal,
  ): Promise<MemorySourceRpcSnapshotV1>
  assessCandidate(candidateId: string, signal?: AbortSignal): Promise<MemoryAssessmentRpcSnapshotV1>
  approveCandidate(
    candidateId: string,
    resolution?: MemoryCandidateDecision['resolution'],
    signal?: AbortSignal,
  ): Promise<MemoryCandidateApprovalSnapshotV1>
  rejectCandidate(candidateId: string, signal?: AbortSignal): Promise<MemoryCandidateRejectionSnapshotV1>
  editCandidate(input: {
    candidateId: string
    content: string
    visibility: MemoryVisibility
    memoryKind: MemoryKind
  }, signal?: AbortSignal): Promise<MemoryCandidateRevisionRpcSnapshotV1>
  mergeCandidates(input: {
    candidateIds: readonly string[]
    content: string
    visibility: MemoryVisibility
    memoryKind: MemoryKind
  }, signal?: AbortSignal): Promise<MemoryCandidateRevisionRpcSnapshotV1>
  batchDecide(
    decisions: readonly MemoryBatchDecisionV1[],
    signal?: AbortSignal,
  ): Promise<MemoryBatchRpcSnapshotV1>
}

/** Stable client-side failure for RPC and response-boundary errors. */
export class MemorySettingsClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MemorySettingsClientError'
  }
}

function nonEmpty(value: string, label: string): string {
  if (value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function exactObject(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemorySettingsClientError('invalid-response', `${label} must be an object`)
  }
  const input = value as Record<string, unknown>
  const actual = Object.keys(input).toSorted()
  const keys = [...expected].toSorted()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new MemorySettingsClientError('invalid-response', `${label} contains missing or unknown fields`)
  }
  return input
}

function governedCandidate(value: unknown): MemoryCandidate {
  const required = [
    'schemaVersion',
    'event',
    'id',
    'ownerId',
    'scope',
    'observationId',
    'memoryKind',
    'createdAt',
    'recordedAt',
    'content',
    'visibility',
    'sourceMessageId',
    'status',
  ]
  const optional = ['validFrom', 'validTo', 'sourceCandidateIds', 'extraction']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Candidate must be an object')
  }
  const input = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in input)) || Object.keys(input).some(key => !allowed.has(key))) {
    throw new TypeError('Candidate contains missing or unknown fields')
  }
  if (input.schemaVersion !== 2 || input.event !== 'candidate') throw new TypeError('Candidate schema is invalid')
  for (const key of ['id', 'ownerId', 'observationId', 'createdAt', 'content', 'sourceMessageId'] as const) {
    if (typeof input[key] !== 'string' || input[key].trim() === '') throw new TypeError(`Candidate ${key} is invalid`)
  }
  parseMemoryScopeV1(input.scope)
  parseMemoryKind(input.memoryKind)
  validateMemoryValidity({ recordedAt: input.createdAt as string })
  validateMemoryValidity({
    recordedAt: typeof input.recordedAt === 'string' ? input.recordedAt : '',
    ...(input.validFrom === undefined ? {} : { validFrom: typeof input.validFrom === 'string' ? input.validFrom : '' }),
    ...(input.validTo === undefined ? {} : { validTo: typeof input.validTo === 'string' ? input.validTo : '' }),
  })
  if (input.visibility !== 'personal' && input.visibility !== 'confidential') {
    throw new TypeError('Candidate visibility is invalid')
  }
  if (input.status !== 'pending' && input.status !== 'approved'
    && input.status !== 'rejected' && input.status !== 'superseded') {
    throw new TypeError('Candidate status is invalid')
  }
  if (input.sourceCandidateIds !== undefined
    && (!Array.isArray(input.sourceCandidateIds)
      || input.sourceCandidateIds.some(item => typeof item !== 'string' || item.trim() === ''))) {
    throw new TypeError('Candidate source lineage is invalid')
  }
  if (input.extraction !== undefined) {
    const extraction = exactObject(
      input.extraction,
      ['schemaVersion', 'providerId', 'providerVersion', 'receipt'],
      'Candidate extraction',
    )
    if (extraction.schemaVersion !== 1
      || typeof extraction.providerId !== 'string' || extraction.providerId.trim() === ''
      || typeof extraction.providerVersion !== 'string' || extraction.providerVersion.trim() === '') {
      throw new TypeError('Candidate extraction is invalid')
    }
    parseCandidateExtractionReceiptV1(extraction.receipt)
  }
  return value as MemoryCandidate
}

function governedRecord(value: unknown): MemoryRecord {
  const required = [
    'schemaVersion',
    'id',
    'ownerId',
    'scope',
    'observationId',
    'memoryKind',
    'createdAt',
    'recordedAt',
    'content',
    'visibility',
    'sourceMessageId',
    'status',
  ]
  const optional = [
    'validFrom',
    'validTo',
    'sourceCandidateId',
    'supersedesMemoryId',
    'sourceMemoryIds',
    'lifecycle',
  ]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Memory record must be an object')
  }
  const input = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in input)) || Object.keys(input).some(key => !allowed.has(key))) {
    throw new TypeError('Memory record contains missing or unknown fields')
  }
  if (input.schemaVersion !== 2) throw new TypeError('Memory record schema is invalid')
  for (const key of ['id', 'ownerId', 'observationId', 'createdAt', 'content', 'sourceMessageId'] as const) {
    if (typeof input[key] !== 'string' || input[key].trim() === '') throw new TypeError(`Memory record ${key} is invalid`)
  }
  parseMemoryScopeV1(input.scope)
  parseMemoryKind(input.memoryKind)
  validateMemoryValidity({ recordedAt: input.createdAt as string })
  validateMemoryValidity({
    recordedAt: typeof input.recordedAt === 'string' ? input.recordedAt : '',
    ...(input.validFrom === undefined ? {} : { validFrom: typeof input.validFrom === 'string' ? input.validFrom : '' }),
    ...(input.validTo === undefined ? {} : { validTo: typeof input.validTo === 'string' ? input.validTo : '' }),
  })
  if (input.visibility !== 'personal' && input.visibility !== 'confidential') {
    throw new TypeError('Memory record visibility is invalid')
  }
  if (input.status !== 'confirmed' && input.status !== 'forgotten' && input.status !== 'superseded') {
    throw new TypeError('Memory record status is invalid')
  }
  for (const key of ['sourceCandidateId', 'supersedesMemoryId'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].trim() === '')) {
      throw new TypeError(`Memory record ${key} is invalid`)
    }
  }
  if (input.sourceMemoryIds !== undefined && (!Array.isArray(input.sourceMemoryIds)
    || input.sourceMemoryIds.some(item => typeof item !== 'string' || item.trim() === ''))) {
    throw new TypeError('Memory record sourceMemoryIds is invalid')
  }
  if (input.lifecycle !== undefined) {
    const lifecycle = exactObject(input.lifecycle, ['tier', 'rankMultiplier', 'updatedAt'], 'Memory lifecycle')
    if ((lifecycle.tier !== 'hot' && lifecycle.tier !== 'cold' && lifecycle.tier !== 'archived')
      || typeof lifecycle.rankMultiplier !== 'number' || !Number.isFinite(lifecycle.rankMultiplier)
      || lifecycle.rankMultiplier < 0 || lifecycle.rankMultiplier > 1
      || typeof lifecycle.updatedAt !== 'string') throw new TypeError('Memory lifecycle is invalid')
    validateMemoryValidity({ recordedAt: lifecycle.updatedAt })
  }
  return value as MemoryRecord
}

function activeSpaceReceipt(value: unknown): MemoryCandidateQueueSnapshotV1['activeSpace'] {
  const activeSpace = exactObject(
    value,
    ['spaceId', 'access', 'bindingRevision'],
    'Active Space receipt',
  )
  if (typeof activeSpace.spaceId !== 'string' || activeSpace.spaceId.trim() === ''
    || (activeSpace.access !== 'read-only' && activeSpace.access !== 'read-write')
    || !Number.isSafeInteger(activeSpace.bindingRevision) || (activeSpace.bindingRevision as number) < 1) {
    throw new MemorySettingsClientError('invalid-response', 'Active Space receipt has invalid values')
  }
  return activeSpace as unknown as MemoryCandidateQueueSnapshotV1['activeSpace']
}

function candidateQueue(value: unknown): MemoryCandidateQueueSnapshotV1 {
  const input = exactObject(value, ['schemaVersion', 'activeSpace', 'candidates'], 'Candidate queue')
  if (input.schemaVersion !== 1 || !Array.isArray(input.candidates)) {
    throw new MemorySettingsClientError('invalid-response', 'Candidate queue has an invalid schema')
  }
  activeSpaceReceipt(input.activeSpace)
  try {
    input.candidates.forEach(governedCandidate)
  } catch (error) {
    if (error instanceof MemorySettingsClientError) throw error
    throw new MemorySettingsClientError('invalid-response', 'Candidate queue contains invalid data', { cause: error })
  }
  return value as MemoryCandidateQueueSnapshotV1
}

function managementSnapshot(value: unknown): MemoryManagementRpcSnapshotV1 {
  const input = exactObject(value, ['schemaVersion', 'activeSpace', 'management'], 'Memory management snapshot')
  if (input.schemaVersion !== 1) {
    throw new MemorySettingsClientError('invalid-response', 'Memory management snapshot has an invalid version')
  }
  activeSpaceReceipt(input.activeSpace)
  const management = exactObject(
    input.management,
    ['schemaVersion', 'records', 'candidates', 'audit'],
    'Memory management projection',
  )
  if (management.schemaVersion !== 1 || !Array.isArray(management.records)
    || !Array.isArray(management.candidates) || !Array.isArray(management.audit)) {
    throw new MemorySettingsClientError('invalid-response', 'Memory management projection has an invalid schema')
  }
  try {
    management.records.forEach(governedRecord)
    management.candidates.forEach(governedCandidate)
    for (const item of management.audit) {
      const audit = exactObject(
        item,
        ['schemaVersion', 'action', 'sourceCandidateIds', 'resultCandidateId', 'createdAt', 'sourceMessageId'],
        'Memory governance audit entry',
      )
      if (audit.schemaVersion !== 1
        || (audit.action !== 'candidate-edited' && audit.action !== 'candidates-merged')
        || !Array.isArray(audit.sourceCandidateIds)
        || audit.sourceCandidateIds.some(id => typeof id !== 'string' || id.trim() === '')
        || typeof audit.resultCandidateId !== 'string' || audit.resultCandidateId.trim() === ''
        || typeof audit.createdAt !== 'string'
        || typeof audit.sourceMessageId !== 'string' || audit.sourceMessageId.trim() === '') {
        throw new TypeError('Memory governance audit entry is invalid')
      }
      validateMemoryValidity({ recordedAt: audit.createdAt })
    }
  } catch (error) {
    if (error instanceof MemorySettingsClientError) throw error
    throw new MemorySettingsClientError('invalid-response', 'Memory management projection contains invalid data', {
      cause: error,
    })
  }
  return value as MemoryManagementRpcSnapshotV1
}

function sourceSnapshot(value: unknown): MemorySourceRpcSnapshotV1 {
  const input = exactObject(value, ['schemaVersion', 'activeSpace', 'source'], 'Memory source snapshot')
  if (input.schemaVersion !== 1) {
    throw new MemorySettingsClientError('invalid-response', 'Memory source snapshot has an invalid version')
  }
  activeSpaceReceipt(input.activeSpace)
  if (typeof input.source !== 'object' || input.source === null || Array.isArray(input.source)) {
    throw new MemorySettingsClientError('invalid-response', 'Memory source projection must be an object')
  }
  const source = input.source as Record<string, unknown>
  const required = ['schemaVersion', 'entity', 'id', 'observation']
  const optional = ['sourceCandidateId', 'sourceCandidateIds', 'supersedesMemoryId', 'sourceMemoryIds']
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in source)) || Object.keys(source).some(key => !allowed.has(key))
    || source.schemaVersion !== 1 || (source.entity !== 'record' && source.entity !== 'candidate')
    || typeof source.id !== 'string' || source.id.trim() === '') {
    throw new MemorySettingsClientError('invalid-response', 'Memory source projection has an invalid schema')
  }
  const observation = exactObject(
    source.observation,
    ['id', 'sourceKind', 'sourceId', 'observedAt'],
    'Memory source observation',
  )
  for (const key of ['id', 'sourceKind', 'sourceId', 'observedAt'] as const) {
    if (typeof observation[key] !== 'string' || observation[key].trim() === '') {
      throw new MemorySettingsClientError('invalid-response', `Memory source observation ${key} is invalid`)
    }
  }
  try {
    validateMemoryValidity({ recordedAt: observation.observedAt as string })
  } catch (error) {
    throw new MemorySettingsClientError('invalid-response', 'Memory source observation time is invalid', { cause: error })
  }
  for (const key of ['sourceCandidateId', 'supersedesMemoryId'] as const) {
    if (source[key] !== undefined && (typeof source[key] !== 'string' || source[key].trim() === '')) {
      throw new MemorySettingsClientError('invalid-response', `Memory source ${key} is invalid`)
    }
  }
  for (const key of ['sourceCandidateIds', 'sourceMemoryIds'] as const) {
    if (source[key] !== undefined && (!Array.isArray(source[key])
      || source[key].some(item => typeof item !== 'string' || item.trim() === ''))) {
      throw new MemorySettingsClientError('invalid-response', `Memory source ${key} is invalid`)
    }
  }
  return value as MemorySourceRpcSnapshotV1
}

function assessmentSnapshot(value: unknown): MemoryAssessmentRpcSnapshotV1 {
  const input = exactObject(value, ['schemaVersion', 'activeSpace', 'assessment'], 'Memory assessment snapshot')
  if (input.schemaVersion !== 1) {
    throw new MemorySettingsClientError('invalid-response', 'Memory assessment snapshot has an invalid version')
  }
  activeSpaceReceipt(input.activeSpace)
  const assessment = exactObject(
    input.assessment,
    ['schemaVersion', 'candidateId', 'evaluatedAt', 'relationships'],
    'Memory assessment',
  )
  if (assessment.schemaVersion !== 1
    || typeof assessment.candidateId !== 'string' || assessment.candidateId.trim() === ''
    || typeof assessment.evaluatedAt !== 'string'
    || !Array.isArray(assessment.relationships) || assessment.relationships.length > 100) {
    throw new MemorySettingsClientError('invalid-response', 'Memory assessment has an invalid schema')
  }
  try {
    validateMemoryValidity({ recordedAt: assessment.evaluatedAt })
    for (const item of assessment.relationships) {
      const relationship = exactObject(
        item,
        ['memoryId', 'relation', 'score', 'reason'],
        'Memory assessment relationship',
      )
      if (typeof relationship.memoryId !== 'string' || relationship.memoryId.trim() === ''
        || (relationship.relation !== 'duplicate' && relationship.relation !== 'conflict'
          && relationship.relation !== 'related')
        || typeof relationship.score !== 'number' || !Number.isFinite(relationship.score)
        || relationship.score < 0 || relationship.score > 1
        || (relationship.reason !== 'exact-normalized-match'
          && relationship.reason !== 'same-kind-near-match'
          && relationship.reason !== 'lexical-overlap')) {
        throw new TypeError('Memory assessment relationship is invalid')
      }
    }
  } catch (error) {
    if (error instanceof MemorySettingsClientError) throw error
    throw new MemorySettingsClientError('invalid-response', 'Memory assessment contains invalid data', { cause: error })
  }
  return value as MemoryAssessmentRpcSnapshotV1
}

function approvalSnapshot(value: unknown): MemoryCandidateApprovalSnapshotV1 {
  const input = exactObject(value, ['schemaVersion', 'activeSpace', 'memory'], 'Candidate approval snapshot')
  if (input.schemaVersion !== 1) {
    throw new MemorySettingsClientError('invalid-response', 'Candidate approval snapshot has an invalid version')
  }
  activeSpaceReceipt(input.activeSpace)
  try {
    governedRecord(input.memory)
  } catch (error) {
    if (error instanceof MemorySettingsClientError) throw error
    throw new MemorySettingsClientError('invalid-response', 'Candidate approval contains invalid Memory data', {
      cause: error,
    })
  }
  return value as MemoryCandidateApprovalSnapshotV1
}

function rejectionSnapshot(value: unknown): MemoryCandidateRejectionSnapshotV1 {
  const input = exactObject(value, ['schemaVersion', 'activeSpace', 'candidate'], 'Candidate rejection snapshot')
  if (input.schemaVersion !== 1) {
    throw new MemorySettingsClientError('invalid-response', 'Candidate rejection snapshot has an invalid version')
  }
  activeSpaceReceipt(input.activeSpace)
  try {
    governedCandidate(input.candidate)
  } catch (error) {
    if (error instanceof MemorySettingsClientError) throw error
    throw new MemorySettingsClientError('invalid-response', 'Candidate rejection contains invalid Candidate data', {
      cause: error,
    })
  }
  return value as MemoryCandidateRejectionSnapshotV1
}

function candidateRevisionSnapshot(value: unknown): MemoryCandidateRevisionRpcSnapshotV1 {
  const input = exactObject(value, ['schemaVersion', 'activeSpace', 'candidate'], 'Candidate revision snapshot')
  if (input.schemaVersion !== 1) {
    throw new MemorySettingsClientError('invalid-response', 'Candidate revision snapshot has an invalid version')
  }
  activeSpaceReceipt(input.activeSpace)
  try {
    governedCandidate(input.candidate)
  } catch (error) {
    if (error instanceof MemorySettingsClientError) throw error
    throw new MemorySettingsClientError('invalid-response', 'Candidate revision contains invalid Candidate data', {
      cause: error,
    })
  }
  return value as MemoryCandidateRevisionRpcSnapshotV1
}

function batchSnapshot(value: unknown): MemoryBatchRpcSnapshotV1 {
  const input = exactObject(value, ['schemaVersion', 'activeSpace', 'batch'], 'Memory batch snapshot')
  if (input.schemaVersion !== 1) {
    throw new MemorySettingsClientError('invalid-response', 'Memory batch snapshot has an invalid version')
  }
  activeSpaceReceipt(input.activeSpace)
  const batch = exactObject(input.batch, ['schemaVersion', 'results'], 'Memory batch result')
  if (batch.schemaVersion !== 1 || !Array.isArray(batch.results)) {
    throw new MemorySettingsClientError('invalid-response', 'Memory batch result has an invalid schema')
  }
  for (const item of batch.results) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new MemorySettingsClientError('invalid-response', 'Memory batch item must be an object')
    }
    const result = item as Record<string, unknown>
    const expected = result.code === undefined
      ? ['candidateId', 'status']
      : ['candidateId', 'code', 'status']
    exactObject(result, expected, 'Memory batch item')
    if (typeof result.candidateId !== 'string' || result.candidateId.trim() === ''
      || (result.status !== 'succeeded' && result.status !== 'failed')
      || (result.code !== undefined && (typeof result.code !== 'string' || result.code.trim() === ''))) {
      throw new MemorySettingsClientError('invalid-response', 'Memory batch item is invalid')
    }
  }
  return value as MemoryBatchRpcSnapshotV1
}

/** Create a Session-bound client that never accepts Owner or Workspace identity from the browser. */
export function createMemorySettingsClient(options: MemorySettingsClientOptionsV1): MemorySettingsClientV1 {
  const selection = {
    sessionId: nonEmpty(options.sessionId, 'sessionId'),
    ...(options.requestedSpaceId === undefined
      ? {}
      : { requestedSpaceId: nonEmpty(options.requestedSpaceId, 'requestedSpaceId') }),
  }
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID())
  const call = async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const result = await options.rpc.call(SETTINGS_CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new MemorySettingsClientError(result.error.code, result.error.message)
    return result.value
  }
  return {
    async listCandidates(signal) {
      return candidateQueue(await call('candidates/list', selection, signal))
    },
    async search(filters = {}, signal) {
      const payload = {
        ...selection,
        ...(filters.query === undefined ? {} : { query: filters.query }),
        ...(filters.memoryKind === undefined ? {} : { memoryKind: filters.memoryKind }),
        ...(filters.visibility === undefined ? {} : { visibility: filters.visibility }),
        ...(filters.recordStatus === undefined ? {} : { recordStatus: filters.recordStatus }),
        ...(filters.candidateStatus === undefined ? {} : { candidateStatus: filters.candidateStatus }),
        ...(filters.limit === undefined ? {} : { limit: filters.limit }),
      }
      return managementSnapshot(await call('memory/search', payload, signal))
    },
    async source(entity, id, signal) {
      return sourceSnapshot(await call('memory/source', {
        ...selection,
        entity,
        id: nonEmpty(id, 'source id'),
      }, signal))
    },
    async assessCandidate(candidateId, signal) {
      return assessmentSnapshot(await call('memory/assess', {
        ...selection,
        candidateId: nonEmpty(candidateId, 'candidateId'),
      }, signal))
    },
    async approveCandidate(candidateId, resolution, signal) {
      return approvalSnapshot(await call('candidates/approve', {
        ...selection,
        candidateId: nonEmpty(candidateId, 'candidateId'),
        requestId: nonEmpty(createRequestId(), 'requestId'),
        ...(resolution === undefined ? {} : { resolution }),
      }, signal))
    },
    async rejectCandidate(candidateId, signal) {
      return rejectionSnapshot(await call('candidates/reject', {
        ...selection,
        candidateId: nonEmpty(candidateId, 'candidateId'),
        requestId: nonEmpty(createRequestId(), 'requestId'),
      }, signal))
    },
    async editCandidate(input, signal) {
      return candidateRevisionSnapshot(await call('memory/edit', {
        ...selection,
        candidateIds: [nonEmpty(input.candidateId, 'candidateId')],
        requestId: nonEmpty(createRequestId(), 'requestId'),
        content: nonEmpty(input.content, 'Candidate content'),
        visibility: input.visibility,
        memoryKind: input.memoryKind,
      }, signal))
    },
    async mergeCandidates(input, signal) {
      if (input.candidateIds.length === 0) throw new TypeError('candidateIds must not be empty')
      return candidateRevisionSnapshot(await call('memory/merge', {
        ...selection,
        candidateIds: input.candidateIds.map(id => nonEmpty(id, 'candidateId')),
        requestId: nonEmpty(createRequestId(), 'requestId'),
        content: nonEmpty(input.content, 'Candidate content'),
        visibility: input.visibility,
        memoryKind: input.memoryKind,
      }, signal))
    },
    async batchDecide(decisions, signal) {
      const payloadDecisions = decisions.map((decision): MemoryBatchDecisionV1 => ({
        candidateId: nonEmpty(decision.candidateId, 'candidateId'),
        action: decision.action,
        ...(decision.resolution === undefined
          ? {}
          : {
              resolution: decision.resolution.kind === 'keep-both'
                ? { kind: 'keep-both' }
                : {
                    kind: 'supersede',
                    memoryId: nonEmpty(decision.resolution.memoryId, 'resolution memoryId'),
                  },
            }),
      }))
      return batchSnapshot(await call('memory/batch', {
        ...selection,
        requestId: nonEmpty(createRequestId(), 'requestId'),
        decisions: payloadDecisions,
      }, signal))
    },
  }
}
