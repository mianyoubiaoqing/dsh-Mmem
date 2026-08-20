/** Loopback-only DSH Host adapter for dsh-Mmem Settings clients. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  MemoryCandidate,
  MemoryBatchDecisionV1,
  MemoryBatchGovernanceResultV1,
  MemoryManagementQueryV1,
  MemoryManagementSnapshotV1,
  MemoryRecord,
  MemorySourceViewV1,
} from './contracts.js'
import { parseMemoryKind } from './domain.js'
import type { MemoryConflictAssessmentV1 } from './conflict.js'
import type { MemorySpaceGovernanceSessionV1 } from './space-governance.js'

/** Cordis plugin name for the standalone Memory Settings Host. */
export const name = 'dsh-mmem-settings-host'

/** Only public DSH services and the Memory-owned governance resolver are required. */
export const inject = ['connection', 'sessions', 'dshMmemSpaceGovernance']

/** Candidate queue returned with the exact Active Space receipt used by Settings. */
export interface MemoryCandidateQueueSnapshotV1 {
  schemaVersion: 1
  activeSpace: Pick<MemorySpaceGovernanceSessionV1, 'spaceId' | 'access' | 'bindingRevision'>
  candidates: MemoryCandidate[]
}

/** Manual approval result retaining the Active Space receipt used for the write. */
export interface MemoryCandidateApprovalSnapshotV1 {
  schemaVersion: 1
  activeSpace: Pick<MemorySpaceGovernanceSessionV1, 'spaceId' | 'access' | 'bindingRevision'>
  memory: MemoryRecord
}

/** Manual rejection result retaining the Active Space receipt used for the write. */
export interface MemoryCandidateRejectionSnapshotV1 {
  schemaVersion: 1
  activeSpace: Pick<MemorySpaceGovernanceSessionV1, 'spaceId' | 'access' | 'bindingRevision'>
  candidate: MemoryCandidate
}

/** Owner management projection bound to one exact Active Space. */
export interface MemoryManagementRpcSnapshotV1 {
  schemaVersion: 1
  activeSpace: Pick<MemorySpaceGovernanceSessionV1, 'spaceId' | 'access' | 'bindingRevision'>
  management: MemoryManagementSnapshotV1
}

/** Provenance projection bound to one exact Active Space. */
export interface MemorySourceRpcSnapshotV1 {
  schemaVersion: 1
  activeSpace: Pick<MemorySpaceGovernanceSessionV1, 'spaceId' | 'access' | 'bindingRevision'>
  source: MemorySourceViewV1
}

/** Current conflict assessment bound to one exact Active Space. */
export interface MemoryAssessmentRpcSnapshotV1 {
  schemaVersion: 1
  activeSpace: Pick<MemorySpaceGovernanceSessionV1, 'spaceId' | 'access' | 'bindingRevision'>
  assessment: MemoryConflictAssessmentV1
}

/** Candidate revision result bound to one exact Active Space. */
export interface MemoryCandidateRevisionRpcSnapshotV1 {
  schemaVersion: 1
  activeSpace: Pick<MemorySpaceGovernanceSessionV1, 'spaceId' | 'access' | 'bindingRevision'>
  candidate: MemoryCandidate
}

/** Batch governance result bound to one exact Active Space. */
export interface MemoryBatchRpcSnapshotV1 {
  schemaVersion: 1
  activeSpace: Pick<MemorySpaceGovernanceSessionV1, 'spaceId' | 'access' | 'bindingRevision'>
  batch: MemoryBatchGovernanceResultV1
}

type MemorySettingsRpcResult =
  | { ok: true; value: unknown }
  | {
      ok: false
      error: {
        code: 'bad-request' | 'session-not-found'
        message: string
        details: Record<string, unknown>
      }
    }

type MemorySettingsRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<MemorySettingsRpcResult>

interface DshConnectionRpcV1 {
  handle(
    channel: string,
    handler: MemorySettingsRpcHandler,
    options: { authority: 'loopback' },
  ): () => Promise<void>
}

function connectionRpc(ctx: Context): DshConnectionRpcV1 {
  const connection = ctx.get('connection', true) as { readonly rpc?: DshConnectionRpcV1 }
  if (connection.rpc === undefined) throw new Error('dsh-Mmem Settings Host requires DSH Connection RPC')
  return connection.rpc
}

