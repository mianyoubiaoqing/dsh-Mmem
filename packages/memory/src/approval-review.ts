import type { Context } from '@deepseek-ai/cordis'
import type { MemoryCandidate } from './contracts.js'
import type { MemoryConflictAssessmentV1 } from './conflict.js'
import type { MemoryAccessContextV1, MemoryKind } from './domain.js'
import type { MemoryPrincipalResolverV1 } from './principal.js'
import type { MemoryRuntimeSettingsManagerV1 } from './runtime-settings.js'
import type { MemorySpaceArchiveRouterV1 } from './space-archive-router.js'
import type { DshWorkspaceBindingV1, MemorySpaceCatalogV1 } from './space-catalog.js'
import type {
  MemoryScheduledApprovalReviewReceiptV1,
  MemoryScheduledApprovalRunnerV1,
} from './approval-scheduler.js'

/** DSH Session receipt returned beside one untrusted review suggestion. */
export type MemoryApprovalReviewSessionReceiptV1 = Omit<
  MemoryScheduledApprovalReviewReceiptV1,
  'candidateId'
>

/** Model-facing review input selected by governed Memory code. */
export interface MemoryApprovalReviewRequestV1 {
  schemaVersion: 1
  runId: string
  spaceId: string
  dshWorkspaceCwd: string
  bindingRevision: string
  candidate: Readonly<MemoryCandidate>
  assessment: Readonly<MemoryConflictAssessmentV1>
  /** Required user-visible Source Turn evidence for model-compressed summary Candidates. */
  turnEvidence?: string
  signal: AbortSignal
}

const MAX_SUMMARY_REVIEW_EVIDENCE_CHARACTERS = 32_000

function modelCompressedSummary(candidate: MemoryCandidate): boolean {
  return candidate.memoryKind === 'summary'
    && candidate.extraction?.providerId === 'dsh-turn-summary'
    && candidate.extraction.receipt.kind === 'dsh-session'
}

function modelSummaryEvidence(
  archive: { expandTurnEvidence: (input: {
    context: MemoryAccessContextV1
    candidateId: string
    cursor?: number
    maxCharacters?: number
  }) => { content: string; nextCursor?: number } },
  context: MemoryAccessContextV1,
  candidateId: string,
): string | undefined {
  let cursor = 0
  let content = ''
  while (content.length < MAX_SUMMARY_REVIEW_EVIDENCE_CHARACTERS) {
    const page = archive.expandTurnEvidence({
      context,
      candidateId,
      cursor,
      maxCharacters: Math.min(10_000, MAX_SUMMARY_REVIEW_EVIDENCE_CHARACTERS - content.length),
    })
    content += page.content
    if (page.nextCursor === undefined) return content
    cursor = page.nextCursor
  }
  return undefined
}

/** Strict recommendation shape; it is never itself authority to mutate Memory. */
export interface MemoryApprovalReviewSuggestionV1 {
  schemaVersion: 1
  candidateId: string
  decision: 'approve' | 'reject' | 'defer'
  confidence: number
  reasonCode: 'supported' | 'unsupported' | 'uncertain' | 'unsafe'
  receipt: MemoryApprovalReviewSessionReceiptV1
}

/** Replaceable evaluator whose model-backed Adapters must return DSH Session evidence. */
export interface MemoryApprovalReviewEvaluatorV1 {
  readonly id: string
  readonly version: string
  evaluate(request: MemoryApprovalReviewRequestV1): Promise<unknown>
}

/** Single-active evaluator registry. Zero evaluators keeps the scheduler armed but inactive. */
export class MemoryApprovalReviewEvaluatorRegistryV1 {
  #evaluator: MemoryApprovalReviewEvaluatorV1 | undefined

