/** Session-bound Owner-facing Memory governance page. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  createMemorySettingsClient,
  MemorySettingsClientError,
  type MemoryAssessmentRpcSnapshotV1,
  type MemoryApprovalSettingsRpcSnapshotV1,
  type MemoryBatchRpcSnapshotV1,
  type MemoryManagementRpcSnapshotV1,
  type MemorySettingsRpcCallerV1,
  type MemorySpaceSetupRpcSnapshotV1,
  type MemorySpaceSharingSettingsRpcSnapshotV1,
  type MemorySourceRpcSnapshotV1,
  type MemoryTurnSummarySettingsRpcSnapshotV1,
} from '@mistymoon/dsh-memory/settings-client'
import type {
  MemoryCandidate,
  MemoryRelationshipSelectionV1,
  MemoryVisibility,
} from '@mistymoon/dsh-memory/contracts'
import type { MemoryKind } from '@mistymoon/dsh-memory/domain'
import type {
  InterSpaceModeV1,
  SpaceFederationV1,
  SpaceShareGrantV1,
} from '@mistymoon/dsh-memory/space-sharing'
import type { MemorySettingsLocaleKey } from './locales.js'

/** Minimal Session-list projection supplied by DSH's global slot standard props. */
export interface MemorySettingsSessionListV1 {
  readonly current: string | undefined
}

/** Public props for the dsh-Mmem Settings tab. */
export interface DshMemorySettingsTabProps {
  readonly rpc: MemorySettingsRpcCallerV1
  readonly useSessions: <Selected>(
    selector: (snapshot: MemorySettingsSessionListV1) => Selected,
  ) => Selected
  readonly t: (key: MemorySettingsLocaleKey) => string
}

interface MemoryFilterStateV1 {
  query: string
  memoryKind: MemoryKind | ''
  visibility: MemoryVisibility | ''
  candidateStatus: MemoryCandidate['status'] | 'all'
}

interface CandidateEditDraftV1 {
  candidateId: string
  content: string
  memoryKind: MemoryKind
  visibility: MemoryVisibility
}

interface CandidateMergeDraftV1 {
  candidateIds: string[]
  content: string
  memoryKind: MemoryKind
  visibility: MemoryVisibility
}

interface ApprovalPolicyDraftV1 {
  mode: 'manual' | 'scheduled-auto'
  timeZone: string
  localTime: string
}

interface TurnSummaryPolicyDraftV1 {
  mode: 'local-deterministic' | 'dsh-model'
  provider: string
  model: string
}

interface SharingPolicyDraftV1 {
  mode: InterSpaceModeV1
  grants: SpaceShareGrantV1[]
  federations: SpaceFederationV1[]
}

interface GrantDraftV1 {
  sourceSpaceId: string
  targetSpaceId: string
  memoryKinds: MemoryKind[]
  visibilities: MemoryVisibility[]
}

interface FederationDraftV1 {
  name: string
  spaceIds: string[]
}

interface WorkspaceBindingDraftV1 {
  spaceId: string
  access: 'read' | 'read-write'
  defaultWrite: boolean
}

const MEMORY_KINDS: readonly MemoryKind[] = [
  'preference',
  'biographical',
  'boundary',
  'commitment',
  'relationship',
  'episode',
  'state',
  'summary',
]

const CANDIDATE_STATUSES: readonly MemoryCandidate['status'][] = [
  'pending',
  'approved',
  'rejected',
  'superseded',
  'expired',
]

function memoryKindLabel(kind: MemoryKind, t: DshMemorySettingsTabProps['t']): string {
  const keys: Record<MemoryKind, MemorySettingsLocaleKey> = {
    preference: 'kindPreference',
    biographical: 'kindBiographical',
    boundary: 'kindBoundary',
    commitment: 'kindCommitment',
    relationship: 'kindRelationship',
    episode: 'kindEpisode',
    state: 'kindState',
    summary: 'kindSummary',
  }
  return t(keys[kind])
}

function visibilityLabel(visibility: MemoryVisibility, t: DshMemorySettingsTabProps['t']): string {
  return t(visibility === 'confidential' ? 'visibilityConfidential' : 'visibilityPersonal')
}

function candidateStatusLabel(
  status: MemoryCandidate['status'],
  t: DshMemorySettingsTabProps['t'],
): string {
  const keys: Record<MemoryCandidate['status'], MemorySettingsLocaleKey> = {
    pending: 'statusPending',
    approved: 'statusApproved',
    rejected: 'statusRejected',
    superseded: 'statusSuperseded',
    expired: 'statusExpired',
  }
  return t(keys[status])
}

function recordStatusLabel(
  status: 'confirmed' | 'forgotten' | 'superseded',
  t: DshMemorySettingsTabProps['t'],
): string {
  if (status === 'confirmed') return t('statusConfirmed')
  if (status === 'forgotten') return t('statusForgotten')
  return t('statusSuperseded')
}

function accessLabel(access: WorkspaceBindingDraftV1['access'], t: DshMemorySettingsTabProps['t']): string {
  return t(access === 'read-write' ? 'accessReadWrite' : 'accessRead')
}

function assessmentLabel(
  relation: 'duplicate' | 'related' | 'conflict',
  t: DshMemorySettingsTabProps['t'],
): string {
  if (relation === 'duplicate') return t('assessmentDuplicate')
  if (relation === 'conflict') return t('assessmentConflict')
  return t('assessmentRelated')
}

function assessmentReasonLabel(
  reason: 'exact-normalized-match' | 'same-kind-near-match' | 'lexical-overlap',
  t: DshMemorySettingsTabProps['t'],
): string {
  if (reason === 'exact-normalized-match') return t('reasonExactMatch')
  if (reason === 'same-kind-near-match') return t('reasonNearMatch')
  return t('reasonLexicalOverlap')
}

