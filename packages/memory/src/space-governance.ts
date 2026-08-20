import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { CompanionMemoryArchive, MemoryGovernanceService } from './contracts.js'
import type { MemoryAccessContextV1 } from './domain.js'
import type {
  MemorySpaceArchiveRouterV1,
  MemorySpaceSessionResolutionV1,
} from './space-archive-router.js'

/** Settings governance facade bound to exactly one Active Memory Space. */
export interface MemorySpaceGovernanceSessionV1 extends MemoryGovernanceService {
  schemaVersion: 1
  spaceId: string
  access: 'read' | 'read-write'
  bindingRevision: string
}

/** Trusted Host request for resolving the Active Space of a DSH Session. */
export interface ResolveMemorySpaceGovernanceRequestV1 {
  sessionHeader: Pick<SessionHeader, 'cwd'>
  requestedSpaceId?: string
}

/** Loopback-only resolver; the authenticated Owner is fixed during construction. */
export interface MemorySpaceGovernanceResolverV1 {
  resolve(request: ResolveMemorySpaceGovernanceRequestV1): Promise<MemorySpaceGovernanceSessionV1>
}

/** Stable reason why Settings governance could not select an Active Space. */
export type MemorySpaceGovernanceUnavailableReasonV1 = Extract<
  MemorySpaceSessionResolutionV1,
  { kind: 'unavailable' }
>['reason']

/** Fail-closed Settings error for a missing or inaccessible Active Space. */
export class MemorySpaceGovernanceUnavailableError extends Error {
  readonly code = 'MEMORY_SPACE_GOVERNANCE_UNAVAILABLE'

  constructor(readonly reason: MemorySpaceGovernanceUnavailableReasonV1) {
    super(`Memory Space governance is unavailable: ${reason}`)
    this.name = 'MemorySpaceGovernanceUnavailableError'
  }
}

type MemoryGovernanceArchive = Omit<CompanionMemoryArchive, 'dispose'>

/** @internal Build the one authoritative context-free governance facade. */
export function createMemoryGovernanceService(
  context: MemoryAccessContextV1,
  archive: MemoryGovernanceArchive,
): MemoryGovernanceService {
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

/** @internal Bind trusted Owner governance to the Router's exact Active Space. */
export function createMemorySpaceGovernanceResolver(
  context: MemoryAccessContextV1,
  router: MemorySpaceArchiveRouterV1,
): MemorySpaceGovernanceResolverV1 {
  return {
    async resolve(request) {
      const resolution = await router.resolveSession({
        ownerId: context.ownerId,
        sessionHeader: request.sessionHeader,
        ...(request.requestedSpaceId === undefined ? {} : { requestedSpaceId: request.requestedSpaceId }),
      })
      if (resolution.kind === 'unavailable') {
        throw new MemorySpaceGovernanceUnavailableError(resolution.reason)
      }
      return {
        schemaVersion: 1,
        spaceId: resolution.spaceId,
        access: resolution.access,
        bindingRevision: resolution.bindingRevision,
        ...createMemoryGovernanceService(context, resolution),
      }
    },
  }
}