  register(evaluator: MemoryApprovalReviewEvaluatorV1): () => void {
    if (this.#evaluator !== undefined) throw new Error('a Memory approval review evaluator is already active')
    if (evaluator.id.trim() === '' || evaluator.version.trim() === '') {
      throw new Error('Memory approval review evaluator id and version must be non-empty')
    }
    this.#evaluator = evaluator
    return () => {
      if (this.#evaluator === evaluator) this.#evaluator = undefined
    }
  }

  current(): MemoryApprovalReviewEvaluatorV1 | undefined {
    return this.#evaluator
  }
}

export interface GovernedMemoryScheduledApprovalRunnerOptionsV1 {
  principalResolver: MemoryPrincipalResolverV1
  catalog: MemorySpaceCatalogV1
  router: MemorySpaceArchiveRouterV1
  settings: MemoryRuntimeSettingsManagerV1
  evaluators: MemoryApprovalReviewEvaluatorRegistryV1
  maxCandidates?: number
  minimumConfidence?: number
}

const COMPANION_SCOPE = { version: 1, kind: 'companion-reality' } as const
const AUTO_REVIEW_KINDS = new Set<MemoryKind>([
  'preference', 'biographical', 'relationship', 'episode', 'state', 'summary',
])

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted()
  const keys = [...expected].toSorted()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${label} contains missing or unknown fields`)
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be non-empty`)
  return value
}

function sequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function sessionReceipt(value: unknown): MemoryApprovalReviewSessionReceiptV1 {
  const source = object(value, 'Memory approval DSH Session receipt')
  exactKeys(source, [
    'schemaVersion', 'sessionId', 'requestMessageId', 'responseMessageId',
    'requestSeq', 'responseSeq', 'provider', 'model',
  ], 'Memory approval DSH Session receipt')
  if (source.schemaVersion !== 1) throw new TypeError('Memory approval receipt schemaVersion must equal 1')
  const requestSeq = sequence(source.requestSeq, 'Memory approval receipt requestSeq')
  const responseSeq = sequence(source.responseSeq, 'Memory approval receipt responseSeq')
  if (responseSeq <= requestSeq) throw new TypeError('Memory approval responseSeq must follow requestSeq')
  return {
    schemaVersion: 1,
    sessionId: nonEmpty(source.sessionId, 'Memory approval receipt sessionId'),
    requestMessageId: nonEmpty(source.requestMessageId, 'Memory approval receipt requestMessageId'),
    responseMessageId: nonEmpty(source.responseMessageId, 'Memory approval receipt responseMessageId'),
    requestSeq,
    responseSeq,
    provider: nonEmpty(source.provider, 'Memory approval receipt provider'),
    model: nonEmpty(source.model, 'Memory approval receipt model'),
  }
}

/** Parse an untrusted evaluator recommendation and its mandatory DSH log evidence. */
export function parseMemoryApprovalReviewSuggestionV1(value: unknown): MemoryApprovalReviewSuggestionV1 {
  const source = object(value, 'Memory approval review suggestion')
  exactKeys(source, [
    'schemaVersion', 'candidateId', 'decision', 'confidence', 'reasonCode', 'receipt',
  ], 'Memory approval review suggestion')
  if (source.schemaVersion !== 1) throw new TypeError('Memory approval suggestion schemaVersion must equal 1')
  if (source.decision !== 'approve' && source.decision !== 'reject' && source.decision !== 'defer') {
    throw new TypeError('Memory approval suggestion decision is unsupported')
  }
  if (source.reasonCode !== 'supported' && source.reasonCode !== 'unsupported'
    && source.reasonCode !== 'uncertain' && source.reasonCode !== 'unsafe') {
    throw new TypeError('Memory approval suggestion reasonCode is unsupported')
  }
  if (typeof source.confidence !== 'number' || !Number.isFinite(source.confidence)
    || source.confidence < 0 || source.confidence > 1) {
    throw new TypeError('Memory approval suggestion confidence must be from 0 through 1')
  }
  return {
    schemaVersion: 1,
    candidateId: nonEmpty(source.candidateId, 'Memory approval suggestion candidateId'),
    decision: source.decision,
    confidence: source.confidence,
    reasonCode: source.reasonCode,
    receipt: sessionReceipt(source.receipt),
  }
}

