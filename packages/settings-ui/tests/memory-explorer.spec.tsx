import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  MemoryExplorerController,
  MemoryExplorerOverlay,
} from '../src/client/MemoryExplorer.js'

describe('dsh-Mmem Memory explorer', () => {
  it('shows governed Memory as a directory and an accessible semantic graph', async () => {
    const activeSpace = {
      spaceId: 'space-project-alpha',
      access: 'read-write' as const,
      bindingRevision: 'binding-explorer',
    }
    const records = [
      {
        schemaVersion: 2 as const,
        id: 'memory-a',
        ownerId: 'owner-fixture',
        scope: { version: 1 as const, kind: 'companion-reality' as const },
        observationId: 'observation-a',
        memoryKind: 'preference' as const,
        createdAt: '2026-08-21T00:00:00.000Z',
        recordedAt: '2026-08-21T00:00:00.000Z',
        content: '偏好安静的工作环境。',
        visibility: 'personal' as const,
        sourceMessageId: 'message-a',
        status: 'confirmed' as const,
      },
      {
        schemaVersion: 2 as const,
        id: 'memory-b',
        ownerId: 'owner-fixture',
        scope: { version: 1 as const, kind: 'companion-reality' as const },
        observationId: 'observation-b',
        memoryKind: 'summary' as const,
        createdAt: '2026-08-21T00:01:00.000Z',
        recordedAt: '2026-08-21T00:01:00.000Z',
        content: '工作环境偏好保持稳定。',
        visibility: 'personal' as const,
        sourceMessageId: 'message-b',
        status: 'confirmed' as const,
      },
    ]
    const call = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'memory/search') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace,
          management: { schemaVersion: 1, records, candidates: [], audit: [] },
        },
      }
      if (endpoint === 'relationships/list') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace,
          relationships: [{
            schemaVersion: 1,
            id: 'relationship-1',
            ownerId: 'owner-fixture',
            scope: { version: 1 as const, kind: 'companion-reality' as const },
            sourceMemoryId: 'memory-b',
            targetMemoryId: 'memory-a',
            relation: 'elaborates' as const,
            sourceCandidateId: 'candidate-b',
            sourceMessageId: 'message-b',
            createdAt: '2026-08-21T00:01:00.000Z',
          }],
        },
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const controller = new MemoryExplorerController()
    controller.open()
    const useSessions = <Selected,>(
      selector: (snapshot: { current: string | undefined }) => Selected,
    ): Selected => selector({ current: 'settings-session' })
    let tree: ReturnType<typeof create> | undefined

    await act(async () => {
      tree = create(<MemoryExplorerOverlay
        controller={controller}
        rpc={{ call }}
        useSessions={useSessions}
        t={key => `translated:${key}`}
      />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(JSON.stringify(tree?.toJSON())).toContain('偏好安静的工作环境。')
    expect(tree?.root.findAllByType('h3').some(heading =>
      heading.children.includes('translated:kindPreference'),
    )).toBe(true)
    const graph = tree?.root.findAllByType('button')
      .find(button => button.children.includes('translated:graphView'))
    if (graph === undefined) throw new Error('expected graph view switch')
    await act(async () => { graph.props.onClick() })

    expect(tree?.root.findByProps({ 'aria-label': 'translated:graphCanvas' })).toBeDefined()
    expect(tree?.root.findByProps({ type: 'range' })).toBeDefined()
    expect(JSON.stringify(tree?.toJSON())).toContain('translated:relationshipElaborates')
  })
})
