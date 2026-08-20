/** Session-bound Owner-facing Memory governance page. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  createMemorySettingsClient,
  type MemoryAssessmentRpcSnapshotV1,
  type MemoryManagementRpcSnapshotV1,
  type MemorySettingsRpcCallerV1,
} from '@mistymoon/dsh-memory/settings-client'
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

  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(undefined)
    setFailed(false)
    void client.search({
      recordStatus: 'all',
      candidateStatus: 'pending',
      limit: 200,
    }, controller.signal).then(
      value => { setSnapshot(value) },
      () => { if (!controller.signal.aborted) setFailed(true) },
    )
    return () => { controller.abort() }
  }, [client, refresh])

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

  if (failed) return <p role="alert">{t('loadError')}</p>
  if (snapshot === undefined) return <p role="status">{t('loading')}</p>
  return <section className="dsh-mmem-settings">
    <h3>{t('activeSpace')}</h3>
    <p>{snapshot.activeSpace.spaceId} · {snapshot.activeSpace.access}</p>
    <fieldset>
      <legend>{t('candidates')}</legend>
      {snapshot.management.candidates.length === 0
        ? <p>{t('noCandidates')}</p>
        : snapshot.management.candidates.map(candidate => <article key={candidate.id}>
            <p>{candidate.content}</p>
            <small>{candidate.memoryKind} · {candidate.visibility} · {candidate.status}</small>
            {candidate.status === 'pending' ? <div>
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
            </div> : null}
          </article>)}
    </fieldset>
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
