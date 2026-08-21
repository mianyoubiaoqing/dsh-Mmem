/** Session-bound directory and graph views over governed confirmed Memory. */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  createMemorySettingsClient,
  type MemoryRelationshipsRpcSnapshotV1,
  type MemorySettingsRpcCallerV1,
} from '@mistymoon/dsh-memory/settings-client'
import type { MemoryRecord, MemorySemanticRelationshipTypeV1 } from '@mistymoon/dsh-memory/contracts'
import type { MemorySettingsLocaleKey } from './locales.js'

interface MemoryExplorerSessionListV1 {
  readonly current: string | undefined
}

interface MemoryExplorerProps {
  readonly controller: MemoryExplorerController
  readonly rpc: MemorySettingsRpcCallerV1
  readonly useSessions: <Selected>(selector: (snapshot: MemoryExplorerSessionListV1) => Selected) => Selected
  readonly t: (key: MemorySettingsLocaleKey) => string
}

/** Browser-local visibility state shared by the sidebar trigger and overlay. */
export class MemoryExplorerController {
  #open = false
  readonly #listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly snapshot = (): boolean => this.#open

  open(): void {
    if (this.#open) return
    this.#open = true
    for (const listener of this.#listeners) listener()
  }

  close(): void {
    if (!this.#open) return
    this.#open = false
    for (const listener of this.#listeners) listener()
  }
}

function useExplorerOpen(controller: MemoryExplorerController): boolean {
  return useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
}

export function MemoryExplorerButton({ controller, t, wide }: Pick<MemoryExplorerProps, 'controller' | 't'> & {
  readonly wide: boolean
}): ReactNode {
  return <button
    type="button"
    className="dsh-mmem-explorer-trigger"
    aria-label={t('memoryExplorer')}
    title={t('memoryExplorer')}
    onClick={() => { controller.open() }}
  >
    <span aria-hidden="true" className="dsh-mmem-explorer-icon">◎</span>
    {wide ? <span>{t('memoryExplorer')}</span> : null}
  </button>
}

type ExplorerRelationship = MemoryRelationshipsRpcSnapshotV1['relationships'][number]

function relationshipLabel(
  relation: MemorySemanticRelationshipTypeV1,
  t: MemoryExplorerProps['t'],
): string {
  if (relation === 'elaborates') return t('relationshipElaborates')
  if (relation === 'contradicts') return t('relationshipContradicts')
  return t('relationshipRelated')
}

function memoryKindLabel(kind: MemoryRecord['memoryKind'], t: MemoryExplorerProps['t']): string {
  const keys: Record<MemoryRecord['memoryKind'], MemorySettingsLocaleKey> = {
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

function visibilityLabel(visibility: MemoryRecord['visibility'], t: MemoryExplorerProps['t']): string {
  return t(visibility === 'confidential' ? 'visibilityConfidential' : 'visibilityPersonal')
}

function DirectoryView({ records, t }: { records: readonly MemoryRecord[]; t: MemoryExplorerProps['t'] }): ReactNode {
  const groups = new Map<MemoryRecord['memoryKind'], MemoryRecord[]>()
  for (const record of records) {
    groups.set(record.memoryKind, [...(groups.get(record.memoryKind) ?? []), record])
  }
  return <div className="dsh-mmem-directory">
    {[...groups.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([kind, items]) =>
      <section key={kind} className="dsh-mmem-directory-group">
        <h3>{memoryKindLabel(kind, t)}<span>{items.length}</span></h3>
        {items.map(record => <article key={record.id}>
          <p>{record.content}</p>
          <small>{visibilityLabel(record.visibility, t)} · {new Date(record.recordedAt).toLocaleString()}</small>
        </article>)}
      </section>)}
  </div>
}

function GraphView({
  records,
  relationships,
  t,
}: {
  records: readonly MemoryRecord[]
  relationships: readonly ExplorerRelationship[]
  t: MemoryExplorerProps['t']
}): ReactNode {
  const [zoom, setZoom] = useState(100)
  const centerX = 360
  const centerY = 250
  const radius = Math.max(90, Math.min(190, records.length * 28)) * zoom / 100
  const positions = new Map(records.map((record, index) => {
    const angle = records.length === 1 ? 0 : (Math.PI * 2 * index / records.length) - Math.PI / 2
    return [record.id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    }] as const
  }))
  return <div className="dsh-mmem-graph-wrap">
    <label className="dsh-mmem-range">{t('graphZoom')}
      <input
        type="range"
        min="70"
        max="140"
        value={zoom}
        onChange={event => { setZoom(Number(event.target.value)) }}
      />
      <span>{zoom}%</span>
    </label>
    <svg className="dsh-mmem-graph" viewBox="0 0 720 500" role="img" aria-label={t('graphCanvas')}>
      {relationships.map(relationship => {
        const from = positions.get(relationship.sourceMemoryId)
        const to = positions.get(relationship.targetMemoryId)
        if (from === undefined || to === undefined) return null
        const label = relationshipLabel(relationship.relation, t)
        return <g key={relationship.id}>
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`relation-${relationship.relation}`} />
          <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6}>{label}</text>
        </g>
      })}
      {records.map(record => {
        const point = positions.get(record.id)
        if (point === undefined) return null
        return <g key={record.id} className={`memory-node memory-node-${record.memoryKind}`}>
          <circle cx={point.x} cy={point.y} r="34"><title>{record.content}</title></circle>
          <text x={point.x} y={point.y + 4} textAnchor="middle">{memoryKindLabel(record.memoryKind, t)}</text>
        </g>
      })}
    </svg>
    <ul className="dsh-mmem-graph-legend">
      {relationships.map(relationship => <li key={relationship.id}>
        {relationshipLabel(relationship.relation, t)}
      </li>)}
    </ul>
  </div>
}

export function MemoryExplorerOverlay({ controller, rpc, useSessions, t }: MemoryExplorerProps): ReactNode {
  const open = useExplorerOpen(controller)
  const sessionId = useSessions(snapshot => snapshot.current)
  const [view, setView] = useState<'directory' | 'graph'>('directory')
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState<MemoryRecord[]>([])
  const [relationships, setRelationships] = useState<ExplorerRelationship[]>([])
  const [activeSpaceId, setActiveSpaceId] = useState<string>()
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open || sessionId === undefined) return
    const controller = new AbortController()
    const client = createMemorySettingsClient({ rpc, sessionId })
    setState('loading')
    void Promise.all([
      client.search({ recordStatus: 'active', candidateStatus: 'pending', limit: 500 }, controller.signal),
      client.listRelationships(controller.signal),
    ]).then(([memory, relation]) => {
      setRecords(memory.management.records)
      setRelationships(relation.relationships)
      setActiveSpaceId(memory.activeSpace.spaceId)
      setState('ready')
    }, () => {
      if (!controller.signal.aborted) setState('failed')
    })
    return () => { controller.abort() }
  }, [open, reload, rpc, sessionId])

