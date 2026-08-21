import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PrincipalLocalPlugin from '../src/principal-local.js'
import { describe, expect, it } from 'vitest'
import * as MemoryPlugin from '../src/index.js'
import * as MemorySettingsHost from '../src/settings-host.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

type FixtureRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<unknown>

describe('dsh-Mmem Settings Host RPC', () => {
  it('creates a Memory Space and binds it to the current live DSH Workspace without browser cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-space-onboarding-'))
    let registration: { handler: FixtureRpcHandler } | undefined
    const connection = {
      rpc: {
        handle(_channel: string, handler: FixtureRpcHandler) {
          registration = { handler }
          return async () => {}
        },
      },
    }
    const ctx = new Context()
    ctx.effect(() => ctx.provide('connection', connection as never), 'fixture Connection RPC')
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PrincipalLocalPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, {
      spaceCatalogPath: join(root, 'catalog.json'),
      spacesRoot: join(root, 'spaces'),
      settingsPath: join(root, 'settings.json'),
    })
    await ctx.plugin(MemorySettingsHost)
    const cwd = 'D:\\workspaces\\new-project'
    const session = ctx.sessions.create(SessionId('space-onboarding-session'), { meta: { cwd } })
    if (registration === undefined) throw new Error('expected Settings RPC registration')

    await expect(registration.handler('memory/search', {
      sessionId: String(session.id),
      recordStatus: 'all',
      candidateStatus: 'pending',
      limit: 200,
    }, new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'active-space-unavailable',
        message: 'The current DSH Workspace has no default Memory Space.',
        details: { reason: 'default-write-space-unavailable' },
      },
    })
    await expect(registration.handler('spaces/get', {
      sessionId: String(session.id),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: { schemaVersion: 1, spaces: [], bindings: [] },
    })
    const created = await registration.handler('spaces/create', {
      sessionId: String(session.id),
      name: 'New Project',
    }, new AbortController().signal) as {
      ok: true
      value: { spaces: Array<{ id: string }> }
    }
    expect(created).toMatchObject({
      ok: true,
      value: { spaces: [{ name: 'New Project' }], bindings: [] },
    })
    const spaceId = created.value.spaces[0]?.id
    if (spaceId === undefined) throw new Error('expected created Space id')
    await expect(registration.handler('spaces/bind', {
      sessionId: String(session.id),
      spaceId,
      access: 'read-write',
      defaultWrite: true,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        spaces: [{ id: spaceId }],
        bindings: [{
          spaceId,
          dshWorkspaceCwd: cwd,
          access: 'read-write',
          defaultWrite: true,
        }],
      },
    })
    await expect(registration.handler('spaces/bind', {
      sessionId: String(session.id),
      ownerId: 'browser-owner',
      cwd: 'D:\\browser-controlled',
      spaceId,
      access: 'read-write',
      defaultWrite: true,
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
  })

  it('reviews Candidates in the live DSH Session Active Space over a loopback-only channel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-settings-host-'))
    let registration: {
      channel: string
      handler: FixtureRpcHandler
      options: { authority: 'loopback' }
    } | undefined
    const connection = {
      rpc: {
        handle(channel: string, handler: FixtureRpcHandler, options: { authority: 'loopback' }) {
          registration = { channel, handler, options }
          return async () => {}
        },
        intercept() {
          throw new Error('the Memory Settings Host must not intercept DSH /api')
        },
      },
    }
    const ctx = new Context()
    ctx.effect(() => ctx.provide('connection', connection as never), 'fixture Connection RPC')
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
  await ctx.plugin(PrincipalLocalPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, {
      spaceCatalogPath: join(root, 'catalog.json'),
      spaceSharingPath: join(root, 'sharing.json'),
      spacesRoot: join(root, 'spaces'),
      settingsPath: join(root, 'settings', 'settings.json'),
    })
    await ctx.plugin(MemorySettingsHost)
    const cwd = 'D:\\workspaces\\project-alpha'
    const session = ctx.sessions.create(SessionId('settings-session'), { meta: { cwd } })
    const space = await ctx.dshMmemSpaceCatalog.createSpace({
      ownerId: 'owner-fixture',
      name: 'Project Alpha',
    })
    const binding = await ctx.dshMmemSpaceCatalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: session.header,
      spaceId: space.id,
      access: 'read-write',
      defaultWrite: true,
    })
    const active = await ctx.dshMmemSpaceRouter.resolveSession({
      ownerId: 'owner-fixture',
      sessionHeader: session.header,
    })
    if (active.kind !== 'active') throw new Error('expected an Active Space')
    const candidate = await active.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-settings-host-candidate-1',
      content: '设置页显示这个中性候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })

    expect(registration).toMatchObject({
      channel: '/dsh-mmem-settings',
      options: { authority: 'loopback' },
    })
    if (registration === undefined) throw new Error('expected the Settings RPC registration')
    await expect(registration.handler('settings/get', {
      sessionId: String(session.id),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: { spaceId: space.id, bindingRevision: binding.revision },
          approvalPolicy: { schemaVersion: 1, revision: 0, mode: 'scheduled-auto' },
      },
    })
    await expect(registration.handler('settings/approval', {
      sessionId: String(session.id),
      expectedRevision: 0,
      mode: 'scheduled-auto',
      timeZone: 'Asia/Shanghai',
      localTime: '03:30',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: { spaceId: space.id, bindingRevision: binding.revision },
        approvalPolicy: {
          schemaVersion: 1,
          revision: 1,
          mode: 'scheduled-auto',
          timeZone: 'Asia/Shanghai',
          localTime: '03:30',
        },
      },
    })
    await expect(registration.handler('summary/get', {
      sessionId: String(session.id),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        activeSpace: { spaceId: space.id },
        turnSummaryPolicy: { schemaVersion: 1, revision: 0, mode: 'local-deterministic' },
      },
    })
    await expect(registration.handler('summary/update', {
      sessionId: String(session.id),
      expectedRevision: 0,
      mode: 'dsh-model',
      provider: 'configured-provider',
      model: 'configured-model',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        activeSpace: { spaceId: space.id },
        turnSummaryPolicy: {
          schemaVersion: 1,
          revision: 1,
          mode: 'dsh-model',
          provider: 'configured-provider',
          model: 'configured-model',
        },
      },
    })
    const readOnlySpace = await ctx.dshMmemSpaceCatalog.createSpace({
      ownerId: 'owner-fixture',
      name: 'Read Only Policy Receipt',
    })
    await ctx.dshMmemSpaceCatalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: session.header,
      spaceId: readOnlySpace.id,
      access: 'read',
      defaultWrite: false,
    })
    await expect(registration.handler('sharing/get', {
      sessionId: String(session.id),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: { spaceId: space.id, bindingRevision: binding.revision },
        spaces: [
          { id: space.id, name: 'Project Alpha' },
          { id: readOnlySpace.id, name: 'Read Only Policy Receipt' },
        ],
        sharingPolicy: { revision: '0', mode: 'isolated', grants: [], federations: [] },
      },
    })
    await expect(registration.handler('sharing/replace', {
      sessionId: String(session.id),
      expectedRevision: '0',
      mode: 'selective',
      grants: [{
        id: 'grant-read-only-to-project',
        sourceSpaceId: readOnlySpace.id,
        targetSpaceId: space.id,
        memoryKinds: ['summary'],
        visibilities: ['personal'],
      }],
      federations: [],
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        activeSpace: { spaceId: space.id },
        sharingPolicy: {
          revision: expect.not.stringMatching(/^0$/u),
          mode: 'selective',
          grants: [{ id: 'grant-read-only-to-project' }],
        },
      },
    })
    await expect(registration.handler('sharing/replace', {
      sessionId: String(session.id),
      ownerId: 'browser-must-not-select-owner',
      expectedRevision: '0',
      mode: 'isolated',
      grants: [],
      federations: [],
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    await expect(registration.handler('sharing/replace', {
      sessionId: String(session.id),
      expectedRevision: '0',
      mode: 'isolated',
      grants: [],
      federations: [],
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'settings-revision-conflict' },
    })
    await expect(registration.handler('sharing/replace', {
      sessionId: String(session.id),
      requestedSpaceId: readOnlySpace.id,
      expectedRevision: 'stale-is-irrelevant-for-read-only',
      mode: 'isolated',
      grants: [],
      federations: [],
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: expect.stringContaining('read-write') },
    })
    await expect(registration.handler('settings/approval', {
      sessionId: String(session.id),
      requestedSpaceId: readOnlySpace.id,
      expectedRevision: 1,
      mode: 'manual',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: expect.stringContaining('read-write') },
    })
    await expect(registration.handler('summary/update', {
      sessionId: String(session.id),
      requestedSpaceId: readOnlySpace.id,
      expectedRevision: 0,
      mode: 'dsh-model',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: expect.stringContaining('read-write') },
    })
    await expect(registration.handler('candidates/list', {
      sessionId: String(session.id),
      ownerId: 'browser-must-not-select-owner',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    await expect(registration.handler('candidates/list', {
      sessionId: 'missing-live-session',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'session-not-found',
        details: { sessionId: 'missing-live-session' },
      },
    })
    await expect(registration.handler('candidates/list', {
      sessionId: String(session.id),
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        candidates: [expect.objectContaining({ id: candidate.id, status: 'pending' })],
      },
    })

    await expect(registration.handler('candidates/approve', {
      sessionId: String(session.id),
      candidateId: candidate.id,
      requestId: 'settings-approve-1',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        memory: expect.objectContaining({
          content: '设置页显示这个中性候选。',
          status: 'confirmed',
        }),
      },
    })
    expect(active.recall({
      context: PERSONAL_COMPANION_ACCESS,
      query: '设置页',
      limit: 5,
    })).toEqual([
      expect.objectContaining({ content: '设置页显示这个中性候选。', status: 'confirmed' }),
    ])

    const rejectedCandidate = await active.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-settings-host-candidate-2',
      content: '这个候选不应进入召回。',
      visibility: 'personal',
      memoryKind: 'summary',
    })
    await expect(registration.handler('candidates/reject', {
      sessionId: String(session.id),
      candidateId: rejectedCandidate.id,
      requestId: 'settings-reject-1',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        candidate: expect.objectContaining({
          id: rejectedCandidate.id,
          status: 'rejected',
        }),
      },
    })
    expect(active.recall({
      context: PERSONAL_COMPANION_ACCESS,
      query: '不应进入召回',
      limit: 5,
    })).toEqual([])

    await expect(registration.handler('memory/search', {
      sessionId: String(session.id),
      query: '设置页',
      memoryKind: 'summary',
      visibility: 'personal',
      recordStatus: 'active',
      candidateStatus: 'all',
      limit: 10,
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        management: {
          schemaVersion: 1,
          records: [expect.objectContaining({
            content: '设置页显示这个中性候选。',
            status: 'confirmed',
          })],
          candidates: [expect.objectContaining({
            id: candidate.id,
            status: 'approved',
          })],
          audit: [],
        },
      },
    })
    await expect(registration.handler('memory/source', {
      sessionId: String(session.id),
      entity: 'candidate',
      id: candidate.id,
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        source: expect.objectContaining({
          schemaVersion: 1,
          entity: 'candidate',
          id: candidate.id,
        }),
      },
    })
    const duplicateCandidate = await active.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-settings-host-candidate-3',
      content: '设置页显示这个中性候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })
    await expect(registration.handler('memory/assess', {
      sessionId: String(session.id),
      candidateId: duplicateCandidate.id,
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        assessment: expect.objectContaining({
          schemaVersion: 1,
          candidateId: duplicateCandidate.id,
          relationships: [expect.objectContaining({
            relation: 'duplicate',
            reason: 'exact-normalized-match',
          })],
        }),
      },
    })
    const resolvedCandidate = await active.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-settings-host-candidate-resolution',
      content: '设置页显示这个中性候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })
    const existingMemory = active.list({ context: PERSONAL_COMPANION_ACCESS })[0]
    if (existingMemory === undefined) throw new Error('expected approved Memory for relationship target')
    await expect(registration.handler('candidates/approve', {
      sessionId: String(session.id),
      candidateId: resolvedCandidate.id,
      requestId: 'settings-approve-resolution-1',
      resolution: { kind: 'keep-both' },
      relationships: [{ targetMemoryId: existingMemory.id, relation: 'related-to' }],
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        memory: expect.objectContaining({
          sourceCandidateId: resolvedCandidate.id,
          status: 'confirmed',
        }),
      },
    })
    await expect(registration.handler('relationships/list', {
      sessionId: String(session.id),
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: { spaceId: space.id },
        relationships: [{
          targetMemoryId: existingMemory.id,
          relation: 'related-to',
          sourceCandidateId: resolvedCandidate.id,
        }],
      },
    })
    const editResult = await registration.handler('memory/edit', {
      sessionId: String(session.id),
      requestId: 'settings-edit-1',
      candidateIds: [duplicateCandidate.id],
      content: '编辑后的独立候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    }, new AbortController().signal)
    expect(editResult).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        candidate: expect.objectContaining({
          content: '编辑后的独立候选。',
          status: 'pending',
        }),
      },
    })
    const editedCandidate = active.listCandidates({ context: PERSONAL_COMPANION_ACCESS })
      .find(item => item.content === '编辑后的独立候选。')
    if (editedCandidate === undefined) throw new Error('expected the edited Candidate')
    const mergePartner = await active.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-settings-host-candidate-4',
      content: '待合并的另一个候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })
    await expect(registration.handler('memory/merge', {
      sessionId: String(session.id),
      requestId: 'settings-merge-1',
      candidateIds: [editedCandidate.id, mergePartner.id],
      content: '合并后的治理候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        candidate: expect.objectContaining({
          content: '合并后的治理候选。',
          status: 'pending',
        }),
      },
    })
    const mergedCandidate = active.listCandidates({ context: PERSONAL_COMPANION_ACCESS })
      .find(item => item.content === '合并后的治理候选。')
    if (mergedCandidate === undefined) throw new Error('expected the merged Candidate')
    await expect(registration.handler('memory/batch', {
      sessionId: String(session.id),
      requestId: 'settings-batch-1',
      decisions: [{ candidateId: mergedCandidate.id, action: 'reject' }],
    }, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        activeSpace: {
          spaceId: space.id,
          access: 'read-write',
          bindingRevision: binding.revision,
        },
        batch: {
          schemaVersion: 1,
          results: [{ candidateId: mergedCandidate.id, status: 'succeeded' }],
        },
      },
    })
  })
})
