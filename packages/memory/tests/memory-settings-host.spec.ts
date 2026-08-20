import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as IdentityPlugin from '@mistymoon/dsh-identity'
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
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, {
      spaceCatalogPath: join(root, 'catalog.json'),
      spacesRoot: join(root, 'spaces'),
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
  })
})
