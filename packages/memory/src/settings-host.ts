/** Loopback-only DSH Host adapter for dsh-Mmem Settings clients. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MemoryCandidate, MemoryRecord } from './contracts.js'
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
} | undefined {
  const input = value as Record<string, unknown>
  const keys = input?.requestedSpaceId === undefined
    ? ['candidateId', 'requestId', 'sessionId']
    : ['candidateId', 'requestId', 'requestedSpaceId', 'sessionId']
  if (!exactObject(value, keys)
    || typeof value.sessionId !== 'string' || value.sessionId.trim() === ''
    || typeof value.candidateId !== 'string' || value.candidateId.trim() === ''
    || typeof value.requestId !== 'string' || value.requestId.trim() === ''
    || (value.requestedSpaceId !== undefined
      && (typeof value.requestedSpaceId !== 'string' || value.requestedSpaceId.trim() === ''))) {
    return undefined
  }
  return {
    sessionId: SessionId(value.sessionId),
    candidateId: value.candidateId,
    requestId: value.requestId,
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
        && endpoint !== 'candidates/reject') {
        return badRequest('Unknown dsh-Mmem Settings operation.')
      }
      const decision = endpoint === 'candidates/list' ? undefined : candidateDecision(payload)
      const selection = endpoint === 'candidates/list' ? sessionSelection(payload) : decision
      if (selection === undefined) return badRequest(endpoint === 'candidates/list'
        ? 'Candidate listing requires one live DSH sessionId and an optional requestedSpaceId.'
        : 'Candidate decision requires sessionId, candidateId, requestId, and an optional requestedSpaceId.')
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
        if (decision !== undefined && endpoint === 'candidates/approve') {
          const value: MemoryCandidateApprovalSnapshotV1 = {
            schemaVersion: 1,
            activeSpace: activeSpaceReceipt(governance),
            memory: await governance.approveCandidate({
              candidateId: decision.candidateId,
              sourceMessageId: `dsh-mmem-settings:${decision.requestId}`,
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