  const visibleRecords = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (needle === '') return records
    return records.filter(record => record.content.toLocaleLowerCase().includes(needle))
  }, [query, records])
  const visibleIds = new Set(visibleRecords.map(record => record.id))
  const visibleRelationships = relationships.filter(relationship => visibleIds.has(relationship.sourceMemoryId)
    && visibleIds.has(relationship.targetMemoryId))

  if (!open) return null
  return <div className="dsh-mmem-explorer-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) controller.close()
  }}>
    <section className="dsh-mmem-explorer" role="dialog" aria-modal="true" aria-label={t('memoryExplorer')}>
      <header>
        <div>
          <h2>{t('memoryExplorer')}</h2>
          {activeSpaceId === undefined ? null : <small>{t('activeSpace')}: {activeSpaceId}</small>}
        </div>
        <button type="button" onClick={() => { controller.close() }} aria-label={t('close')}>×</button>
      </header>
      {sessionId === undefined ? <p className="dsh-mmem-empty">{t('openSessionExplorer')}</p> : <>
        <div className="dsh-mmem-explorer-toolbar">
          <input
            type="search"
            aria-label={t('explorerSearch')}
            placeholder={t('explorerSearch')}
            value={query}
            onChange={event => { setQuery(event.target.value) }}
          />
          <div className="dsh-mmem-segmented" role="group">
            <button type="button" aria-pressed={view === 'directory'} onClick={() => { setView('directory') }}>
              {t('directoryView')}
            </button>
            <button type="button" aria-pressed={view === 'graph'} onClick={() => { setView('graph') }}>
              {t('graphView')}
            </button>
          </div>
        </div>
        {state === 'loading' ? <p>{t('loading')}</p> : null}
        {state === 'failed' ? <div className="dsh-mmem-empty">
          <p role="alert">{t('loadError')}</p>
          <button type="button" onClick={() => { setReload(value => value + 1) }}>{t('retry')}</button>
        </div> : null}
        {state === 'ready' && visibleRecords.length === 0 ? <p className="dsh-mmem-empty">{t('noMemories')}</p> : null}
        {state === 'ready' && visibleRecords.length > 0 && view === 'directory'
          ? <DirectoryView records={visibleRecords} t={t} /> : null}
        {state === 'ready' && visibleRecords.length > 0 && view === 'graph'
          ? <GraphView records={visibleRecords} relationships={visibleRelationships} t={t} /> : null}
      </>}
    </section>
  </div>
}
