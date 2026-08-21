/** Loopback-only DSH Host adapter for dsh-Mmem Settings clients. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  MemoryRelationshipSelectionV1,
  MemoryBatchDecisionV1,
  MemoryManagementQueryV1,
} from './contracts.js'
import { parseMemoryKind } from './domain.js'
import type {
  MemoryAssessmentRpcSnapshotV1,
  MemoryBatchRpcSnapshotV1,
  MemoryApprovalSettingsRpcSnapshotV1,
  MemoryCandidateApprovalSnapshotV1,
  MemoryCandidateQueueSnapshotV1,
  MemoryCandidateRejectionSnapshotV1,
  MemoryCandidateRevisionRpcSnapshotV1,
  MemoryManagementRpcSnapshotV1,
  MemorySourceRpcSnapshotV1,
  MemoryTurnSummarySettingsRpcSnapshotV1,
  MemorySpaceSharingSettingsRpcSnapshotV1,
  MemorySpaceSetupRpcSnapshotV1,
} from './settings-client.js'
import {
  MemorySpaceGovernanceUnavailableError,
  type MemorySpaceGovernanceSessionV1,
} from './space-governance.js'
import {
  MemoryRuntimeSettingsError,
  type MemoryApprovalPolicyUpdateV1,
  type MemoryTurnSummaryPolicyUpdateV1,
} from './runtime-settings.js'
import { parseMemoryTurnSummaryPolicyUpdateV1 } from './turn-summary-policy.js'
import {
  MemorySpaceSharingError,
  type MemorySpaceSharingSettingsV1,
  type ReplaceMemorySpaceSharingPolicyRequestV1,
} from './space-sharing.js'
import type { MemorySpaceSetupV1 } from './space-catalog.js'

export type {
  MemoryAssessmentRpcSnapshotV1,
  MemoryBatchRpcSnapshotV1,
  MemoryApprovalSettingsRpcSnapshotV1,
  MemoryCandidateApprovalSnapshotV1,
  MemoryCandidateQueueSnapshotV1,
  MemoryCandidateRejectionSnapshotV1,
  MemoryCandidateRevisionRpcSnapshotV1,
  MemoryManagementRpcSnapshotV1,
  MemorySourceRpcSnapshotV1,
  MemoryTurnSummarySettingsRpcSnapshotV1,
  MemorySpaceSharingSettingsRpcSnapshotV1,
  MemorySpaceSetupRpcSnapshotV1,
} from './settings-client.js'

/** Cordis plugin name for the standalone Memory Settings Host. */
export const name = 'dsh-mmem-settings-host'

/** Only public DSH services and the Memory-owned governance resolver are required. */
export const inject = ['connection', 'sessions', 'dshMmemSpaceGovernance', 'dshMmemRuntimeSettings']

