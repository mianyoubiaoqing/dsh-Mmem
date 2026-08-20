import type { ArchiveInspection } from './storage/index.js'
import type {
  MemoryAccessContextV1,
  MemoryKind,
  MemoryScopeV1,
} from './domain.js'
import type { CandidateExtractionReceiptV1, ExtractedMemoryDraftV1 } from './candidate-extraction.js'
import type { MemoryConflictAssessmentV1 } from './conflict.js'
import type { DerivedMemoryViewInvalidationReceiptV1 } from './lifecycle.js'

/** Owner-governed visibility retained with every memory. */
export type MemoryVisibility = 'personal' | 'confidential'

interface ScopedMemoryFields {
  schemaVersion: 2
  id: string
  ownerId: string
  scope: MemoryScopeV1
  observationId: string
  memoryKind: MemoryKind
  createdAt: string
  recordedAt: string
  validFrom?: string
  validTo?: string
  content: string
  visibility: MemoryVisibility
  sourceMessageId: string
}

/** Current append-only scoped companion memory record. */
export interface MemoryRecord extends ScopedMemoryFields {
  sourceCandidateId?: string
  supersedesMemoryId?: string
  /** Complete leaf lineage for an Owner-approved derived summary. */
  sourceMemoryIds?: string[]
  /** Replay-derived retrieval metadata; it never changes fact truth. */
  lifecycle?: {
    tier: 'hot' | 'cold' | 'archived'
    rankMultiplier: number
    updatedAt: string
  }
  status: 'confirmed' | 'forgotten' | 'superseded'
}

/** Owner-reviewable scoped memory that is never recalled before approval. */
export interface MemoryCandidate extends ScopedMemoryFields {
  event: 'candidate'
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  sourceCandidateIds?: string[]
  extraction?: {
    schemaVersion: 1
    providerId: string
    providerVersion: string
    receipt: CandidateExtractionReceiptV1
  }
}

/** Memory-owned atomic ingestion of one Provider result for one selected source. */
export interface ExtractedMemoryCandidateBatch extends TrustedMemoryRequest {
  sourceMessageId: string
  providerId: string
  providerVersion: string
  receipt: CandidateExtractionReceiptV1
  drafts: readonly Omit<ExtractedMemoryDraftV1, 'sourceMessageId'>[]
}

interface TrustedMemoryRequest {
  /** Host-constructed facts; never accept these values from model tool arguments. */
  context: MemoryAccessContextV1
}

/** Input for proposing a memory without activating it. */
export interface MemoryCandidateProposal extends TrustedMemoryRequest {
  sourceMessageId: string
  content: string
  visibility: MemoryVisibility
  memoryKind: MemoryKind
  recordedAt?: string
  validFrom?: string
  validTo?: string
}

/** Input for resolving one pending candidate. */
export interface MemoryCandidateDecision extends TrustedMemoryRequest {
  candidateId: string
  sourceMessageId: string
  resolution?:
    | { kind: 'keep-both' }
    | { kind: 'supersede'; memoryId: string }
}

/** Request an explainable conflict view for one pending candidate. */
export interface MemoryCandidateAssessment extends TrustedMemoryRequest {
  candidateId: string
}

/** Query over the candidate review queue in one exact Owner/scope. */
export interface MemoryCandidateList extends TrustedMemoryRequest {
  includeResolved?: boolean
  limit?: number
}

/** Owner-authored complete replacement draft for candidate edit or merge. */
export interface MemoryCandidateRevision extends TrustedMemoryRequest {
  candidateIds: readonly string[]
  sourceMessageId: string
  content: string
  visibility: MemoryVisibility
  memoryKind: MemoryKind
  recordedAt?: string
  validFrom?: string
  validTo?: string
}

/** Payload-free audit row derived from immutable candidate lineage. */
export interface MemoryGovernanceAuditEntryV1 {
  schemaVersion: 1
  action: 'candidate-edited' | 'candidates-merged'
  sourceCandidateIds: readonly string[]
  resultCandidateId: string
  createdAt: string
  sourceMessageId: string
}

export interface MemoryGovernanceAuditList extends TrustedMemoryRequest {
  limit?: number
}

export interface MemoryManagementQueryV1 extends TrustedMemoryRequest {
  query?: string
  memoryKind?: MemoryKind
  visibility?: MemoryVisibility
  recordStatus?: 'active' | 'inactive' | 'all'
  candidateStatus?: MemoryCandidate['status'] | 'all'
  limit?: number
}

