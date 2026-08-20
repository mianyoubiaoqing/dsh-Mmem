import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  openMemorySpaceArchiveRouter,
  openMemorySpaceCatalog,
} from '../src/index.js'

const access = {
  version: 1,
  ownerId: 'owner-fixture',
  authority: 'local-dsh-host-rpc',
  scope: { version: 1, kind: 'companion-reality' },
  channelDisclosure: 'personal-only',
  requestIntent: 'ordinary',
} as const

describe('MemorySpaceArchiveRouterV1', () => {
  it('persists and recalls memory only through the Active Space resolved from a DSH Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-space-router-'))
    const catalogPath = join(root, 'catalog.json')
    const catalog = await openMemorySpaceCatalog({
      path: catalogPath,
      createId: (() => {
        const ids = ['space-project-alpha', 'binding-project-alpha-v1']
        return () => ids.shift() ?? 'unexpected-id'
      })(),
      now: () => new Date('2026-08-21T21:00:00.000Z'),
    })
    const space = await catalog.createSpace({ ownerId: access.ownerId, name: 'Project Alpha' })
    const sessionHeader = { cwd: 'D:\\workspaces\\project-alpha' }
    await catalog.bindDshWorkspace({
      ownerId: access.ownerId,
      sessionHeader,
      spaceId: space.id,
      access: 'read-write',
      defaultWrite: true,
    })
    const first = await openMemorySpaceArchiveRouter({
      catalog,
      spacesRoot: join(root, 'spaces'),
      now: () => new Date('2026-08-21T21:01:00.000Z'),
    })
    const active = await first.resolveSession({ ownerId: access.ownerId, sessionHeader })
    expect(active.kind).toBe('active')
    if (active.kind !== 'active') throw new Error('expected an Active Space')
    await active.observeExplicit({
      context: access,
      sourceMessageId: 'message-project-alpha-1',
      text: '请记住：Project Alpha uses blue-green deployment.',
      memoryKind: 'summary',
    })
    await first.dispose()

    const reopenedCatalog = await openMemorySpaceCatalog({ path: catalogPath })
    const reopened = await openMemorySpaceArchiveRouter({
      catalog: reopenedCatalog,
      spacesRoot: join(root, 'spaces'),
      now: () => new Date('2026-08-21T21:02:00.000Z'),
    })
    const reopenedActive = await reopened.resolveSession({ ownerId: access.ownerId, sessionHeader })
    expect(reopenedActive.kind).toBe('active')
    if (reopenedActive.kind !== 'active') throw new Error('expected a reopened Active Space')
    const snapshot = await reopenedActive.retrieve({
      context: access,
      query: 'deployment',
      limit: 5,
    })
    expect({
      activeSpace: snapshot.activeSpace,
      items: snapshot.items.map(item => ({
        sourceSpaceId: item.sourceSpaceId,
        content: item.memory.content,
      })),
    }).toEqual({
      activeSpace: {
        spaceId: 'space-project-alpha',
        access: 'read-write',
        bindingRevision: 'binding-project-alpha-v1',
      },
      items: [{
        sourceSpaceId: 'space-project-alpha',
        content: 'Project Alpha uses blue-green deployment.',
      }],
    })
    await reopened.dispose()
  })

  it('fails closed when a read-only Active Space is used for writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-read-only-space-'))
    const catalog = await openMemorySpaceCatalog({
      path: join(root, 'catalog.json'),
      createId: (() => {
        const ids = ['space-standards', 'binding-standards-v1']
        return () => ids.shift() ?? 'unexpected-id'
      })(),
    })
    const standards = await catalog.createSpace({ ownerId: access.ownerId, name: 'Standards' })
    const sessionHeader = { cwd: 'D:\\workspaces\\project-alpha' }
    await catalog.bindDshWorkspace({
      ownerId: access.ownerId,
      sessionHeader,
      spaceId: standards.id,
      access: 'read',
      defaultWrite: false,
    })
    const router = await openMemorySpaceArchiveRouter({ catalog, spacesRoot: join(root, 'spaces') })
    const active = await router.resolveSession({
      ownerId: access.ownerId,
      sessionHeader,
      requestedSpaceId: standards.id,
    })
    expect(active.kind).toBe('active')
    if (active.kind !== 'active') throw new Error('expected a read-only Active Space')

    await expect(active.observeExplicit({
      context: access,
      sourceMessageId: 'message-standards-1',
      text: '请记住：Standards are reviewed manually.',
      memoryKind: 'summary',
    })).rejects.toMatchObject({ code: 'MEMORY_SPACE_READ_ONLY' })
    await router.dispose()
  })

  it('cannot reopen a Space Archive through a disposed Router', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-disposed-router-'))
    const catalog = await openMemorySpaceCatalog({
      path: join(root, 'catalog.json'),
      createId: (() => {
        const ids = ['space-project', 'binding-project-v1']
        return () => ids.shift() ?? 'unexpected-id'
      })(),
    })
    const space = await catalog.createSpace({ ownerId: access.ownerId, name: 'Project' })
    const sessionHeader = { cwd: 'D:\\workspaces\\project' }
    await catalog.bindDshWorkspace({
      ownerId: access.ownerId,
      sessionHeader,
      spaceId: space.id,
      access: 'read-write',
      defaultWrite: true,
    })
    const router = await openMemorySpaceArchiveRouter({ catalog, spacesRoot: join(root, 'spaces') })
    await router.dispose()

    await expect(router.resolveSession({
      ownerId: access.ownerId,
      sessionHeader,
    })).rejects.toMatchObject({ code: 'MEMORY_SPACE_ROUTER_DISPOSED' })
  })
})
