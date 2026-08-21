import { describe, expect, it, vi } from 'vitest'
import { createMemorySettingsClient } from '../src/settings-client.js'

describe('dsh-Mmem Settings browser client', () => {
  it('lists Candidates through the fixed Memory channel using only the live Session selection', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-4',
        },
        candidates: [],
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
      requestedSpaceId: 'space-project-alpha',
    })
    const controller = new AbortController()

    await expect(client.listCandidates(controller.signal)).resolves.toEqual({
      schemaVersion: 1,
      activeSpace: {
        spaceId: 'space-project-alpha',
        access: 'read-write',
        bindingRevision: 'binding-4',
      },
      candidates: [],
    })
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'candidates/list',
      {
        sessionId: 'settings-session',
        requestedSpaceId: 'space-project-alpha',
      },
      controller.signal,
    )
  })

  it('rejects malformed Candidate data instead of exposing an unvalidated Host response', async () => {
    const client = createMemorySettingsClient({
      rpc: {
        call: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            schemaVersion: 1,
            activeSpace: {
              spaceId: 'space-project-alpha',
              access: 'read-write',
              bindingRevision: 'binding-4',
            },
            candidates: [{ id: 'candidate-without-governance-fields' }],
          },
        }),
      },
      sessionId: 'settings-session',
    })

    await expect(client.listCandidates()).rejects.toMatchObject({
      name: 'MemorySettingsClientError',
      code: 'invalid-response',
    })
  })

  it('searches only the Session Active Space and preserves its governance receipt', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read',
          bindingRevision: 'binding-7',
        },
        management: {
          schemaVersion: 1,
          records: [],
          candidates: [],
          audit: [],
        },
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
    })

    await expect(client.search({
      query: '中性检索',
      memoryKind: 'summary',
      visibility: 'personal',
      recordStatus: 'active',
      candidateStatus: 'pending',
      limit: 20,
    })).resolves.toEqual(expect.objectContaining({
      activeSpace: {
        spaceId: 'space-project-alpha',
        access: 'read',
        bindingRevision: 'binding-7',
      },
    }))
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'memory/search',
      {
        sessionId: 'settings-session',
        query: '中性检索',
        memoryKind: 'summary',
        visibility: 'personal',
        recordStatus: 'active',
        candidateStatus: 'pending',
        limit: 20,
      },
      undefined,
    )
  })

  it('rejects malformed records in a Memory management response', async () => {
    const client = createMemorySettingsClient({
      rpc: {
        call: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            schemaVersion: 1,
            activeSpace: {
              spaceId: 'space-project-alpha',
              access: 'read',
              bindingRevision: 'binding-7',
            },
            management: {
              schemaVersion: 1,
              records: [{ id: 'memory-without-governance-fields' }],
              candidates: [],
              audit: [],
            },
          },
        }),
      },
      sessionId: 'settings-session',
    })

    await expect(client.search()).rejects.toMatchObject({
      name: 'MemorySettingsClientError',
      code: 'invalid-response',
    })
  })

  it('loads provenance by entity and id without accepting source identity from the browser', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-8',
        },
        source: {
          schemaVersion: 1,
          entity: 'candidate',
          id: 'candidate-1',
          observation: {
            id: 'observation-1',
            sourceKind: 'dsh-message',
            sourceId: 'message-1',
            observedAt: '2026-08-21T00:00:00.000Z',
          },
        },
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
    })

    await expect(client.source('candidate', 'candidate-1')).resolves.toEqual(
      expect.objectContaining({ source: expect.objectContaining({ id: 'candidate-1' }) }),
    )
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'memory/source',
      {
        sessionId: 'settings-session',
        entity: 'candidate',
        id: 'candidate-1',
      },
      undefined,
    )
  })

  it('assesses one Candidate through the same Session-bound governance channel', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-8',
        },
        assessment: {
          schemaVersion: 1,
          candidateId: 'candidate-1',
          evaluatedAt: '2026-08-21T00:00:00.000Z',
          relationships: [],
        },
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
    })

    await expect(client.assessCandidate('candidate-1')).resolves.toEqual(
      expect.objectContaining({ assessment: expect.objectContaining({ candidateId: 'candidate-1' }) }),
    )
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'memory/assess',
      { sessionId: 'settings-session', candidateId: 'candidate-1' },
      undefined,
    )
  })

  it('lists only validated confirmed Memory relationships for the current Session', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-relations',
        },
        relationships: [{
          schemaVersion: 1,
          id: 'relationship-1',
          ownerId: 'owner-fixture',
          scope: { version: 1, kind: 'companion-reality' },
          sourceMemoryId: 'memory-new',
          targetMemoryId: 'memory-existing',
          relation: 'elaborates',
          sourceCandidateId: 'candidate-1',
          sourceMessageId: 'message-approve-1',
          createdAt: '2026-08-21T00:00:00.000Z',
        }],
      },
    })
    const client = createMemorySettingsClient({ rpc: { call }, sessionId: 'settings-session' })

    await expect(client.listRelationships()).resolves.toMatchObject({
      relationships: [{ id: 'relationship-1', relation: 'elaborates' }],
    })
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'relationships/list',
      { sessionId: 'settings-session' },
      undefined,
    )
  })

  it('approves one Candidate with a client-generated idempotency request and explicit resolution', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-9',
        },
        memory: {
          schemaVersion: 2,
          id: 'memory-1',
          ownerId: 'owner-fixture',
          scope: { version: 1, kind: 'companion-reality' },
          observationId: 'observation-1',
          memoryKind: 'summary',
          createdAt: '2026-08-21T00:00:00.000Z',
          recordedAt: '2026-08-21T00:00:00.000Z',
          content: '经 Owner 批准的中性记忆。',
          visibility: 'personal',
          sourceMessageId: 'message-1',
          sourceCandidateId: 'candidate-1',
          status: 'confirmed',
        },
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
      createRequestId: () => 'request-approve-1',
    })
    const signal = new AbortController().signal

    await expect(client.approveCandidate(
      'candidate-1',
      { kind: 'keep-both' },
      signal,
      [{ targetMemoryId: 'memory-existing', relation: 'elaborates' }],
    )).resolves.toEqual(
      expect.objectContaining({ memory: expect.objectContaining({ id: 'memory-1' }) }),
    )
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'candidates/approve',
      {
        sessionId: 'settings-session',
        candidateId: 'candidate-1',
        requestId: 'request-approve-1',
        resolution: { kind: 'keep-both' },
        relationships: [{ targetMemoryId: 'memory-existing', relation: 'elaborates' }],
      },
      signal,
    )
  })

  it('rejects one Candidate without inventing a conflict resolution', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-9',
        },
        candidate: {
          schemaVersion: 2,
          event: 'candidate',
          id: 'candidate-2',
          ownerId: 'owner-fixture',
          scope: { version: 1, kind: 'companion-reality' },
          observationId: 'observation-2',
          memoryKind: 'summary',
          createdAt: '2026-08-21T00:00:00.000Z',
          recordedAt: '2026-08-21T00:00:00.000Z',
          content: '被 Owner 拒绝的中性候选。',
          visibility: 'personal',
          sourceMessageId: 'message-2',
          status: 'rejected',
        },
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
      createRequestId: () => 'request-reject-1',
    })

    await expect(client.rejectCandidate('candidate-2')).resolves.toEqual(
      expect.objectContaining({ candidate: expect.objectContaining({ status: 'rejected' }) }),
    )
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'candidates/reject',
      {
        sessionId: 'settings-session',
        candidateId: 'candidate-2',
        requestId: 'request-reject-1',
      },
      undefined,
    )
  })

  it('edits a Candidate by submitting a complete replacement draft with lineage kept by the Host', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-10',
        },
        candidate: {
          schemaVersion: 2,
          event: 'candidate',
          id: 'candidate-edited',
          ownerId: 'owner-fixture',
          scope: { version: 1, kind: 'companion-reality' },
          observationId: 'observation-edited',
          memoryKind: 'summary',
          createdAt: '2026-08-21T00:00:00.000Z',
          recordedAt: '2026-08-21T00:00:00.000Z',
          content: 'Owner 编辑后的完整候选。',
          visibility: 'personal',
          sourceMessageId: 'dsh-mmem-settings:request-edit-1',
          sourceCandidateIds: ['candidate-3'],
          status: 'pending',
        },
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
      createRequestId: () => 'request-edit-1',
    })

    await expect(client.editCandidate({
      candidateId: 'candidate-3',
      content: 'Owner 编辑后的完整候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })).resolves.toEqual(expect.objectContaining({
      candidate: expect.objectContaining({ id: 'candidate-edited' }),
    }))
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'memory/edit',
      {
        sessionId: 'settings-session',
        candidateIds: ['candidate-3'],
        requestId: 'request-edit-1',
        content: 'Owner 编辑后的完整候选。',
        visibility: 'personal',
        memoryKind: 'summary',
      },
      undefined,
    )
  })

  it('merges multiple Candidates without letting the browser submit lineage or trusted context', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-10',
        },
        candidate: {
          schemaVersion: 2,
          event: 'candidate',
          id: 'candidate-merged',
          ownerId: 'owner-fixture',
          scope: { version: 1, kind: 'companion-reality' },
          observationId: 'observation-merged',
          memoryKind: 'summary',
          createdAt: '2026-08-21T00:00:00.000Z',
          recordedAt: '2026-08-21T00:00:00.000Z',
          content: 'Owner 合并后的完整候选。',
          visibility: 'personal',
          sourceMessageId: 'dsh-mmem-settings:request-merge-1',
          sourceCandidateIds: ['candidate-4', 'candidate-5'],
          status: 'pending',
        },
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
      createRequestId: () => 'request-merge-1',
    })

    await expect(client.mergeCandidates({
      candidateIds: ['candidate-4', 'candidate-5'],
      content: 'Owner 合并后的完整候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })).resolves.toEqual(expect.objectContaining({
      candidate: expect.objectContaining({ id: 'candidate-merged' }),
    }))
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'memory/merge',
      {
        sessionId: 'settings-session',
        candidateIds: ['candidate-4', 'candidate-5'],
        requestId: 'request-merge-1',
        content: 'Owner 合并后的完整候选。',
        visibility: 'personal',
        memoryKind: 'summary',
      },
      undefined,
    )
  })

  it('submits an independently atomic batch with one generated request id', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-11',
        },
        batch: {
          schemaVersion: 1,
          results: [
            { candidateId: 'candidate-6', status: 'succeeded' },
            { candidateId: 'candidate-7', status: 'failed', code: 'candidate-not-pending' },
          ],
        },
      },
    })
    const client = createMemorySettingsClient({
      rpc: { call },
      sessionId: 'settings-session',
      createRequestId: () => 'request-batch-1',
    })
    const decisions = [
      { candidateId: 'candidate-6', action: 'approve', resolution: { kind: 'keep-both' } },
      { candidateId: 'candidate-7', action: 'reject' },
    ] as const

    await expect(client.batchDecide(decisions)).resolves.toEqual(expect.objectContaining({
      batch: expect.objectContaining({ results: expect.any(Array) }),
    }))
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'memory/batch',
      {
        sessionId: 'settings-session',
        requestId: 'request-batch-1',
        decisions,
      },
      undefined,
    )
  })

  it('updates approval policy without accepting Owner, Workspace, or settings paths', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-policy',
        },
        approvalPolicy: {
          schemaVersion: 1,
          revision: 2,
          mode: 'scheduled-auto',
          timeZone: 'Asia/Shanghai',
          localTime: '03:30',
        },
      },
    })
    const client = createMemorySettingsClient({ rpc: { call }, sessionId: 'settings-session' })

    await expect(client.updateApprovalPolicy({
      expectedRevision: 1,
      mode: 'scheduled-auto',
      timeZone: 'Asia/Shanghai',
      localTime: '03:30',
    })).resolves.toMatchObject({ approvalPolicy: { revision: 2, mode: 'scheduled-auto' } })
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'settings/approval',
      {
        sessionId: 'settings-session',
        expectedRevision: 1,
        mode: 'scheduled-auto',
        timeZone: 'Asia/Shanghai',
        localTime: '03:30',
      },
      undefined,
    )
  })

  it('updates the Active Space turn-summary policy without accepting a Space or credentials', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-project-alpha',
          access: 'read-write',
          bindingRevision: 'binding-summary-policy',
        },
        turnSummaryPolicy: {
          schemaVersion: 1,
          revision: 1,
          mode: 'dsh-model',
          provider: 'configured-provider',
          model: 'configured-model',
        },
      },
    })
    const client = createMemorySettingsClient({ rpc: { call }, sessionId: 'settings-session' })

    await expect(client.updateTurnSummaryPolicy({
      expectedRevision: 0,
      mode: 'dsh-model',
      provider: 'configured-provider',
      model: 'configured-model',
    })).resolves.toMatchObject({ turnSummaryPolicy: { revision: 1, mode: 'dsh-model' } })
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'summary/update',
      {
        sessionId: 'settings-session',
        expectedRevision: 0,
        mode: 'dsh-model',
        provider: 'configured-provider',
        model: 'configured-model',
      },
      undefined,
    )
  })

  it('replaces sharing policy without accepting Owner or DSH Workspace identity', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: 'space-target',
          access: 'read-write',
          bindingRevision: 'binding-sharing',
        },
        spaces: [
          {
            schemaVersion: 1,
            id: 'space-source',
            ownerId: 'owner-fixture',
            name: 'Source',
            createdAt: '2026-08-21T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            id: 'space-target',
            ownerId: 'owner-fixture',
            name: 'Target',
            createdAt: '2026-08-21T00:00:00.000Z',
          },
        ],
        sharingPolicy: {
          schemaVersion: 1,
          ownerId: 'owner-fixture',
          revision: 'sharing-v2',
          mode: 'selective',
          grants: [{
            id: 'grant-source-to-target',
            sourceSpaceId: 'space-source',
            targetSpaceId: 'space-target',
            memoryKinds: ['summary'],
            visibilities: ['personal'],
          }],
          federations: [],
        },
      },
    })
    const client = createMemorySettingsClient({ rpc: { call }, sessionId: 'settings-session' })
    const update = {
      expectedRevision: 'sharing-v1',
      mode: 'selective' as const,
      grants: [{
        id: 'grant-source-to-target',
        sourceSpaceId: 'space-source',
        targetSpaceId: 'space-target',
        memoryKinds: ['summary' as const],
        visibilities: ['personal' as const],
      }],
      federations: [],
    }

    await expect(client.replaceSharingPolicy(update)).resolves.toMatchObject({
      sharingPolicy: { revision: 'sharing-v2', mode: 'selective' },
    })
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'sharing/replace',
      { sessionId: 'settings-session', ...update },
      undefined,
    )
  })

  it('binds a Space to the Host-resolved current DSH Workspace without browser cwd', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        spaces: [{
          schemaVersion: 1,
          id: 'space-project',
          ownerId: 'owner-fixture',
          name: 'Project',
          createdAt: '2026-08-21T00:00:00.000Z',
        }],
        bindings: [{
          schemaVersion: 1,
          ownerId: 'owner-fixture',
          dshWorkspaceCwd: 'D:\\workspaces\\project',
          spaceId: 'space-project',
          access: 'read-write',
          defaultWrite: true,
          revision: 'binding-v1',
          createdAt: '2026-08-21T00:01:00.000Z',
        }],
      },
    })
    const client = createMemorySettingsClient({ rpc: { call }, sessionId: 'settings-session' })

    await expect(client.bindCurrentDshWorkspace({
      spaceId: 'space-project',
      access: 'read-write',
      defaultWrite: true,
    })).resolves.toMatchObject({ bindings: [{ spaceId: 'space-project' }] })
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/dsh-mmem-settings',
      'spaces/bind',
      {
        sessionId: 'settings-session',
        spaceId: 'space-project',
        access: 'read-write',
        defaultWrite: true,
      },
      undefined,
    )
  })
})