type MemorySettingsRpcResult =
  | { ok: true; value: unknown }
  | {
      ok: false
      error: {
        code: 'active-space-unavailable' | 'bad-request' | 'session-not-found'
          | 'settings-revision-conflict' | 'settings-not-configured'
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
  relationships?: readonly MemoryRelationshipSelectionV1[]
} | undefined {
  const input = value as Record<string, unknown>
  const keys = [
    'candidateId',
    'requestId',
    ...(input?.requestedSpaceId === undefined ? [] : ['requestedSpaceId']),
    ...(input?.resolution === undefined ? [] : ['resolution']),
    ...(input?.relationships === undefined ? [] : ['relationships']),
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
  let relationships: MemoryRelationshipSelectionV1[] | undefined
  if (value.relationships !== undefined) {
    if (!Array.isArray(value.relationships) || value.relationships.length > 20) return undefined
    relationships = []
    const targets = new Set<string>()
    for (const item of value.relationships) {
      if (!exactObject(item, ['relation', 'targetMemoryId'])
        || typeof item.targetMemoryId !== 'string' || item.targetMemoryId.trim() === ''
        || (item.relation !== 'related-to' && item.relation !== 'elaborates'
          && item.relation !== 'contradicts')
        || targets.has(item.targetMemoryId)) return undefined
      targets.add(item.targetMemoryId)
      relationships.push({ targetMemoryId: item.targetMemoryId, relation: item.relation })
    }
  }
  return {
    sessionId: SessionId(value.sessionId),
    candidateId: value.candidateId,
    requestId: value.requestId,
    ...(resolution === undefined ? {} : { resolution }),
    ...(relationships === undefined ? {} : { relationships }),
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
      && value.candidateStatus !== 'superseded' && value.candidateStatus !== 'expired'
      && value.candidateStatus !== 'all')
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

type MemoryApprovalUpdateInput = {
  sessionId: SessionId
  requestedSpaceId?: string
  update: MemoryApprovalPolicyUpdateV1
}

function memoryApprovalUpdate(value: unknown): MemoryApprovalUpdateInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const scheduled = input.mode === 'scheduled-auto'
  const keys = [
    'sessionId',
    'expectedRevision',
    'mode',
    ...(input.requestedSpaceId === undefined ? [] : ['requestedSpaceId']),
    ...(scheduled ? ['timeZone', 'localTime'] : []),
  ]
  if (!exactObject(value, keys)
    || typeof input.sessionId !== 'string' || input.sessionId.trim() === ''
    || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0
    || (input.mode !== 'manual' && input.mode !== 'scheduled-auto')
    || (input.requestedSpaceId !== undefined
      && (typeof input.requestedSpaceId !== 'string' || input.requestedSpaceId.trim() === ''))
    || (scheduled && (typeof input.timeZone !== 'string' || typeof input.localTime !== 'string'))) {
    return undefined
  }
  return {
    sessionId: SessionId(input.sessionId),
    ...(input.requestedSpaceId === undefined ? {} : { requestedSpaceId: input.requestedSpaceId as string }),
    update: input.mode === 'manual'
      ? { expectedRevision: input.expectedRevision as number, mode: 'manual' }
      : {
          expectedRevision: input.expectedRevision as number,
          mode: 'scheduled-auto',
          timeZone: input.timeZone as string,
          localTime: input.localTime as string,
        },
  }
}

type MemoryTurnSummaryUpdateInput = {
  sessionId: SessionId
  requestedSpaceId?: string
  update: MemoryTurnSummaryPolicyUpdateV1
}

function memoryTurnSummaryUpdate(value: unknown): MemoryTurnSummaryUpdateInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.sessionId !== 'string' || input.sessionId.trim() === ''
    || (input.requestedSpaceId !== undefined
      && (typeof input.requestedSpaceId !== 'string' || input.requestedSpaceId.trim() === ''))) return undefined
  const updateValue = {
    expectedRevision: input.expectedRevision,
    mode: input.mode,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
  }
  const expectedKeys = [
    'sessionId', 'expectedRevision', 'mode',
    ...(input.requestedSpaceId === undefined ? [] : ['requestedSpaceId']),
    ...(input.provider === undefined ? [] : ['provider']),
    ...(input.model === undefined ? [] : ['model']),
  ]
  if (!exactObject(value, expectedKeys)) return undefined
  try {
    return {
      sessionId: SessionId(input.sessionId),
      ...(input.requestedSpaceId === undefined ? {} : { requestedSpaceId: input.requestedSpaceId as string }),
      update: parseMemoryTurnSummaryPolicyUpdateV1(updateValue),
    }
  } catch {
    return undefined
  }
}

type MemorySharingUpdateInput = {
  sessionId: SessionId
  requestedSpaceId?: string
  update: Omit<ReplaceMemorySpaceSharingPolicyRequestV1, 'ownerId'>
}

function memorySharingUpdate(value: unknown): MemorySharingUpdateInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const keys = [
    'sessionId',
    ...(input.requestedSpaceId === undefined ? [] : ['requestedSpaceId']),
    'expectedRevision',
    'mode',
    'grants',
    'federations',
  ]
  if (!exactObject(value, keys)
    || typeof input.sessionId !== 'string' || input.sessionId.trim() === ''
    || (input.requestedSpaceId !== undefined
      && (typeof input.requestedSpaceId !== 'string' || input.requestedSpaceId.trim() === ''))
    || typeof input.expectedRevision !== 'string' || input.expectedRevision.trim() === ''
    || (input.mode !== 'isolated' && input.mode !== 'selective' && input.mode !== 'federated')
    || !Array.isArray(input.grants) || !Array.isArray(input.federations)) {
    return undefined
  }
  return {
    sessionId: SessionId(input.sessionId),
    ...(input.requestedSpaceId === undefined ? {} : { requestedSpaceId: input.requestedSpaceId as string }),
    update: {
      expectedRevision: input.expectedRevision,
      mode: input.mode,
      grants: input.grants as ReplaceMemorySpaceSharingPolicyRequestV1['grants'],
      federations: input.federations as ReplaceMemorySpaceSharingPolicyRequestV1['federations'],
    },
  }
}