function context(ownerId: string, authority: string): MemoryAccessContextV1 {
  return {
    version: 1,
    ownerId,
    authority,
    scope: COMPANION_SCOPE,
    channelDisclosure: 'owner-confidential',
    requestIntent: 'explicit-confidential-recall',
  }
}

function currentPolicyMatches(
  current: Awaited<ReturnType<MemoryRuntimeSettingsManagerV1['get']>>['approvalPolicy'],
  expected: Extract<Awaited<ReturnType<MemoryRuntimeSettingsManagerV1['get']>>['approvalPolicy'], { mode: 'scheduled-auto' }>,
): boolean {
  return current.mode === 'scheduled-auto'
    && current.revision === expected.revision
    && current.timeZone === expected.timeZone
    && current.localTime === expected.localTime
}

function blocking(assessment: MemoryConflictAssessmentV1): boolean {
  return assessment.relationships.some(item => item.relation === 'duplicate' || item.relation === 'conflict')
}

function bindingOrder(left: DshWorkspaceBindingV1, right: DshWorkspaceBindingV1): number {
  return Number(right.defaultWrite) - Number(left.defaultWrite)
    || left.spaceId.localeCompare(right.spaceId)
    || left.dshWorkspaceCwd.localeCompare(right.dshWorkspaceCwd)
}

function candidateFingerprint(candidate: MemoryCandidate): string {
  return JSON.stringify(candidate)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('scheduled Memory approval was cancelled')
}

/**
 * Create the only Module allowed to turn DSH-logged suggestions into Archive decisions.
 * Every Candidate is re-read through its exact Owner/Workspace Binding/Space before commit.
 */
