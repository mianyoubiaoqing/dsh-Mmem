/** Session-bound Owner-facing Memory governance page. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  createMemorySettingsClient,
  type MemoryAssessmentRpcSnapshotV1,
  type MemoryBatchRpcSnapshotV1,
  type MemoryManagementRpcSnapshotV1,
  type MemorySettingsRpcCallerV1,
  type MemorySourceRpcSnapshotV1,
} from '@mistymoon/dsh-memory/settings-client'
import type { MemoryCandidate, MemoryVisibility } from '@mistymoon/dsh-memory/contracts'
import type { MemoryKind } from '@mistymoon/dsh-memory/domain'
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
]

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
  const [mergeDraft, setMergeDraft] = useState<CandidateMergeDraftV1>()
  const [batchResult, setBatchResult] = useState<MemoryBatchRpcSnapshotV1['batch']>()
  const [filters, setFilters] = useState<MemoryFilterStateV1>(DEFAULT_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState<MemoryFilterStateV1>(DEFAULT_FILTERS)

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
      () => { if (!controller.signal.aborted) setFailed(true) },
    )
    return () => { controller.abort() }
  }, [appliedFilters, client, refresh])

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
      await client.approveCandidate(candidateId)
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
    void client.approveCandidate(conflict.candidateId, resolution).then(
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

  if (failed) return <p role="alert">{t('loadError')}</p>
  if (snapshot === undefined) return <p role="status">{t('loading')}</p>
  return <section className="dsh-mmem-settings">
    <h3>{t('activeSpace')}</h3>
    <p>{snapshot.activeSpace.spaceId} · {snapshot.activeSpace.access}</p>
    <form onSubmit={(event) => {
      event.preventDefault()
      setAppliedFilters({ ...filters })
    }}>
      <strong>{t('filters')}</strong>
      <input
        type="search"
        aria-label={t('searchQuery')}
        value={filters.query}
        onChange={event => { setFilters(value => ({ ...value, query: event.target.value })) }}
      />
      <select
        aria-label={t('memoryKind')}
        value={filters.memoryKind}
        onChange={event => {
          setFilters(value => ({ ...value, memoryKind: event.target.value as MemoryFilterStateV1['memoryKind'] }))
        }}
      >
        <option value="">{t('allKinds')}</option>
        {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <select
        aria-label={t('visibility')}
        value={filters.visibility}
        onChange={event => {
          setFilters(value => ({ ...value, visibility: event.target.value as MemoryFilterStateV1['visibility'] }))
        }}
      >
        <option value="">{t('allVisibilities')}</option>
        <option value="personal">personal</option>
        <option value="confidential">confidential</option>
      </select>
      <select
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
        {CANDIDATE_STATUSES.map(status => <option key={status} value={status}>{status}</option>)}
      </select>
      <button type="submit">{t('applyFilters')}</button>
    </form>
    <fieldset>
      <legend>{t('records')}</legend>
      {snapshot.management.records.length === 0
        ? <p>{t('noRecords')}</p>
        : snapshot.management.records.map(record => <article key={record.id}>
            <p>{record.content}</p>
            <small>{record.memoryKind} · {record.visibility} · {record.status}</small>
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
            <small>{candidate.memoryKind} · {candidate.visibility} · {candidate.status}</small>
            <div>
              <button type="button" disabled={busy} onClick={() => { showSource('candidate', candidate.id) }}>
                {t('viewSource')}
              </button>
              {candidate.status === 'pending' ? <>
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
          {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
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
          <option value="personal">personal</option>
          <option value="confidential">confidential</option>
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
          {MEMORY_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
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
          <option value="personal">personal</option>
          <option value="confidential">confidential</option>
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
        {result.candidateId} · {result.status}{result.code === undefined ? '' : ` · ${result.code}`}
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
        <small>{relationship.relation} · {relationship.memoryId} · {relationship.reason}</small>
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