function memorySpaceCreate(value: unknown): { sessionId: SessionId; name: string } | undefined {
  if (!exactObject(value, ['sessionId', 'name'])
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || typeof value.name !== 'string' || value.name.trim() === '') return undefined
  return { sessionId: SessionId(value.sessionId), name: value.name }
}

function memorySpaceBind(value: unknown): {
  sessionId: SessionId
  spaceId: string
  access: 'read' | 'read-write'
  defaultWrite: boolean
} | undefined {
  if (!exactObject(value, ['sessionId', 'spaceId', 'access', 'defaultWrite'])
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || typeof value.spaceId !== 'string' || value.spaceId.trim() === ''
    || (value.access !== 'read' && value.access !== 'read-write')
    || typeof value.defaultWrite !== 'boolean'
    || (value.defaultWrite && value.access !== 'read-write')) return undefined
  return {
    sessionId: SessionId(value.sessionId),
    spaceId: value.spaceId,
    access: value.access,
    defaultWrite: value.defaultWrite,
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
        && endpoint !== 'memory/batch'
        && endpoint !== 'relationships/list'
        && endpoint !== 'settings/get'
        && endpoint !== 'settings/approval'
        && endpoint !== 'summary/get'
        && endpoint !== 'summary/update'
        && endpoint !== 'sharing/get'
        && endpoint !== 'sharing/replace'
        && endpoint !== 'spaces/get'
        && endpoint !== 'spaces/create'
        && endpoint !== 'spaces/bind') {
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
      const approvalUpdate = endpoint === 'settings/approval' ? memoryApprovalUpdate(payload) : undefined
      const summaryUpdate = endpoint === 'summary/update' ? memoryTurnSummaryUpdate(payload) : undefined
      const sharingUpdate = endpoint === 'sharing/replace' ? memorySharingUpdate(payload) : undefined
      const spaceCreate = endpoint === 'spaces/create' ? memorySpaceCreate(payload) : undefined
      const spaceBind = endpoint === 'spaces/bind' ? memorySpaceBind(payload) : undefined
      const selection = endpoint === 'candidates/list' || endpoint === 'relationships/list'
        || endpoint === 'settings/get' || endpoint === 'sharing/get'
        || endpoint === 'summary/get'
        || endpoint === 'spaces/get'
        ? sessionSelection(payload)
        : decision ?? search ?? source ?? assessment ?? revision ?? batch ?? approvalUpdate ?? summaryUpdate ?? sharingUpdate
          ?? spaceCreate ?? spaceBind
      if (selection === undefined) {
        if (endpoint === 'candidates/list' || endpoint === 'settings/get' || endpoint === 'sharing/get') {
          return badRequest('Candidate listing requires one live DSH sessionId and an optional requestedSpaceId.')
        }
        if (endpoint === 'sharing/replace') return badRequest('Memory Space sharing policy update is invalid.')
        if (endpoint === 'spaces/create') return badRequest('Memory Space creation request is invalid.')
        if (endpoint === 'spaces/bind') return badRequest('DSH Workspace Binding request is invalid.')
        if (endpoint === 'settings/approval') return badRequest('Memory approval policy update is invalid.')
        if (endpoint === 'summary/update') return badRequest('Memory turn summary policy update is invalid.')
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
        if (endpoint === 'spaces/get' || spaceCreate !== undefined || spaceBind !== undefined) {
          const setup = ctx.get('dshMmemSpaceSetup') as MemorySpaceSetupV1 | undefined
          if (setup === undefined) return badRequest('Memory Space setup is unavailable.')
          const state = spaceCreate !== undefined
            ? await setup.createSpace(session.header, { name: spaceCreate.name })
            : spaceBind !== undefined
              ? await setup.bindCurrentDshWorkspace(session.header, {
                  spaceId: spaceBind.spaceId,
                  access: spaceBind.access,
                  defaultWrite: spaceBind.defaultWrite,
                })
              : await setup.inspect(session.header)
          const value: MemorySpaceSetupRpcSnapshotV1 = {
            schemaVersion: 1,
            spaces: state.spaces,
            bindings: state.bindings,
          }
          return { ok: true, value }
        }
        const requestedSpaceId = 'requestedSpaceId' in selection
          ? selection.requestedSpaceId
          : undefined
        const governance = await ctx.dshMmemSpaceGovernance.resolve({
          sessionHeader: session.header,
          ...(requestedSpaceId === undefined
            ? {}
            : { requestedSpaceId }),
        })
        if (endpoint === 'sharing/get' || sharingUpdate !== undefined) {
          if (sharingUpdate !== undefined && governance.access !== 'read-write') {
            return badRequest('Memory Space sharing policy updates require a read-write Active Space Binding.')
          }
          const sharingSettings = ctx.get('dshMmemSpaceSharingSettings') as MemorySpaceSharingSettingsV1 | undefined
          if (sharingSettings === undefined) {
            return {
              ok: false,
              error: {
                code: 'settings-not-configured',
                message: 'Memory Space sharing is not configured.',
                details: {},
              },
            }
          }
          const settings = sharingUpdate === undefined
            ? await sharingSettings.inspect()
            : await sharingSettings.replacePolicy(sharingUpdate.update)
          const value: MemorySpaceSharingSettingsRpcSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            spaces: settings.spaces,
            sharingPolicy: settings.sharingPolicy,
          }
          return { ok: true, value }
        }
        if (endpoint === 'settings/get' || approvalUpdate !== undefined) {
          if (approvalUpdate !== undefined && governance.access !== 'read-write') {
            return badRequest('Memory approval policy updates require a read-write Active Space Binding.')
          }
          const settings = approvalUpdate === undefined
            ? await ctx.dshMmemRuntimeSettings.get()
            : await ctx.dshMmemRuntimeSettings.updateApproval(approvalUpdate.update)
          const value: MemoryApprovalSettingsRpcSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            approvalPolicy: settings.approvalPolicy,
          }
          return { ok: true, value }
        }
        if (endpoint === 'summary/get' || summaryUpdate !== undefined) {
          if (summaryUpdate !== undefined && governance.access !== 'read-write') {
            return badRequest('Memory turn summary policy updates require a read-write Active Space Binding.')
          }
          const policy = summaryUpdate === undefined
            ? await ctx.dshMmemRuntimeSettings.getTurnSummary(governance.spaceId)
            : await ctx.dshMmemRuntimeSettings.updateTurnSummary(governance.spaceId, summaryUpdate.update)
          const value: MemoryTurnSummarySettingsRpcSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            turnSummaryPolicy: policy,
          }
          return { ok: true, value }
        }
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
        if (endpoint === 'relationships/list') {
          return {
            ok: true,
            value: {
              schemaVersion: 1,
              activeSpace: activeSpaceReceipt(governance),
              relationships: governance.listRelationships(),
            },
          }
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
              ...(decision.relationships === undefined ? {} : { relationships: decision.relationships }),
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
        if (error instanceof MemorySpaceGovernanceUnavailableError) {
          const message = error.reason === 'default-write-space-unavailable'
            ? 'The current DSH Workspace has no default Memory Space.'
            : error.reason === 'requested-space-unavailable'
              ? 'The requested Memory Space is unavailable to the current DSH Workspace.'
              : 'The selected DSH Session has no Workspace.'
          return {
            ok: false,
            error: {
              code: 'active-space-unavailable',
              message,
              details: { reason: error.reason },
            },
          }
        }
        if (error instanceof MemoryRuntimeSettingsError) {
          return {
            ok: false,
            error: {
              code: error.code === 'SETTINGS_REVISION_CONFLICT'
                ? 'settings-revision-conflict'
                : 'settings-not-configured',
              message: error.message,
              details: {},
            },
          }
        }
        if (error instanceof MemorySpaceSharingError
          && error.code === 'MEMORY_SPACE_SHARING_REVISION_MISMATCH') {
          return {
            ok: false,
            error: {
              code: 'settings-revision-conflict',
              message: error.message,
              details: {},
            },
          }
        }
        return badRequest(error instanceof Error ? error.message : 'Memory Space governance is unavailable.')
      }
    }, { authority: 'loopback' }),
    'dsh-mmem: loopback Settings RPC',
  )
}