const DEFAULT_FILTERS: MemoryFilterStateV1 = {
  query: '',
  memoryKind: '',
  visibility: '',
  candidateStatus: 'pending',
}

function SessionMemorySettingsTab({
  rpc,
  sessionId,
  t,
}: Pick<DshMemorySettingsTabProps, 'rpc' | 't'> & { sessionId: string }): ReactNode {
  const client = useMemo(() => createMemorySettingsClient({ rpc, sessionId }), [rpc, sessionId])
  const [snapshot, setSnapshot] = useState<MemoryManagementRpcSnapshotV1>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [conflict, setConflict] = useState<MemoryAssessmentRpcSnapshotV1['assessment']>()
  const [sourceView, setSourceView] = useState<MemorySourceRpcSnapshotV1['source']>()
  const [editDraft, setEditDraft] = useState<CandidateEditDraftV1>()
  const [mergeSelection, setMergeSelection] = useState<string[]>([])
  const [relationshipAnalysis, setRelationshipAnalysis] = useState<string[]>([])
  const [mergeDraft, setMergeDraft] = useState<CandidateMergeDraftV1>()
  const [batchResult, setBatchResult] = useState<MemoryBatchRpcSnapshotV1['batch']>()
  const [approvalSettings, setApprovalSettings] = useState<MemoryApprovalSettingsRpcSnapshotV1>()
  const [approvalDraft, setApprovalDraft] = useState<ApprovalPolicyDraftV1>()
  const [turnSummarySettings, setTurnSummarySettings] = useState<MemoryTurnSummarySettingsRpcSnapshotV1>()
  const [turnSummaryDraft, setTurnSummaryDraft] = useState<TurnSummaryPolicyDraftV1>()
  const [sharingSettings, setSharingSettings] = useState<MemorySpaceSharingSettingsRpcSnapshotV1>()
  const [sharingDraft, setSharingDraft] = useState<SharingPolicyDraftV1>()
  const [grantDraft, setGrantDraft] = useState<GrantDraftV1>()
  const [federationDraft, setFederationDraft] = useState<FederationDraftV1>({ name: '', spaceIds: [] })
  const [spaceSetup, setSpaceSetup] = useState<MemorySpaceSetupRpcSnapshotV1>()
  const [spaceName, setSpaceName] = useState('')
  const [bindingDraft, setBindingDraft] = useState<WorkspaceBindingDraftV1>()
  const [filters, setFilters] = useState<MemoryFilterStateV1>(DEFAULT_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState<MemoryFilterStateV1>(DEFAULT_FILTERS)

  useEffect(() => {
    setApprovalSettings(undefined)
    setApprovalDraft(undefined)
    setTurnSummarySettings(undefined)
    setTurnSummaryDraft(undefined)
    setSharingSettings(undefined)
    setSharingDraft(undefined)
    setGrantDraft(undefined)
    setFederationDraft({ name: '', spaceIds: [] })
    setSpaceSetup(undefined)
    setSpaceName('')
    setBindingDraft(undefined)
  }, [client])

  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(undefined)
    setSourceView(undefined)
    setEditDraft(undefined)
    setMergeSelection([])
    setMergeDraft(undefined)
    setFailed(false)
    void client.search({
      ...(appliedFilters.query.trim() === '' ? {} : { query: appliedFilters.query.trim() }),
      ...(appliedFilters.memoryKind === '' ? {} : { memoryKind: appliedFilters.memoryKind }),
      ...(appliedFilters.visibility === '' ? {} : { visibility: appliedFilters.visibility }),
      recordStatus: 'all',
      candidateStatus: appliedFilters.candidateStatus,
      limit: 200,
    }, controller.signal).then(
      value => { setSnapshot(value) },
      error => {
        if (controller.signal.aborted) return
        if (error instanceof MemorySettingsClientError && error.code === 'active-space-unavailable') {
          setBusy(true)
          void client.inspectSpaces(controller.signal).then(
            result => {
              setBusy(false)
              setSpaceSetup(result)
              setBindingDraft(selectUnboundSpace(result))
            },
            () => {
              if (!controller.signal.aborted) {
                setBusy(false)
                setFailed(true)
              }
            },
          )
          return
        }
        setFailed(true)
      },
    )
    return () => { controller.abort() }
  }, [appliedFilters, client, refresh])

  const semanticSelections = (
    assessment: MemoryAssessmentRpcSnapshotV1['assessment'],
    excludedTargetId?: string,
  ): MemoryRelationshipSelectionV1[] => assessment.relationships.flatMap(relationship => {
    if (relationship.relation === 'duplicate' || relationship.memoryId === excludedTargetId) return []
    return [{
      targetMemoryId: relationship.memoryId,
      relation: relationship.relation === 'conflict' ? 'contradicts' : 'related-to',
    }]
  })

  const approveCandidate = (candidateId: string): void => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    void client.assessCandidate(candidateId).then(async result => {
      const blocking = result.assessment.relationships.filter(
        relationship => relationship.relation === 'duplicate' || relationship.relation === 'conflict',
      )
      if (blocking.length > 0) {
        setConflict({ ...result.assessment, relationships: blocking })
        setBusy(false)
        return
      }
      await client.approveCandidate(
        candidateId,
        undefined,
        undefined,
        relationshipAnalysis.includes(candidateId) ? semanticSelections(result.assessment) : undefined,
      )
      setBusy(false)
      setRefresh(value => value + 1)
    }).catch(() => {
      setBusy(false)
      setFailed(true)
    })
  }

  const resolveConflict = (
    resolution: { kind: 'keep-both' } | { kind: 'supersede'; memoryId: string },
  ): void => {
    if (busy || conflict === undefined) return
    setBusy(true)
    setFailed(false)
    void client.approveCandidate(
      conflict.candidateId,
      resolution,
      undefined,
      relationshipAnalysis.includes(conflict.candidateId)
        ? semanticSelections(conflict, resolution.kind === 'supersede' ? resolution.memoryId : undefined)
        : undefined,
    ).then(
      () => {
        setBusy(false)
        setConflict(undefined)
        setRefresh(value => value + 1)
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const rejectCandidate = (candidateId: string): void => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    void client.rejectCandidate(candidateId).then(
      () => {
        setBusy(false)
        setRefresh(value => value + 1)
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const showSource = (entity: 'record' | 'candidate', id: string): void => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    void client.source(entity, id).then(
      result => {
        setBusy(false)
        setSourceView(result.source)
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const saveEdit = (): void => {
    if (busy || editDraft === undefined) return
    setBusy(true)
    setFailed(false)
    void client.editCandidate(editDraft).then(
      () => {
        setBusy(false)
        setEditDraft(undefined)
        setRefresh(value => value + 1)
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const saveMerge = (): void => {
    if (busy || mergeDraft === undefined) return
    setBusy(true)
    setFailed(false)
    void client.mergeCandidates(mergeDraft).then(
      () => {
        setBusy(false)
        setMergeDraft(undefined)
        setMergeSelection([])
        setRefresh(value => value + 1)
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const decideBatch = (action: 'approve' | 'reject'): void => {
    if (busy || mergeSelection.length === 0) return
    setBusy(true)
    setFailed(false)
    setBatchResult(undefined)
    void client.batchDecide(mergeSelection.map(candidateId => ({ candidateId, action }))).then(
      result => {
        setBusy(false)
        setBatchResult(result.batch)
        setMergeSelection([])
        setRefresh(value => value + 1)
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const openApprovalSettings = (): void => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    void client.getApprovalPolicy().then(
      result => {
        setBusy(false)
        setApprovalSettings(result)
        setApprovalDraft({
          mode: result.approvalPolicy.mode,
          timeZone: result.approvalPolicy.mode === 'scheduled-auto'
            ? result.approvalPolicy.timeZone
            : Intl.DateTimeFormat().resolvedOptions().timeZone,
          localTime: result.approvalPolicy.mode === 'scheduled-auto'
            ? result.approvalPolicy.localTime
            : '03:00',
        })
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const saveApprovalSettings = (): void => {
    if (busy || approvalSettings === undefined || approvalDraft === undefined) return
    setBusy(true)
    setFailed(false)
    const update = approvalDraft.mode === 'manual'
      ? { expectedRevision: approvalSettings.approvalPolicy.revision, mode: 'manual' as const }
      : {
          expectedRevision: approvalSettings.approvalPolicy.revision,
          mode: 'scheduled-auto' as const,
          timeZone: approvalDraft.timeZone,
          localTime: approvalDraft.localTime,
        }
    void client.updateApprovalPolicy(update).then(
      result => {
        setBusy(false)
        setApprovalSettings(result)
        setApprovalDraft(value => value === undefined ? value : { ...value, mode: result.approvalPolicy.mode })
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const openTurnSummarySettings = (): void => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    void client.getTurnSummaryPolicy().then(
      result => {
        setBusy(false)
        setTurnSummarySettings(result)
        setTurnSummaryDraft({
          mode: result.turnSummaryPolicy.mode,
          provider: result.turnSummaryPolicy.mode === 'dsh-model' ? result.turnSummaryPolicy.provider ?? '' : '',
          model: result.turnSummaryPolicy.mode === 'dsh-model' ? result.turnSummaryPolicy.model ?? '' : '',
        })
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const saveTurnSummarySettings = (): void => {
    if (busy || turnSummarySettings === undefined || turnSummaryDraft === undefined) return
    setBusy(true)
    setFailed(false)
    const provider = turnSummaryDraft.provider.trim()
    const model = turnSummaryDraft.model.trim()
    const update = turnSummaryDraft.mode === 'local-deterministic'
      ? {
          expectedRevision: turnSummarySettings.turnSummaryPolicy.revision,
          mode: 'local-deterministic' as const,
        }
      : {
          expectedRevision: turnSummarySettings.turnSummaryPolicy.revision,
          mode: 'dsh-model' as const,
          ...(provider === '' ? {} : { provider }),
          ...(model === '' ? {} : { model }),
        }
    void client.updateTurnSummaryPolicy(update).then(
      result => {
        setBusy(false)
        setTurnSummarySettings(result)
        setTurnSummaryDraft(value => value === undefined ? value : {
          ...value,
          mode: result.turnSummaryPolicy.mode,
        })
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const openSharingSettings = (): void => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    void client.getSharingPolicy().then(
      result => {
        const first = result.spaces[0]?.id ?? ''
        const target = result.spaces.find(space => space.id === result.activeSpace.spaceId)?.id
          ?? result.spaces.find(space => space.id !== first)?.id
          ?? first
        setBusy(false)
        setSharingSettings(result)
        setSharingDraft({
          mode: result.sharingPolicy.mode,
          grants: result.sharingPolicy.grants.map(grant => ({
            ...grant,
            memoryKinds: [...grant.memoryKinds],
            visibilities: [...grant.visibilities],
          })),
          federations: result.sharingPolicy.federations.map(federation => ({
            ...federation,
            spaceIds: [...federation.spaceIds],
          })),
        })
        setGrantDraft({
          sourceSpaceId: result.spaces.find(space => space.id !== target)?.id ?? first,
          targetSpaceId: target,
          memoryKinds: ['summary'],
          visibilities: ['personal'],
        })
        setFederationDraft({ name: '', spaceIds: [] })
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const addGrant = (): void => {
    if (sharingDraft === undefined || grantDraft === undefined
      || grantDraft.sourceSpaceId === '' || grantDraft.targetSpaceId === ''
      || grantDraft.sourceSpaceId === grantDraft.targetSpaceId
      || grantDraft.memoryKinds.length === 0 || grantDraft.visibilities.length === 0
      || sharingDraft.grants.some(grant => grant.sourceSpaceId === grantDraft.sourceSpaceId
        && grant.targetSpaceId === grantDraft.targetSpaceId)) return
    setSharingDraft(value => value === undefined ? value : {
      ...value,
      grants: [...value.grants, {
        id: `grant-${crypto.randomUUID()}`,
        sourceSpaceId: grantDraft.sourceSpaceId,
        targetSpaceId: grantDraft.targetSpaceId,
        memoryKinds: [...grantDraft.memoryKinds],
        visibilities: [...grantDraft.visibilities],
      }],
    })
  }

  const addFederation = (): void => {
    if (sharingDraft === undefined || federationDraft.name.trim() === ''
      || federationDraft.spaceIds.length < 2
      || sharingDraft.federations.some(federation => federation.spaceIds
        .some(spaceId => federationDraft.spaceIds.includes(spaceId)))) return
    setSharingDraft(value => value === undefined ? value : {
      ...value,
      federations: [...value.federations, {
        id: `federation-${crypto.randomUUID()}`,
        name: federationDraft.name.trim(),
        spaceIds: [...federationDraft.spaceIds],
      }],
    })
    setFederationDraft({ name: '', spaceIds: [] })
  }

  const saveSharingSettings = (): void => {
    if (busy || sharingSettings === undefined || sharingDraft === undefined) return
    setBusy(true)
    setFailed(false)
    void client.replaceSharingPolicy({
      expectedRevision: sharingSettings.sharingPolicy.revision,
      mode: sharingDraft.mode,
      grants: sharingDraft.grants,
      federations: sharingDraft.federations,
    }).then(
      result => {
        setBusy(false)
        setSharingSettings(result)
        setSharingDraft({
          mode: result.sharingPolicy.mode,
          grants: result.sharingPolicy.grants.map(grant => ({ ...grant, memoryKinds: [...grant.memoryKinds], visibilities: [...grant.visibilities] })),
          federations: result.sharingPolicy.federations.map(federation => ({ ...federation, spaceIds: [...federation.spaceIds] })),
        })
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const selectUnboundSpace = (result: MemorySpaceSetupRpcSnapshotV1): WorkspaceBindingDraftV1 | undefined => {
    const bound = new Set(result.bindings.map(binding => binding.spaceId))
    const spaceId = result.spaces.find(space => !bound.has(space.id))?.id
    if (spaceId === undefined) return undefined
    return {
      spaceId,
      access: 'read-write',
      defaultWrite: !result.bindings.some(binding => binding.defaultWrite),
    }
  }

  const openSpaceSetup = (): void => {
    if (busy) return
    setBusy(true)
    void client.inspectSpaces().then(
      result => {
        setBusy(false)
        setSpaceSetup(result)
        setBindingDraft(selectUnboundSpace(result))
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const createSpace = (): void => {
    if (busy || spaceName.trim() === '') return
    setBusy(true)
    void client.createSpace(spaceName.trim()).then(
      result => {
        setBusy(false)
        setSpaceSetup(result)
        setSpaceName('')
        setBindingDraft(selectUnboundSpace(result))
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const bindCurrentDshWorkspace = (): void => {
    if (busy || bindingDraft === undefined) return
    setBusy(true)
    void client.bindCurrentDshWorkspace(bindingDraft).then(
      result => {
        setBusy(false)
        setFailed(false)
        setSpaceSetup(result)
        setBindingDraft(selectUnboundSpace(result))
        setRefresh(value => value + 1)
      },
      () => {
        setBusy(false)
        setFailed(true)
      },
    )
  }

  const retryLoad = (): void => {
    if (busy) return
    setFailed(false)
    setRefresh(value => value + 1)
  }

  const spaceSetupPanel = spaceSetup === undefined ? null : <fieldset>
    <legend>{t('spaceSetup')}</legend>
    <form aria-label={t('createSpaceForm')} onSubmit={(event) => {
      event.preventDefault()
      createSpace()
    }}>
      <label>{t('spaceName')}
        <input
          type="text"
          aria-label={t('spaceName')}
          value={spaceName}
          onChange={event => { setSpaceName(event.target.value) }}
        />
      </label>
      <button type="submit" disabled={busy || spaceName.trim() === ''}>{t('createSpace')}</button>
    </form>
    {spaceSetup.spaces.length === 0 ? <p>{t('noSpaces')}</p> : <ul>
      {spaceSetup.spaces.map(space => <li key={space.id}>
        {space.name} · {space.id}
        {spaceSetup.bindings.some(binding => binding.spaceId === space.id) ? ` · ${t('boundToCurrentWorkspace')}` : ''}
      </li>)}
    </ul>}
    {bindingDraft === undefined ? null : <form aria-label={t('bindSpaceForm')} onSubmit={(event) => {
      event.preventDefault()
      bindCurrentDshWorkspace()
    }}>
      <label>{t('spaceToBind')}
        <select
          aria-label={t('spaceToBind')}
          value={bindingDraft.spaceId}
          onChange={event => {
            setBindingDraft(value => value === undefined ? value : { ...value, spaceId: event.target.value })
          }}
        >
          {spaceSetup.spaces
            .filter(space => !spaceSetup.bindings.some(binding => binding.spaceId === space.id))
            .map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select>
      </label>
      <label>{t('bindingAccess')}
        <select
          aria-label={t('bindingAccess')}
          value={bindingDraft.access}
          onChange={event => {
            const access = event.target.value as WorkspaceBindingDraftV1['access']
            setBindingDraft(value => value === undefined ? value : {
              ...value,
              access,
              defaultWrite: access === 'read-write' && value.defaultWrite,
            })
          }}
        >
          <option value="read">{t('accessRead')}</option>
          <option value="read-write">{t('accessReadWrite')}</option>
        </select>
      </label>
      <label className="dsh-mmem-switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={t('defaultWriteSpace')}
          checked={bindingDraft.defaultWrite}
          disabled={bindingDraft.access !== 'read-write'
            || spaceSetup.bindings.some(binding => binding.defaultWrite)}
          onChange={event => {
            setBindingDraft(value => value === undefined ? value : { ...value, defaultWrite: event.target.checked })
          }}
        />{t('defaultWriteSpace')}
      </label>
      <button type="submit" disabled={busy}>{t('bindCurrentWorkspace')}</button>
    </form>}
    <button type="button" disabled={busy} onClick={() => {
      setSpaceSetup(undefined)
      setBindingDraft(undefined)
    }}>{t('cancel')}</button>
  </fieldset>

  if (snapshot === undefined && spaceSetup !== undefined) return <section className="dsh-mmem-settings">
    <header><h2>{t('firstUseTitle')}</h2><p>{t('firstUseDescription')}</p></header>
    {spaceSetupPanel}
  </section>
  if (failed && snapshot === undefined) return <section className="dsh-mmem-settings">
    <p role="alert">{t('loadError')}</p>
    <button type="button" disabled={busy} onClick={retryLoad}>{t('retry')}</button>
    <button type="button" disabled={busy} onClick={openSpaceSetup}>{t('configureSpaces')}</button>
    {spaceSetupPanel}
  </section>
  if (snapshot === undefined) return <p role="status">{t('loading')}</p>
  return <section className="dsh-mmem-settings">
    {failed ? <div>
      <p role="alert">{t('loadError')}</p>
      <button type="button" disabled={busy} onClick={retryLoad}>{t('retry')}</button>
    </div> : null}
    <header>
      <h2>{t('settingsTitle')}</h2>
      <p>{t('settingsDescription')}</p>
    </header>
    <h3>{t('activeSpace')}</h3>
    <p>{snapshot.activeSpace.spaceId} · {accessLabel(snapshot.activeSpace.access, t)}</p>
    <button type="button" disabled={busy} onClick={openApprovalSettings}>
      {t('configureApproval')}
    </button>
    <button type="button" disabled={busy} onClick={openTurnSummarySettings}>
      {t('configureTurnSummary')}
    </button>
    <button type="button" disabled={busy} onClick={openSharingSettings}>
      {t('configureSharing')}
    </button>
    <button type="button" disabled={busy} onClick={openSpaceSetup}>
      {t('configureSpaces')}
    </button>
    <form onSubmit={(event) => {
      event.preventDefault()
      setAppliedFilters({ ...filters })
    }}>
      <strong>{t('filters')}</strong>
      <label>{t('searchQuery')}<input
          type="search"
          aria-label={t('searchQuery')}
          value={filters.query}
          onChange={event => { setFilters(value => ({ ...value, query: event.target.value })) }}
        /></label>
      <label>{t('memoryKind')}<select
          aria-label={t('memoryKind')}
          value={filters.memoryKind}
          onChange={event => {
            setFilters(value => ({ ...value, memoryKind: event.target.value as MemoryFilterStateV1['memoryKind'] }))
          }}
        >
          <option value="">{t('allKinds')}</option>
          {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{memoryKindLabel(kind, t)}</option>)}
        </select></label>
      <label>{t('visibility')}<select
          aria-label={t('visibility')}
          value={filters.visibility}
          onChange={event => {
            setFilters(value => ({ ...value, visibility: event.target.value as MemoryFilterStateV1['visibility'] }))
          }}
        >
          <option value="">{t('allVisibilities')}</option>
          <option value="personal">{t('visibilityPersonal')}</option>
          <option value="confidential">{t('visibilityConfidential')}</option>
        </select></label>
      <label>{t('candidateStatus')}<select
          aria-label={t('candidateStatus')}
          value={filters.candidateStatus}
          onChange={event => {
            setFilters(value => ({
              ...value,
              candidateStatus: event.target.value as MemoryFilterStateV1['candidateStatus'],
            }))
          }}
        >
          <option value="all">{t('allStatuses')}</option>
          {CANDIDATE_STATUSES.map(status => <option key={status} value={status}>{candidateStatusLabel(status, t)}</option>)}
        </select></label>
      <button type="submit">{t('applyFilters')}</button>
    </form>
    {approvalSettings === undefined || approvalDraft === undefined ? null : <fieldset>
      <legend>{t('approvalSettings')}</legend>
      <small>{t('policyRevision')}: {approvalSettings.approvalPolicy.revision}</small>
      <p role="note">{t('approvalDefaultWarning')}</p>
      <form
        aria-label={t('approvalForm')}
        onSubmit={(event) => {
          event.preventDefault()
          saveApprovalSettings()
        }}
      >
        <label>{t('approvalMode')}<select
          aria-label={t('approvalMode')}
          value={approvalDraft.mode}
          onChange={event => {
            setApprovalDraft(value => value === undefined
              ? value
              : { ...value, mode: event.target.value as ApprovalPolicyDraftV1['mode'] })
          }}
        >
          <option value="manual">{t('approvalManual')}</option>
          <option value="scheduled-auto">{t('approvalScheduled')}</option>
        </select></label>
        {approvalDraft.mode === 'scheduled-auto' ? <>
          <label>{t('approvalTimeZone')}<input
            type="text"
            aria-label={t('approvalTimeZone')}
            value={approvalDraft.timeZone}
            onChange={event => {
              setApprovalDraft(value => value === undefined ? value : { ...value, timeZone: event.target.value })
            }}
          /></label>
          <label>{t('approvalLocalTime')}<input
            type="time"
            aria-label={t('approvalLocalTime')}
            value={approvalDraft.localTime}
            onChange={event => {
              setApprovalDraft(value => value === undefined ? value : { ...value, localTime: event.target.value })
            }}
          /></label>
        </> : null}
        <button
          type="submit"
          disabled={busy || snapshot.activeSpace.access !== 'read-write'
            || (approvalDraft.mode === 'scheduled-auto'
              && (approvalDraft.timeZone.trim() === '' || approvalDraft.localTime === ''))}
        >{t('saveApproval')}</button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setApprovalSettings(undefined)
            setApprovalDraft(undefined)
          }}
        >{t('cancel')}</button>
      </form>
    </fieldset>}
    {turnSummarySettings === undefined || turnSummaryDraft === undefined ? null : <fieldset>
      <legend>{t('turnSummarySettings')}</legend>
      <small>{t('policyRevision')}: {turnSummarySettings.turnSummaryPolicy.revision}</small>
      <p role="note">{t('turnSummaryPrivacyWarning')}</p>
      <form
        aria-label={t('turnSummaryForm')}
        onSubmit={(event) => {
          event.preventDefault()
          saveTurnSummarySettings()
        }}
      >
        <label>{t('turnSummaryMode')}<select
          aria-label={t('turnSummaryMode')}
          value={turnSummaryDraft.mode}
          onChange={event => {
            setTurnSummaryDraft(value => value === undefined ? value : {
              ...value,
              mode: event.target.value as TurnSummaryPolicyDraftV1['mode'],
            })
          }}
        >
          <option value="local-deterministic">{t('turnSummaryLocal')}</option>
          <option value="dsh-model">{t('turnSummaryModelCompression')}</option>
        </select></label>
        {turnSummaryDraft.mode === 'dsh-model' ? <>
          <label>{t('turnSummaryProvider')}<input
            type="text"
            aria-label={t('turnSummaryProvider')}
            value={turnSummaryDraft.provider}
            placeholder={t('turnSummaryRouteDefault')}
            onChange={event => {
              setTurnSummaryDraft(value => value === undefined ? value : { ...value, provider: event.target.value })
            }}
          /></label>
          <label>{t('turnSummaryModel')}<input
            type="text"
            aria-label={t('turnSummaryModel')}
            value={turnSummaryDraft.model}
            placeholder={t('turnSummaryRouteDefault')}
            onChange={event => {
              setTurnSummaryDraft(value => value === undefined ? value : { ...value, model: event.target.value })
            }}
          /></label>
        </> : null}
        <button type="submit" disabled={busy || snapshot.activeSpace.access !== 'read-write'}>
          {t('saveTurnSummary')}
        </button>
        <button type="button" disabled={busy} onClick={() => {
          setTurnSummarySettings(undefined)
          setTurnSummaryDraft(undefined)
        }}>{t('cancel')}</button>
      </form>
    </fieldset>}
    {sharingSettings === undefined || sharingDraft === undefined || grantDraft === undefined ? null : <fieldset>
      <legend>{t('sharingSettings')}</legend>
      <small>{t('policyRevision')}: {sharingSettings.sharingPolicy.revision}</small>
      <form
        aria-label={t('sharingForm')}
        onSubmit={(event) => {
          event.preventDefault()
          saveSharingSettings()
        }}
      >
        <select
          aria-label={t('sharingMode')}
          value={sharingDraft.mode}
          onChange={event => {
            setSharingDraft(value => value === undefined
              ? value
              : { ...value, mode: event.target.value as InterSpaceModeV1 })
          }}
        >
          <option value="isolated">{t('sharingIsolated')}</option>
          <option value="selective">{t('sharingSelective')}</option>
          <option value="federated">{t('sharingFederated')}</option>
        </select>
        {sharingDraft.mode === 'selective' ? <fieldset>
          <legend>{t('spaceShareGrants')}</legend>
          <select
            aria-label={t('sourceSpace')}
            value={grantDraft.sourceSpaceId}
            onChange={event => { setGrantDraft(value => value === undefined ? value : { ...value, sourceSpaceId: event.target.value }) }}
          >
            {sharingSettings.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
          <select
            aria-label={t('targetSpace')}
            value={grantDraft.targetSpaceId}
            onChange={event => { setGrantDraft(value => value === undefined ? value : { ...value, targetSpaceId: event.target.value }) }}
          >
            {sharingSettings.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
          {MEMORY_KINDS.map(kind => <label key={kind}>
            <input
              type="checkbox"
              aria-label={`${t('sharedMemoryKind')}: ${memoryKindLabel(kind, t)}`}
              checked={grantDraft.memoryKinds.includes(kind)}
              onChange={event => {
                setGrantDraft(value => value === undefined ? value : {
                  ...value,
                  memoryKinds: event.target.checked
                    ? [...value.memoryKinds, kind]
                    : value.memoryKinds.filter(item => item !== kind),
                })
              }}
            />{memoryKindLabel(kind, t)}
          </label>)}
          {(['personal', 'confidential'] as const).map(visibility => <label key={visibility}>
            <input
              type="checkbox"
              aria-label={`${t('sharedVisibility')}: ${visibilityLabel(visibility, t)}`}
              checked={grantDraft.visibilities.includes(visibility)}
              onChange={event => {
                setGrantDraft(value => value === undefined ? value : {
                  ...value,
                  visibilities: event.target.checked
                    ? [...value.visibilities, visibility]
                    : value.visibilities.filter(item => item !== visibility),
                })
              }}
            />{visibilityLabel(visibility, t)}
          </label>)}
          <button type="button" disabled={busy || sharingSettings.activeSpace.access !== 'read-write'} onClick={addGrant}>
            {t('addGrant')}
          </button>
          {sharingDraft.grants.map(grant => <p key={grant.id}>
            {grant.sourceSpaceId} → {grant.targetSpaceId}
            <button type="button" disabled={busy} onClick={() => {
              setSharingDraft(value => value === undefined ? value : {
                ...value,
                grants: value.grants.filter(item => item.id !== grant.id),
              })
            }}>{t('remove')}</button>
          </p>)}
        </fieldset> : null}
        {sharingDraft.mode === 'federated' ? <fieldset>
          <legend>{t('spaceFederations')}</legend>
          <input
            type="text"
            aria-label={t('federationName')}
            value={federationDraft.name}
            onChange={event => { setFederationDraft(value => ({ ...value, name: event.target.value })) }}
          />
          {sharingSettings.spaces.map(space => <label key={space.id}>
            <input
              type="checkbox"
              aria-label={`${t('federationMember')}: ${space.id}`}
              checked={federationDraft.spaceIds.includes(space.id)}
              onChange={event => {
                setFederationDraft(value => ({
                  ...value,
                  spaceIds: event.target.checked
                    ? [...value.spaceIds, space.id]
                    : value.spaceIds.filter(id => id !== space.id),
                }))
              }}
            />{space.name}
          </label>)}
          <button type="button" disabled={busy || sharingSettings.activeSpace.access !== 'read-write'} onClick={addFederation}>
            {t('addFederation')}
          </button>
          {sharingDraft.federations.map(federation => <p key={federation.id}>
            {federation.name}: {federation.spaceIds.join(', ')}
            <button type="button" disabled={busy} onClick={() => {
              setSharingDraft(value => value === undefined ? value : {
                ...value,
                federations: value.federations.filter(item => item.id !== federation.id),
              })
            }}>{t('remove')}</button>
          </p>)}
        </fieldset> : null}
        <button type="submit" disabled={busy || sharingSettings.activeSpace.access !== 'read-write'}>
          {t('saveSharing')}
        </button>
        <button type="button" disabled={busy} onClick={() => {
          setSharingSettings(undefined)
          setSharingDraft(undefined)
          setGrantDraft(undefined)
        }}>{t('cancel')}</button>
      </form>
    </fieldset>}
    {spaceSetupPanel}
    <fieldset>
      <legend>{t('records')}</legend>
      {snapshot.management.records.length === 0
        ? <p>{t('noRecords')}</p>
        : snapshot.management.records.map(record => <article key={record.id}>
            <p>{record.content}</p>
            <small>{memoryKindLabel(record.memoryKind, t)} · {visibilityLabel(record.visibility, t)} · {recordStatusLabel(record.status, t)}</small>
            <div>
              <button type="button" disabled={busy} onClick={() => { showSource('record', record.id) }}>
                {t('viewSource')}
              </button>
            </div>
          </article>)}
    </fieldset>
    <fieldset>
      <legend>{t('candidates')}</legend>
      {snapshot.management.candidates.length === 0
        ? <p>{t('noCandidates')}</p>
        : snapshot.management.candidates.map(candidate => <article key={candidate.id}>
            <p>{candidate.content}</p>
            <small>{memoryKindLabel(candidate.memoryKind, t)} · {visibilityLabel(candidate.visibility, t)} · {candidateStatusLabel(candidate.status, t)}</small>
            {candidate.status === 'pending' ? <>
              <small role="note">{t('provisionalWarning')}</small>
              <small>{t('candidateExpiresAt')}: {candidate.expiresAt}</small>
            </> : null}
            <div>
              <button type="button" disabled={busy} onClick={() => { showSource('candidate', candidate.id) }}>
                {t('viewSource')}
              </button>
              {candidate.status === 'pending' ? <>
              <label className="dsh-mmem-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t('analyzeRelationships')}
                  checked={relationshipAnalysis.includes(candidate.id)}
                  disabled={busy || snapshot.activeSpace.access !== 'read-write'}
                  onChange={event => {
                    setRelationshipAnalysis(value => event.target.checked
                      ? [...value, candidate.id]
                      : value.filter(id => id !== candidate.id))
                  }}
                />
                {t('analyzeRelationships')}
              </label>
              <small className="dsh-mmem-relationship-hint">{t('relationshipAnalysisHint')}</small>
              <label>
                <input
                  type="checkbox"
                  aria-label={`${t('selectForMerge')}: ${candidate.id}`}
                  checked={mergeSelection.includes(candidate.id)}
                  disabled={busy || snapshot.activeSpace.access !== 'read-write'}
                  onChange={event => {
                    setMergeSelection(value => event.target.checked
                      ? [...value, candidate.id]
                      : value.filter(id => id !== candidate.id))
                  }}
                />
                {t('selectForMerge')}
              </label>
              <button
                type="button"
                disabled={busy || snapshot.activeSpace.access !== 'read-write'}
                onClick={() => {
                  setMergeDraft(undefined)
                  setEditDraft({
                    candidateId: candidate.id,
                    content: candidate.content,
                    memoryKind: candidate.memoryKind,
                    visibility: candidate.visibility,
                  })
                }}
              >{t('edit')}</button>
              <button
                type="button"
                disabled={busy || snapshot.activeSpace.access !== 'read-write'}
                onClick={() => { approveCandidate(candidate.id) }}
              >{t('approve')}</button>
              <button
                type="button"
                disabled={busy || snapshot.activeSpace.access !== 'read-write'}
                onClick={() => { rejectCandidate(candidate.id) }}
              >{t('reject')}</button>
              </> : null}
            </div>
          </article>)}
      <button
        type="button"
        disabled={busy || snapshot.activeSpace.access !== 'read-write' || mergeSelection.length < 2}
        onClick={() => {
          const first = snapshot.management.candidates.find(candidate => candidate.id === mergeSelection[0])
          if (first === undefined) return
          setEditDraft(undefined)
          setMergeDraft({
            candidateIds: [...mergeSelection],
            content: '',
            memoryKind: first.memoryKind,
            visibility: first.visibility,
          })
        }}
      >{t('mergeSelected')}</button>
      <button
        type="button"
        disabled={busy || snapshot.activeSpace.access !== 'read-write' || mergeSelection.length === 0}
        onClick={() => { decideBatch('approve') }}
      >{t('batchApprove')}</button>
      <button
        type="button"
        disabled={busy || snapshot.activeSpace.access !== 'read-write' || mergeSelection.length === 0}
        onClick={() => { decideBatch('reject') }}
      >{t('batchReject')}</button>
    </fieldset>
    {editDraft === undefined ? null : <fieldset>
      <legend>{t('editCandidate')}</legend>
      <form
        aria-label={t('editForm')}
        onSubmit={(event) => {
          event.preventDefault()
          saveEdit()
        }}
      >
        <textarea
          aria-label={t('editContent')}
          value={editDraft.content}
          onChange={event => {
            setEditDraft(value => value === undefined ? value : { ...value, content: event.target.value })
          }}
        />
        <select
          aria-label={t('editMemoryKind')}
          value={editDraft.memoryKind}
          onChange={event => {
            setEditDraft(value => value === undefined
              ? value
              : { ...value, memoryKind: event.target.value as MemoryKind })
          }}
        >
          {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{memoryKindLabel(kind, t)}</option>)}
        </select>
        <select
          aria-label={t('editVisibility')}
          value={editDraft.visibility}
          onChange={event => {
            setEditDraft(value => value === undefined
              ? value
              : { ...value, visibility: event.target.value as MemoryVisibility })
          }}
        >
          <option value="personal">{t('visibilityPersonal')}</option>
          <option value="confidential">{t('visibilityConfidential')}</option>
        </select>
        <button type="submit" disabled={busy || editDraft.content.trim() === ''}>{t('saveEdit')}</button>
        <button type="button" disabled={busy} onClick={() => { setEditDraft(undefined) }}>{t('cancel')}</button>
      </form>
    </fieldset>}
    {mergeDraft === undefined ? null : <fieldset>
      <legend>{t('mergeCandidates')}</legend>
      <p>{mergeDraft.candidateIds.join(', ')}</p>
      <form
        aria-label={t('mergeForm')}
        onSubmit={(event) => {
          event.preventDefault()
          saveMerge()
        }}
      >
        <textarea
          aria-label={t('mergeContent')}
          value={mergeDraft.content}
          onChange={event => {
            setMergeDraft(value => value === undefined ? value : { ...value, content: event.target.value })
          }}
        />
        <select
          aria-label={t('mergeMemoryKind')}
          value={mergeDraft.memoryKind}
          onChange={event => {
            setMergeDraft(value => value === undefined
              ? value
              : { ...value, memoryKind: event.target.value as MemoryKind })
          }}
        >
          {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{memoryKindLabel(kind, t)}</option>)}
        </select>
        <select
          aria-label={t('mergeVisibility')}
          value={mergeDraft.visibility}
          onChange={event => {
            setMergeDraft(value => value === undefined
              ? value
              : { ...value, visibility: event.target.value as MemoryVisibility })
          }}
        >
          <option value="personal">{t('visibilityPersonal')}</option>
          <option value="confidential">{t('visibilityConfidential')}</option>
        </select>
        <button type="submit" disabled={busy || mergeDraft.content.trim() === ''}>{t('saveMerge')}</button>
        <button type="button" disabled={busy} onClick={() => { setMergeDraft(undefined) }}>{t('cancel')}</button>
      </form>
    </fieldset>}
    {batchResult === undefined ? null : <fieldset>
      <legend>{batchResult.results.some(result => result.status === 'failed')
        ? t('partialSuccess')
        : t('batchComplete')}</legend>
      {batchResult.results.map(result => <small key={result.candidateId}>
        {result.candidateId} · {result.status === 'succeeded' ? t('batchSucceeded') : t('batchFailed')}
        {result.code === undefined ? '' : ` · ${result.code}`}
      </small>)}
    </fieldset>}
    {sourceView === undefined ? null : <fieldset>
      <legend>{t('source')}</legend>
      <p>{t('sourceEntity')}: {sourceView.entity} · {sourceView.id}</p>
      <small>{t('observation')}: {sourceView.observation.id}</small>
      <small>{t('sourceKind')}: {sourceView.observation.sourceKind}</small>
      <small>{t('sourceId')}: {sourceView.observation.sourceId}</small>
      <small>{t('observedAt')}: {sourceView.observation.observedAt}</small>
      {sourceView.sourceCandidateId === undefined
        ? null
        : <small>{t('sourceCandidate')}: {sourceView.sourceCandidateId}</small>}
      {sourceView.sourceCandidateIds === undefined
        ? null
        : <small>{t('sourceCandidates')}: {sourceView.sourceCandidateIds.join(', ')}</small>}
      {sourceView.supersedesMemoryId === undefined
        ? null
        : <small>{t('supersedes')}: {sourceView.supersedesMemoryId}</small>}
      {sourceView.sourceMemoryIds === undefined
        ? null
        : <small>{t('sourceMemories')}: {sourceView.sourceMemoryIds.join(', ')}</small>}
    </fieldset>}
    {conflict === undefined ? null : <fieldset>
      <legend>{t('conflict')}</legend>
      {conflict.relationships.map(relationship => <div key={relationship.memoryId}>
        <small>{assessmentLabel(relationship.relation, t)} · {relationship.memoryId} · {assessmentReasonLabel(relationship.reason, t)}</small>
        <button
          type="button"
          disabled={busy}
          onClick={() => { resolveConflict({ kind: 'supersede', memoryId: relationship.memoryId }) }}
        >{t('supersede')}</button>
      </div>)}
      <button
        type="button"
        disabled={busy}
        onClick={() => { resolveConflict({ kind: 'keep-both' }) }}
      >{t('keepBoth')}</button>
    </fieldset>}
  </section>
}

/** Render Memory governance only when DSH supplies a current live Session. */
export function DshMemorySettingsTab({ rpc, useSessions, t }: DshMemorySettingsTabProps): ReactNode {
  const sessionId = useSessions(snapshot => snapshot.current)
  if (sessionId === undefined) return <p role="status">{t('openSession')}</p>
  return <SessionMemorySettingsTab key={sessionId} rpc={rpc} sessionId={sessionId} t={t} />
}