export interface MemoryManagementSnapshotV1 {
  schemaVersion: 1
  records: MemoryRecord[]
  candidates: MemoryCandidate[]
  audit: MemoryGovernanceAuditEntryV1[]
}

export interface MemorySourceViewRequestV1 extends TrustedMemoryRequest {
  entity: 'record' | 'candidate'
  id: string
}

/** Payload-free provenance view for the local Owner management UI. */
export interface MemorySourceViewV1 {
  schemaVersion: 1
  entity: 'record' | 'candidate'
  id: string
  observation: {
    id: string
    sourceKind: string
    sourceId: string
    observedAt: string
  }
  sourceCandidateId?: string
  sourceCandidateIds?: readonly string[]
  supersedesMemoryId?: string
  sourceMemoryIds?: readonly string[]
}

export interface MemoryBatchDecisionV1 {
  candidateId: string
  action: 'approve' | 'reject'
  resolution?: MemoryCandidateDecision['resolution']
}

export interface MemoryBatchGovernanceRequestV1 extends TrustedMemoryRequest {
  requestId: string
  decisions: readonly MemoryBatchDecisionV1[]
}

export interface MemoryBatchGovernanceResultV1 {
  schemaVersion: 1
  results: Array<{
    candidateId: string
    status: 'succeeded' | 'failed'
    code?: string
  }>
}

/** Input for retiring one memory without deleting its audit history. */
export interface MemoryForget extends TrustedMemoryRequest {
  memoryId: string
  sourceMessageId: string
}

/** Input for replacing one active memory with a corrected value. */
export interface MemoryReplace extends TrustedMemoryRequest {
  memoryId: string
  sourceMessageId: string
  content: string
  memoryKind?: MemoryKind
  recordedAt?: string
  validFrom?: string
  validTo?: string
}

/** Trusted import input produced by an explicit migration adapter. */
export interface ConfirmedMemoryImport extends TrustedMemoryRequest {
  sourceMessageId: string
  content: string
  createdAt: string
  visibility: MemoryVisibility
  memoryKind: MemoryKind
  validFrom?: string
  validTo?: string
}

/** Whether a confirmed import appended a record or matched an earlier source. */
export interface ConfirmedMemoryImportResult {
  memory: MemoryRecord
  imported: boolean
}

/** Query over the current archive view in one exact Owner/scope. */
export interface MemoryList extends TrustedMemoryRequest {
  includeInactive?: boolean
  limit?: number
}

/** Input message that may carry an explicit remember request. */
export interface ExplicitMemoryObservation extends TrustedMemoryRequest {
  sourceMessageId: string
  text: string
  memoryKind: MemoryKind
}

/** Query over confirmed memories in one exact Owner/scope. */
export interface MemoryRecall extends TrustedMemoryRequest {
  query: string
  limit?: number
  at?: string
}

export interface MemoryRetrievalRequestV1 extends MemoryRecall {
  maxCharacters?: number
}

/** Side-effect-free lifecycle proposal input under a host-constructed governance context. */
export interface MemoryLifecyclePlanRequestV1 extends TrustedMemoryRequest {
  action:
    | {
        kind: 'consolidate'
        sourceMemoryIds: readonly string[]
        content: string
      }
    | {
        kind: 'decay'
        coldAfterDays: number
        minimumRankMultiplier: number
      }
    | {
        kind: 'archive' | 'restore'
        memoryIds: readonly string[]
      }
}

/** Immutable confirmation object; callers must not edit and re-submit its payload. */
export interface MemoryLifecyclePlanV1 {
  schemaVersion: 1
  id: string
  createdAt: string
  action:
    | {
        kind: 'consolidate'
        sourceMemoryIds: readonly string[]
        content: string
        visibility: MemoryVisibility
      }
    | {
        kind: 'decay'
        changes: ReadonlyArray<{
          memoryId: string
          toTier: 'cold'
          rankMultiplier: number
        }>
      }
    | {
        kind: 'archive' | 'restore'
        memoryIds: readonly string[]
      }
}

/** Apply one in-process plan only after explicit Owner confirmation. */
export interface MemoryLifecycleApplyRequestV1 extends TrustedMemoryRequest {
  planId: string
  ownerConfirmed: boolean
  sourceMessageId: string
}

