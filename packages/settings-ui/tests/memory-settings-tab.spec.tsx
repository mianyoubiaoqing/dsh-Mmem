import { create, act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { DshMemorySettingsTab } from '../src/client/MemorySettingsTab.js'

describe('dsh-Mmem Settings tab', () => {
  it('fails closed without a current live DSH Session', () => {
    const call = vi.fn()
    const useSessions = <Selected,>(
      selector: (snapshot: { current: string | undefined }) => Selected,
    ): Selected => selector({ current: undefined })
    let tree: ReturnType<typeof create> | undefined

    act(() => {
      tree = create(<DshMemorySettingsTab
        rpc={{ call }}
        useSessions={useSessions}
        t={key => `translated:${key}`}
      />)
    })

    expect(tree?.toJSON()).toMatchObject({
      type: 'p',
      props: { role: 'status' },
      children: ['translated:openSession'],
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('binds Memory search to the current DSH Session and renders the resolved Active Space', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-12',
        },
        management: {
          schemaVersion: 1,
          records: [],
          candidates: [],
          audit: [],
        },
      },
    })
    const useSessions = <Selected,>(
      selector: (snapshot: { current: string | undefined }) => Selected,
    ): Selected => selector({ current: 'settings-session' })
    let tree: ReturnType<typeof create> | undefined

    await act(async () => {
      tree = create(<DshMemorySettingsTab
        rpc={{ call }}
        useSessions={useSessions}
        t={key => `translated:${key}`}
      />)
    })

    expect(call).toHaveBeenCalledWith(
      '/dsh-mmem-settings',
      'memory/search',
      {
        sessionId: 'settings-session',
        recordStatus: 'all',
        candidateStatus: 'pending',
        limit: 200,
      },
      expect.any(AbortSignal),
    )
    expect(JSON.stringify(tree?.toJSON())).toContain('space-project-alpha')
  })

  it('applies Owner search and filters within the current DSH Session', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-search',
        },
        management: { schemaVersion: 1, records: [], candidates: [], audit: [] },
      },
    })
    const useSessions = <Selected,>(
      selector: (snapshot: { current: string | undefined }) => Selected,
    ): Selected => selector({ current: 'settings-session' })
    let tree: ReturnType<typeof create> | undefined

    await act(async () => {
      tree = create(<DshMemorySettingsTab
        rpc={{ call }}
        useSessions={useSessions}
        t={key => `translated:${key}`}
      />)
    })

    const control = (label: string) => tree?.root.find(
      node => node.props['aria-label'] === `translated:${label}`,
    )
    await act(async () => {
      control('searchQuery')?.props.onChange({ target: { value: 'neutral preference' } })
      control('memoryKind')?.props.onChange({ target: { value: 'preference' } })
      control('visibility')?.props.onChange({ target: { value: 'confidential' } })
      control('candidateStatus')?.props.onChange({ target: { value: 'all' } })
    })
    await act(async () => {
      tree?.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() })
      await Promise.resolve()
    })

    expect(call).toHaveBeenLastCalledWith(
      '/dsh-mmem-settings',
      'memory/search',
      {
        sessionId: 'settings-session',
        query: 'neutral preference',
        memoryKind: 'preference',
        visibility: 'confidential',
        recordStatus: 'all',
        candidateStatus: 'all',
        limit: 200,
      },
      expect.any(AbortSignal),
    )
  })

  it('renders governed confirmed Memories alongside Candidate results', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-records',
        },
        management: {
          schemaVersion: 1,
          records: [{
            schemaVersion: 2,
            id: 'memory-confirmed-1',
            ownerId: 'owner-fixture',
            scope: { version: 1, kind: 'companion-reality' },
            observationId: 'observation-record-1',
            memoryKind: 'preference',
            createdAt: '2026-08-21T00:01:00.000Z',
            recordedAt: '2026-08-21T00:00:00.000Z',
            content: '经治理确认的中性偏好。',
            visibility: 'personal',
            sourceMessageId: 'message-record-1',
            status: 'confirmed',
          }],
          candidates: [],
          audit: [],
        },
      },
    })
    const useSessions = <Selected,>(
      selector: (snapshot: { current: string | undefined }) => Selected,
    ): Selected => selector({ current: 'settings-session' })
    let tree: ReturnType<typeof create> | undefined

    await act(async () => {
      tree = create(<DshMemorySettingsTab
        rpc={{ call }}
        useSessions={useSessions}
        t={key => `translated:${key}`}
      />)
    })

    const rendered = JSON.stringify(tree?.toJSON())
    expect(rendered).toContain('translated:records')
    expect(rendered).toContain('经治理确认的中性偏好。')
  })

  it('shows payload-free Candidate provenance in a read-only Binding', async () => {
    const activeSpace = {
      spaceId: 'space-project-alpha',
      access: 'read' as const,
      bindingRevision: 'binding-source',
    }
    const candidate = {
      schemaVersion: 2 as const,
      event: 'candidate' as const,
      id: 'candidate-source-1',
      ownerId: 'owner-fixture',
      scope: { version: 1 as const, kind: 'companion-reality' as const },
      observationId: 'observation-source-1',
      memoryKind: 'summary' as const,
      createdAt: '2026-08-21T00:00:00.000Z',
      recordedAt: '2026-08-21T00:00:00.000Z',
      content: '带有可审计来源的中性候选。',
      visibility: 'personal' as const,
      sourceMessageId: 'message-source-1',
      status: 'pending' as const,
    }
    const call = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'memory/search') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace,
          management: { schemaVersion: 1, records: [], candidates: [candidate], audit: [] },
        },
      }
      if (endpoint === 'memory/source') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace,
          source: {
            schemaVersion: 1,
            entity: 'candidate' as const,
            id: candidate.id,
            observation: {
              id: candidate.observationId,
              sourceKind: 'dsh-message',
              sourceId: candidate.sourceMessageId,
              observedAt: candidate.recordedAt,
            },
            sourceCandidateIds: ['candidate-parent-1'],
          },
        },
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const useSessions = <Selected,>(
      selector: (snapshot: { current: string | undefined }) => Selected,
    ): Selected => selector({ current: 'settings-session' })
    let tree: ReturnType<typeof create> | undefined

    await act(async () => {
      tree = create(<DshMemorySettingsTab
        rpc={{ call }}
        useSessions={useSessions}
        t={key => `translated:${key}`}
      />)
    })
    const source = tree?.root.findAllByType('button')
      .find(button => button.children.includes('translated:viewSource'))
    if (source === undefined) throw new Error('expected the Candidate source button')
    await act(async () => {
      source.props.onClick()
      await Promise.resolve()
    })

    expect(call).toHaveBeenLastCalledWith(
      '/dsh-mmem-settings',
      'memory/source',
      { sessionId: 'settings-session', entity: 'candidate', id: candidate.id },
      undefined,
    )
    const rendered = JSON.stringify(tree?.toJSON())
    expect(rendered).toContain('message-source-1')
    expect(rendered).toContain('candidate-parent-1')
  })

  it('renders pending Candidates from the governed management projection', async () => {
    const searchResponse = {
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-12',
        },
        management: {
          schemaVersion: 1,
          records: [],
          candidates: [{
            schemaVersion: 2,
            event: 'candidate',
            id: 'candidate-1',
            ownerId: 'owner-fixture',
            scope: { version: 1, kind: 'companion-reality' },
            observationId: 'observation-1',
            memoryKind: 'summary',
            createdAt: '2026-08-21T00:00:00.000Z',
            recordedAt: '2026-08-21T00:00:00.000Z',
            content: '需要人工审批的中性候选。',
            visibility: 'personal',
            sourceMessageId: 'message-1',
            status: 'pending',
          }],
          audit: [],
        },
      },
    } as const
    const call = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'memory/search') return searchResponse
      if (endpoint === 'memory/assess') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace: searchResponse.value.activeSpace,
          assessment: {
            schemaVersion: 1,
            candidateId: 'candidate-1',
            evaluatedAt: '2026-08-21T00:01:00.000Z',
            relationships: [],
          },
        },
      }
      if (endpoint === 'candidates/approve') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace: searchResponse.value.activeSpace,
          memory: {
            schemaVersion: 2,
            id: 'memory-1',
            ownerId: 'owner-fixture',
            scope: { version: 1 as const, kind: 'companion-reality' as const },
            observationId: 'observation-1',
            memoryKind: 'summary' as const,
            createdAt: '2026-08-21T00:01:00.000Z',
            recordedAt: '2026-08-21T00:00:00.000Z',
            content: '经 Owner 批准的中性记忆。',
            visibility: 'personal' as const,
            sourceMessageId: 'message-1',
            sourceCandidateId: 'candidate-1',
            status: 'confirmed' as const,
          },
        },
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const useSessions = <Selected,>(
      selector: (snapshot: { current: string | undefined }) => Selected,
    ): Selected => selector({ current: 'settings-session' })
    let tree: ReturnType<typeof create> | undefined

    await act(async () => {
      tree = create(<DshMemorySettingsTab
        rpc={{ call }}
        useSessions={useSessions}
        t={key => `translated:${key}`}
      />)
    })

    expect(JSON.stringify(tree?.toJSON())).toContain('需要人工审批的中性候选。')
    const approve = tree?.root.findAllByType('button')
      .find(button => button.children.includes('translated:approve'))
    if (approve === undefined) throw new Error('expected the Candidate approve button')
    await act(async () => {
      approve.props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(call.mock.calls.map(([, endpoint]) => endpoint)).toEqual([
      'memory/search',
      'memory/assess',
      'candidates/approve',
      'memory/search',
    ])
  })

  it('requires an explicit Owner resolution before approving a conflicting Candidate', async () => {
    const activeSpace = {
      spaceId: 'space-project-alpha',
      access: 'read-write' as const,
      bindingRevision: 'binding-13',
    }
    const candidate = {
      schemaVersion: 2 as const,
      event: 'candidate' as const,
      id: 'candidate-conflict',
      ownerId: 'owner-fixture',
      scope: { version: 1 as const, kind: 'companion-reality' as const },
      observationId: 'observation-conflict',
      memoryKind: 'summary' as const,
      createdAt: '2026-08-21T00:00:00.000Z',
      recordedAt: '2026-08-21T00:00:00.000Z',
      content: '与已有记忆冲突的中性候选。',
      visibility: 'personal' as const,
      sourceMessageId: 'message-conflict',
      status: 'pending' as const,
    }
    const call = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'memory/search') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace,
          management: { schemaVersion: 1, records: [], candidates: [candidate], audit: [] },
        },
      }
      if (endpoint === 'memory/assess') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace,
          assessment: {
            schemaVersion: 1,
            candidateId: candidate.id,
            evaluatedAt: '2026-08-21T00:01:00.000Z',
            relationships: [{
              memoryId: 'memory-existing',
              relation: 'conflict' as const,
              score: 0.8,
              reason: 'same-kind-near-match' as const,
            }],
          },
        },
      }
      if (endpoint === 'candidates/approve') return {
        ok: true as const,
        value: {
          schemaVersion: 1,
          activeSpace,
          memory: {
            schemaVersion: 2,
            id: 'memory-approved',
            ownerId: 'owner-fixture',
            scope: candidate.scope,
            observationId: candidate.observationId,
            memoryKind: candidate.memoryKind,
            createdAt: '2026-08-21T00:02:00.000Z',
            recordedAt: candidate.recordedAt,
            content: candidate.content,
            visibility: candidate.visibility,
            sourceMessageId: candidate.sourceMessageId,
            sourceCandidateId: candidate.id,
            status: 'confirmed' as const,
          },
        },
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const useSessions = <Selected,>(
      selector: (snapshot: { current: string | undefined }) => Selected,
    ): Selected => selector({ current: 'settings-session' })
    let tree: ReturnType<typeof create> | undefined

    await act(async () => {
      tree = create(<DshMemorySettingsTab
        rpc={{ call }}
        useSessions={useSessions}
        t={key => `translated:${key}`}
      />)
    })
    const approve = tree?.root.findAllByType('button')
      .find(button => button.children.includes('translated:approve'))
    if (approve === undefined) throw new Error('expected the Candidate approve button')
    await act(async () => {
      approve.props.onClick()
      await Promise.resolve()
    })
    expect(JSON.stringify(tree?.toJSON())).toContain('translated:keepBoth')

    const keepBoth = tree?.root.findAllByType('button')
      .find(button => button.children.includes('translated:keepBoth'))
    if (keepBoth === undefined) throw new Error('expected the keep-both resolution button')
    await act(async () => {
      keepBoth.props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(call).toHaveBeenCalledWith(
      '/dsh-mmem-settings',
      'candidates/approve',
      expect.objectContaining({
        sessionId: 'settings-session',
        candidateId: candidate.id,
        resolution: { kind: 'keep-both' },
      }),
      undefined,
    )
  })
})