function badRequest(message: string) {
  return {
    ok: false as const,
    error: {
      code: 'bad-request' as const,
      message,
      details: { issues: [] },
    },
  }
}

function exactObject(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const expected = allowedKeys.toSorted()
  const actual = Object.keys(value).toSorted()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function allowedObject(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.keys(value).every(key => allowedKeys.includes(key))
}

function sessionSelection(value: unknown): { sessionId: SessionId; requestedSpaceId?: string } | undefined {
  const input = value as Record<string, unknown>
  const keys = input?.requestedSpaceId === undefined
    ? ['sessionId']
    : ['requestedSpaceId', 'sessionId']
  if (!exactObject(value, keys)
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || (value.requestedSpaceId !== undefined
      && (typeof value.requestedSpaceId !== 'string' || value.requestedSpaceId.trim() === ''))) {
    return undefined
  }
  return {
    sessionId: SessionId(value.sessionId),
    ...(value.requestedSpaceId === undefined ? {} : { requestedSpaceId: value.requestedSpaceId }),
  }
}

function candidateDecision(value: unknown): {
  sessionId: SessionId
  requestedSpaceId?: string
  candidateId: string
  requestId: string
  resolution?: MemoryBatchDecisionV1['resolution']
} | undefined {
  const input = value as Record<string, unknown>
  const keys = [
    'candidateId',
    'requestId',
    ...(input?.requestedSpaceId === undefined ? [] : ['requestedSpaceId']),
    ...(input?.resolution === undefined ? [] : ['resolution']),
    'sessionId',
  ]
  if (!exactObject(value, keys)
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || typeof value.candidateId !== 'string' || value.candidateId.trim() === ''
    || typeof value.requestId !== 'string' || value.requestId.trim() === ''
    || (value.requestedSpaceId !== undefined
      && (typeof value.requestedSpaceId !== 'string' || value.requestedSpaceId.trim() === ''))) {
    return undefined
  }
  let resolution: MemoryBatchDecisionV1['resolution']
  if (value.resolution !== undefined) {
    if (exactObject(value.resolution, ['kind']) && value.resolution.kind === 'keep-both') {
      resolution = { kind: 'keep-both' }
    } else if (exactObject(value.resolution, ['kind', 'memoryId'])
      && value.resolution.kind === 'supersede'
      && typeof value.resolution.memoryId === 'string' && value.resolution.memoryId.trim() !== '') {
      resolution = { kind: 'supersede', memoryId: value.resolution.memoryId }
    } else return undefined
  }
  return {
    sessionId: SessionId(value.sessionId),
    candidateId: value.candidateId,
    requestId: value.requestId,
    ...(resolution === undefined ? {} : { resolution }),
    ...(value.requestedSpaceId === undefined ? {} : { requestedSpaceId: value.requestedSpaceId }),
  }
}

function candidateSelection(value: unknown): {
  sessionId: SessionId
  requestedSpaceId?: string
  candidateId: string
} | undefined {
  const input = value as Record<string, unknown>
  const keys = input?.requestedSpaceId === undefined
    ? ['candidateId', 'sessionId']
    : ['candidateId', 'requestedSpaceId', 'sessionId']
  if (!exactObject(value, keys)
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || typeof value.candidateId !== 'string' || value.candidateId.trim() === ''
    || (value.requestedSpaceId !== undefined
      && (typeof value.requestedSpaceId !== 'string' || value.requestedSpaceId.trim() === ''))) {
    return undefined
  }
  return {
    sessionId: SessionId(value.sessionId),
    candidateId: value.candidateId,
    ...(value.requestedSpaceId === undefined ? {} : { requestedSpaceId: value.requestedSpaceId }),
  }
}

type MemorySearchInput = {
  sessionId: SessionId
  requestedSpaceId?: string
} & Omit<MemoryManagementQueryV1, 'context'>

function memorySearch(value: unknown): MemorySearchInput | undefined {
  if (!allowedObject(value, [
    'sessionId',
    'requestedSpaceId',
    'query',
    'memoryKind',
    'visibility',
    'recordStatus',
    'candidateStatus',
    'limit',
  ])
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || (value.requestedSpaceId !== undefined
      && (typeof value.requestedSpaceId !== 'string' || value.requestedSpaceId.trim() === ''))
    || (value.query !== undefined && typeof value.query !== 'string')
    || (value.visibility !== undefined && value.visibility !== 'personal' && value.visibility !== 'confidential')
    || (value.recordStatus !== undefined && value.recordStatus !== 'active'
      && value.recordStatus !== 'inactive' && value.recordStatus !== 'all')
    || (value.candidateStatus !== undefined && value.candidateStatus !== 'pending'
      && value.candidateStatus !== 'approved' && value.candidateStatus !== 'rejected'
      && value.candidateStatus !== 'superseded' && value.candidateStatus !== 'all')
    || (value.limit !== undefined
      && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 500))) {
    return undefined
  }
  let memoryKind: ReturnType<typeof parseMemoryKind> | undefined
  try {
    memoryKind = value.memoryKind === undefined ? undefined : parseMemoryKind(value.memoryKind)
  } catch {
    return undefined
  }
  return {
    sessionId: SessionId(value.sessionId),
    ...(value.requestedSpaceId === undefined ? {} : { requestedSpaceId: value.requestedSpaceId }),
    ...(value.query === undefined ? {} : { query: value.query }),
    ...(memoryKind === undefined ? {} : { memoryKind }),
    ...(value.visibility === undefined ? {} : { visibility: value.visibility }),
    ...(value.recordStatus === undefined ? {} : { recordStatus: value.recordStatus }),
    ...(value.candidateStatus === undefined ? {} : { candidateStatus: value.candidateStatus }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
  }
}

function memorySourceSelection(value: unknown): {
  sessionId: SessionId
  requestedSpaceId?: string
  entity: 'record' | 'candidate'
  id: string
} | undefined {
  const input = value as Record<string, unknown>
  const keys = input?.requestedSpaceId === undefined
    ? ['entity', 'id', 'sessionId']
    : ['entity', 'id', 'requestedSpaceId', 'sessionId']
  if (!exactObject(value, keys)
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || (value.entity !== 'record' && value.entity !== 'candidate')
    || typeof value.id !== 'string' || value.id.trim() === ''
    || (value.requestedSpaceId !== undefined
      && (typeof value.requestedSpaceId !== 'string' || value.requestedSpaceId.trim() === ''))) {
    return undefined
  }
  return {
    sessionId: SessionId(value.sessionId),
    entity: value.entity,
    id: value.id,
    ...(value.requestedSpaceId === undefined ? {} : { requestedSpaceId: value.requestedSpaceId }),
  }
}

function memoryCandidateRevision(value: unknown): {
  sessionId: SessionId
  requestedSpaceId?: string
  requestId: string
  candidateIds: string[]
  content: string
  visibility: 'personal' | 'confidential'
  memoryKind: ReturnType<typeof parseMemoryKind>
} | undefined {
  const input = value as Record<string, unknown>
  const keys = input?.requestedSpaceId === undefined
    ? ['candidateIds', 'content', 'memoryKind', 'requestId', 'sessionId', 'visibility']
    : ['candidateIds', 'content', 'memoryKind', 'requestId', 'requestedSpaceId', 'sessionId', 'visibility']
  if (!exactObject(value, keys)
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || typeof value.requestId !== 'string' || value.requestId.trim() === ''
    || !Array.isArray(value.candidateIds) || value.candidateIds.length === 0
    || value.candidateIds.some(item => typeof item !== 'string' || item.trim() === '')
    || typeof value.content !== 'string' || value.content.trim() === ''
    || (value.visibility !== 'personal' && value.visibility !== 'confidential')
    || (value.requestedSpaceId !== undefined
      && (typeof value.requestedSpaceId !== 'string' || value.requestedSpaceId.trim() === ''))) {
    return undefined
  }
  let memoryKind: ReturnType<typeof parseMemoryKind>
  try {
    memoryKind = parseMemoryKind(value.memoryKind)
  } catch {
    return undefined
  }
  return {
    sessionId: SessionId(value.sessionId),
    requestId: value.requestId,
    candidateIds: value.candidateIds as string[],
    content: value.content,
    visibility: value.visibility,
    memoryKind,
    ...(value.requestedSpaceId === undefined ? {} : { requestedSpaceId: value.requestedSpaceId }),
  }
}

function batchDecision(value: unknown): MemoryBatchDecisionV1 | undefined {
  if (!allowedObject(value, ['action', 'candidateId', 'resolution'])
    || typeof value.candidateId !== 'string' || value.candidateId.trim() === ''
    || (value.action !== 'approve' && value.action !== 'reject')) return undefined
  let resolution: MemoryBatchDecisionV1['resolution']
  if (value.resolution !== undefined) {
    if (!allowedObject(value.resolution, ['kind', 'memoryId'])) return undefined
    if (value.resolution.kind === 'keep-both' && value.resolution.memoryId === undefined) {
      resolution = { kind: 'keep-both' }
    } else if (value.resolution.kind === 'supersede'
      && typeof value.resolution.memoryId === 'string' && value.resolution.memoryId.trim() !== '') {
      resolution = { kind: 'supersede', memoryId: value.resolution.memoryId }
    } else return undefined
  }
  if (value.action === 'reject' && resolution !== undefined) return undefined
  return {
    candidateId: value.candidateId,
    action: value.action,
    ...(resolution === undefined ? {} : { resolution }),
  }
}

function memoryBatch(value: unknown): {
  sessionId: SessionId
  requestedSpaceId?: string
  requestId: string
  decisions: MemoryBatchDecisionV1[]
} | undefined {
  const input = value as Record<string, unknown>
  const keys = input?.requestedSpaceId === undefined
    ? ['decisions', 'requestId', 'sessionId']
    : ['decisions', 'requestId', 'requestedSpaceId', 'sessionId']
  if (!exactObject(value, keys)
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || typeof value.requestId !== 'string' || value.requestId.trim() === ''
    || !Array.isArray(value.decisions)
    || (value.requestedSpaceId !== undefined
      && (typeof value.requestedSpaceId !== 'string' || value.requestedSpaceId.trim() === ''))) {
    return undefined
  }
  const decisions = value.decisions.map(batchDecision)
  if (decisions.some(decision => decision === undefined)) return undefined
  return {
    sessionId: SessionId(value.sessionId),
    requestId: value.requestId,
    decisions: decisions as MemoryBatchDecisionV1[],
    ...(value.requestedSpaceId === undefined ? {} : { requestedSpaceId: value.requestedSpaceId }),
  }
}

function activeSpaceReceipt(governance: MemorySpaceGovernanceSessionV1) {
  return {
    spaceId: governance.spaceId,
    access: governance.access,
    bindingRevision: governance.bindingRevision,
  }
}

/** Register the Memory-owned loopback RPC channel. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => connectionRpc(ctx).handle('/dsh-mmem-settings', async (endpoint, payload) => {
      if (endpoint !== 'candidates/list'
        && endpoint !== 'candidates/approve'
        && endpoint !== 'candidates/reject'
        && endpoint !== 'memory/search'
        && endpoint !== 'memory/source'
        && endpoint !== 'memory/assess'
        && endpoint !== 'memory/edit'
        && endpoint !== 'memory/merge'
        && endpoint !== 'memory/batch') {
        return badRequest('Unknown dsh-Mmem Settings operation.')
      }
      const decision = endpoint === 'candidates/approve' || endpoint === 'candidates/reject'
        ? candidateDecision(payload)
        : undefined
      const search = endpoint === 'memory/search' ? memorySearch(payload) : undefined
      const source = endpoint === 'memory/source' ? memorySourceSelection(payload) : undefined
      const assessment = endpoint === 'memory/assess' ? candidateSelection(payload) : undefined
      const revision = endpoint === 'memory/edit' || endpoint === 'memory/merge'
        ? memoryCandidateRevision(payload)
        : undefined
      const batch = endpoint === 'memory/batch' ? memoryBatch(payload) : undefined
      const selection = endpoint === 'candidates/list'
        ? sessionSelection(payload)
        : decision ?? search ?? source ?? assessment ?? revision ?? batch
      if (selection === undefined) {
        if (endpoint === 'candidates/list') {
          return badRequest('Candidate listing requires one live DSH sessionId and an optional requestedSpaceId.')
        }
        if (endpoint === 'memory/search') return badRequest('Memory search filters are invalid.')
        if (endpoint === 'memory/source') return badRequest('Memory source selection is invalid.')
        if (endpoint === 'memory/assess') return badRequest('Memory Candidate assessment selection is invalid.')
        if (endpoint === 'memory/edit' || endpoint === 'memory/merge') {
          return badRequest('Memory Candidate revision is invalid.')
        }
        if (endpoint === 'memory/batch') return badRequest('Memory batch governance request is invalid.')
        return badRequest('Candidate decision requires sessionId, candidateId, requestId, and an optional requestedSpaceId.')
      }
      if (endpoint === 'candidates/reject' && decision?.resolution !== undefined) {
        return badRequest('Candidate rejection does not accept a conflict resolution.')
      }
      const session = ctx.sessions.get(selection.sessionId)
      if (session === undefined) {
        return {
          ok: false,
          error: {
            code: 'session-not-found',
            message: 'The selected DSH Session is not live.',
            details: { sessionId: selection.sessionId },
          },
        }
      }
      try {
        const governance = await ctx.dshMmemSpaceGovernance.resolve({
          sessionHeader: session.header,
          ...(selection.requestedSpaceId === undefined
            ? {}
            : { requestedSpaceId: selection.requestedSpaceId }),
        })
        if (search !== undefined) {
          const value: MemoryManagementRpcSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            management: governance.manage({
              ...(search.query === undefined ? {} : { query: search.query }),
              ...(search.memoryKind === undefined ? {} : { memoryKind: search.memoryKind }),
              ...(search.visibility === undefined ? {} : { visibility: search.visibility }),
              ...(search.recordStatus === undefined ? {} : { recordStatus: search.recordStatus }),
              ...(search.candidateStatus === undefined ? {} : { candidateStatus: search.candidateStatus }),
              ...(search.limit === undefined ? {} : { limit: search.limit }),
            }),
          }
          return { ok: true, value }
        }
        if (source !== undefined) {
          const value: MemorySourceRpcSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            source: governance.sourceView({ entity: source.entity, id: source.id }),
          }
          return { ok: true, value }
        }
        if (assessment !== undefined) {
          const value: MemoryAssessmentRpcSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            assessment: governance.assessCandidate({ candidateId: assessment.candidateId }),
          }
          return { ok: true, value }
        }
        if (revision !== undefined) {
          const request = {
            candidateIds: revision.candidateIds,
            sourceMessageId: `dsh-mmem-settings:${revision.requestId}`,
            content: revision.content,
            visibility: revision.visibility,
            memoryKind: revision.memoryKind,
          }
          const value: MemoryCandidateRevisionRpcSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            candidate: endpoint === 'memory/edit'
              ? await governance.editCandidate(request)
              : await governance.mergeCandidates(request),
          }
          return { ok: true, value }
        }
        if (batch !== undefined) {
          const value: MemoryBatchRpcSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            batch: await governance.batchDecide({
              requestId: batch.requestId,
              decisions: batch.decisions,
            }),
          }
          return { ok: true, value }
        }
        if (decision !== undefined && endpoint === 'candidates/approve') {
          const value: MemoryCandidateApprovalSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            memory: await governance.approveCandidate({
              candidateId: decision.candidateId,
              sourceMessageId: `dsh-mmem-settings:${decision.requestId}`,
              ...(decision.resolution === undefined ? {} : { resolution: decision.resolution }),
            }),
          }
          return { ok: true, value }
        }
        if (decision !== undefined) {
          const value: MemoryCandidateRejectionSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            candidate: await governance.rejectCandidate({
              candidateId: decision.candidateId,
              sourceMessageId: `dsh-mmem-settings:${decision.requestId}`,
            }),
          }
          return { ok: true, value }
        }
        const value: MemoryCandidateQueueSnapshotV1 = {
          schemaVersion: 1,
          activeSpace: activeSpaceReceipt(governance),
          candidates: governance.listCandidates(),
        }
        return { ok: true, value }
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : 'Memory Space governance is unavailable.')
      }
    }, { authority: 'loopback' }),
    'dsh-mmem: loopback Settings RPC',
  )
}