/** Archive result plus payload-free status for disposable derived views. */
export interface MemoryLifecycleApplyResultV1 {
  schemaVersion: 1
  action: MemoryLifecyclePlanV1['action']['kind']
  affectedMemoryIds: readonly string[]
  createdMemory?: MemoryRecord
  derivedViews?: readonly DerivedMemoryViewInvalidationReceiptV1[]
}

export interface MemoryRecallItemV1 {
  memory: MemoryRecord
  score: number
  reasons: Array<{
    providerId: string
    providerVersion: string
    reason: string
    score: number
  }>
}

/** Exact governed receipt used to build one model-visible memory projection. */
export interface MemoryRecallSnapshotV1 {
  schemaVersion: 1
  query: string
  createdAt: string
  items: MemoryRecallItemV1[]
  shadowComparisons?: Array<{
    providerId: string
    providerVersion: string
    capability: 'page-index' | 'graph-relations'
    status: 'completed' | 'failed' | 'timed-out'
    latencyMs: number
    overlapAtK: number
    returnedMemoryIds: string[]
  }>
}

/** Small interface hiding parsing, scoped governance, ranking, and JSONL durability. */
export interface CompanionMemoryArchive {
  inspection(): ArchiveInspection
  dispose(): Promise<void>
  observeExplicit(input: ExplicitMemoryObservation): Promise<MemoryRecord | undefined>
  recall(input: MemoryRecall): MemoryRecord[]
  retrieve(input: MemoryRetrievalRequestV1): Promise<MemoryRecallSnapshotV1>
  list(input: MemoryList): MemoryRecord[]
  forget(input: MemoryForget): Promise<MemoryRecord>
  replace(input: MemoryReplace): Promise<MemoryRecord>
  importConfirmed(input: ConfirmedMemoryImport): Promise<ConfirmedMemoryImportResult>
  propose(input: MemoryCandidateProposal): Promise<MemoryCandidate>
  proposeExtracted(input: ExtractedMemoryCandidateBatch): Promise<MemoryCandidate[]>
  listCandidates(input: MemoryCandidateList): MemoryCandidate[]
  assessCandidate(input: MemoryCandidateAssessment): MemoryConflictAssessmentV1
  editCandidate(input: MemoryCandidateRevision): Promise<MemoryCandidate>
  mergeCandidates(input: MemoryCandidateRevision): Promise<MemoryCandidate>
  listGovernanceAudit(input: MemoryGovernanceAuditList): MemoryGovernanceAuditEntryV1[]
  manage(input: MemoryManagementQueryV1): MemoryManagementSnapshotV1
  sourceView(input: MemorySourceViewRequestV1): MemorySourceViewV1
  batchDecide(input: MemoryBatchGovernanceRequestV1): Promise<MemoryBatchGovernanceResultV1>
  approveCandidate(input: MemoryCandidateDecision): Promise<MemoryRecord>
  rejectCandidate(input: MemoryCandidateDecision): Promise<MemoryCandidate>
  planLifecycle(input: MemoryLifecyclePlanRequestV1): MemoryLifecyclePlanV1
  applyLifecycle(input: MemoryLifecycleApplyRequestV1): Promise<MemoryLifecycleApplyResultV1>
}

/** Context-free facade exposed only to the authenticated loopback settings transport. */
export interface MemoryGovernanceService {
  listCandidates(input?: Omit<MemoryCandidateList, 'context'>): MemoryCandidate[]
  assessCandidate(input: Omit<MemoryCandidateAssessment, 'context'>): MemoryConflictAssessmentV1
  editCandidate(input: Omit<MemoryCandidateRevision, 'context'>): Promise<MemoryCandidate>
  mergeCandidates(input: Omit<MemoryCandidateRevision, 'context'>): Promise<MemoryCandidate>
  listGovernanceAudit(input?: Omit<MemoryGovernanceAuditList, 'context'>): MemoryGovernanceAuditEntryV1[]
  manage(input?: Omit<MemoryManagementQueryV1, 'context'>): MemoryManagementSnapshotV1
  sourceView(input: Omit<MemorySourceViewRequestV1, 'context'>): MemorySourceViewV1
  batchDecide(input: Omit<MemoryBatchGovernanceRequestV1, 'context'>): Promise<MemoryBatchGovernanceResultV1>
  approveCandidate(input: Omit<MemoryCandidateDecision, 'context'>): Promise<MemoryRecord>
  rejectCandidate(input: Omit<MemoryCandidateDecision, 'context'>): Promise<MemoryCandidate>
}