export function createGovernedMemoryScheduledApprovalRunnerV1(
  options: GovernedMemoryScheduledApprovalRunnerOptionsV1,
): MemoryScheduledApprovalRunnerV1 {
  const maxCandidates = options.maxCandidates ?? 100
  const minimumConfidence = options.minimumConfidence ?? 0.9
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 1_000) {
    throw new TypeError('scheduled Memory approval maxCandidates must be from 1 through 1000')
  }
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0.5 || minimumConfidence > 1) {
    throw new TypeError('scheduled Memory approval minimumConfidence must be from 0.5 through 1')
  }

  return {
    id: 'dsh-mmem-governed-review',
    version: '1',
    available: () => options.evaluators.current() !== undefined,
    async run(request) {
      const evaluator = options.evaluators.current()
      if (evaluator === undefined) throw new Error('scheduled Memory approval evaluator is unavailable')
      const principal = options.principalResolver.trustedLocal()
      if (principal === undefined) throw new Error('scheduled Memory approval requires a trusted local Owner')
      const allBindings = (await options.catalog.listBindings({ ownerId: principal.ownerId })).bindings
        .filter(binding => binding.access === 'read-write')
        .toSorted(bindingOrder)
      const bindings = [...new Map(allBindings.map(binding => [binding.spaceId, binding])).values()]
      const reviewReceipts: MemoryScheduledApprovalReviewReceiptV1[] = []
      let reviewedCandidates = 0
      let approvedCandidates = 0
      let rejectedCandidates = 0
      let deferredCandidates = 0

      for (const binding of bindings) {
        throwIfAborted(request.signal)
        if (reviewedCandidates >= maxCandidates) break
        const resolved = await options.router.resolveSession({
          ownerId: principal.ownerId,
          sessionHeader: { cwd: binding.dshWorkspaceCwd },
          requestedSpaceId: binding.spaceId,
        })
        if (resolved.kind !== 'active' || resolved.access !== 'read-write'
          || resolved.bindingRevision !== binding.revision) continue
        const access = context(principal.ownerId, principal.authority)
        const candidates = resolved.listCandidates({
          context: access,
          limit: maxCandidates - reviewedCandidates,
        })
        for (const currentCandidate of candidates) {
          throwIfAborted(request.signal)
          reviewedCandidates += 1
          const candidate = structuredClone(currentCandidate)
          const initialAssessment = resolved.assessCandidate({ context: access, candidateId: candidate.id })
          if (!AUTO_REVIEW_KINDS.has(candidate.memoryKind) || blocking(initialAssessment)) {
            deferredCandidates += 1
            continue
          }
          let turnEvidence: string | undefined
          if (modelCompressedSummary(candidate)) {
            try {
              turnEvidence = modelSummaryEvidence(resolved, access, candidate.id)
            } catch {
              deferredCandidates += 1
              continue
            }
            if (turnEvidence === undefined) {
              deferredCandidates += 1
              continue
            }
          }
          let suggestion: MemoryApprovalReviewSuggestionV1
          try {
            suggestion = parseMemoryApprovalReviewSuggestionV1(await evaluator.evaluate({
              schemaVersion: 1,
              runId: request.runId,
              spaceId: binding.spaceId,
              dshWorkspaceCwd: binding.dshWorkspaceCwd,
              bindingRevision: binding.revision,
              candidate,
              assessment: initialAssessment,
              ...(turnEvidence === undefined ? {} : { turnEvidence }),
              signal: request.signal,
            }))
          } catch {
            throwIfAborted(request.signal)
            deferredCandidates += 1
            continue
          }
          reviewReceipts.push({ ...suggestion.receipt, candidateId: candidate.id })
          if (suggestion.candidateId !== candidate.id || suggestion.decision === 'defer'
            || suggestion.confidence < minimumConfidence) {
            deferredCandidates += 1
            continue
          }
          try {
            const latestPolicy = (await options.settings.get()).approvalPolicy
            const latestPrincipal = options.principalResolver.trustedLocal()
            if (!currentPolicyMatches(latestPolicy, request.policy)
              || latestPrincipal?.ownerId !== principal.ownerId
              || latestPrincipal.authority !== principal.authority) {
              deferredCandidates += 1
              continue
            }
            const latestSpace = await options.router.resolveSession({
              ownerId: principal.ownerId,
              sessionHeader: { cwd: binding.dshWorkspaceCwd },
              requestedSpaceId: binding.spaceId,
            })
            if (latestSpace.kind !== 'active' || latestSpace.access !== 'read-write'
              || latestSpace.bindingRevision !== binding.revision) {
              deferredCandidates += 1
              continue
            }
            const latestCandidate = latestSpace.listCandidates({ context: access, limit: 1_000 })
              .find(item => item.id === candidate.id)
            if (latestCandidate === undefined
              || candidateFingerprint(latestCandidate) !== candidateFingerprint(candidate)) {
              deferredCandidates += 1
              continue
            }
            const latestAssessment = latestSpace.assessCandidate({ context: access, candidateId: candidate.id })
            if (blocking(latestAssessment)) {
              deferredCandidates += 1
              continue
            }
            if (suggestion.decision === 'approve') {
              await latestSpace.approveCandidate({
                context: access,
                candidateId: candidate.id,
                sourceMessageId: suggestion.receipt.responseMessageId,
              })
              approvedCandidates += 1
            } else {
              await latestSpace.rejectCandidate({
                context: access,
                candidateId: candidate.id,
                sourceMessageId: suggestion.receipt.responseMessageId,
              })
              rejectedCandidates += 1
            }
          } catch {
            throwIfAborted(request.signal)
            deferredCandidates += 1
          }
        }
      }

      return {
        schemaVersion: 1,
        reviewedCandidates,
        approvedCandidates,
        rejectedCandidates,
        deferredCandidates,
        reviewReceipts,
      }
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Single-active, DSH-logged review evaluator registry. */
    dshMmemApprovalReviewEvaluators: MemoryApprovalReviewEvaluatorRegistryV1
  }
}
