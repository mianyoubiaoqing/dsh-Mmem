import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  openMemorySpaceArchiveRouter,
  openMemorySpaceCatalog,
  openMemorySpaceSharingCatalog,
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

  it('returns direct Borrowed Recall with its Grant receipt and filters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-borrowed-recall-'))
    const ids = ['space-active', 'space-source', 'binding-active-v1', 'binding-source-v1']
    const catalog = await openMemorySpaceCatalog({
      path: join(root, 'catalog.json'),
      createId: () => ids.shift() ?? `archive-${ids.length}`,
      now: () => new Date('2026-08-21T22:00:00.000Z'),
    })
    const activeSpace = await catalog.createSpace({ ownerId: access.ownerId, name: 'Active' })
    const sourceSpace = await catalog.createSpace({ ownerId: access.ownerId, name: 'Source' })
    const sessionHeader = { cwd: 'D:\\workspaces\\shared-recall' }
    await catalog.bindDshWorkspace({
      ownerId: access.ownerId,
      sessionHeader,
      spaceId: activeSpace.id,
      access: 'read-write',
      defaultWrite: true,
    })
    await catalog.bindDshWorkspace({
      ownerId: access.ownerId,
      sessionHeader,
      spaceId: sourceSpace.id,
      access: 'read-write',
      defaultWrite: false,
    })
    const sharing = await openMemorySpaceSharingCatalog({
      path: join(root, 'sharing.json'),
      spaces: catalog,
      createRevision: () => 'sharing-v1',
    })
    await sharing.replacePolicy({
      ownerId: access.ownerId,
      expectedRevision: '0',
      mode: 'selective',
      grants: [{
        id: 'grant-source-to-active',
        sourceSpaceId: sourceSpace.id,
        targetSpaceId: activeSpace.id,
        memoryKinds: ['preference'],
        visibilities: ['personal'],
      }],
      federations: [],
    })
    const router = await openMemorySpaceArchiveRouter({
      catalog,
      sharing,
      spacesRoot: join(root, 'spaces'),
      now: () => new Date('2026-08-21T22:01:00.000Z'),
    })
    const source = await router.resolveSession({
      ownerId: access.ownerId,
      sessionHeader,
      requestedSpaceId: sourceSpace.id,
    })
    if (source.kind !== 'active') throw new Error('expected Source Space')
    const borrowedMemory = await source.observeExplicit({
      context: access,
      sourceMessageId: 'message-source-preference',
      text: '请记住：The coding style uses tabs.',
      memoryKind: 'preference',
    })
    await source.observeExplicit({
      context: access,
      sourceMessageId: 'message-source-summary',
      text: '请记住：The coding style summary is not shared.',
      memoryKind: 'summary',
    })
    const active = await router.resolveSession({ ownerId: access.ownerId, sessionHeader })
    if (active.kind !== 'active') throw new Error('expected Active Space')
    await active.observeExplicit({
      context: access,
      sourceMessageId: 'message-active-summary',
      text: '请记住：The coding style requires review.',
      memoryKind: 'summary',
    })

    const snapshot = await active.retrieve({ context: access, query: 'coding style', limit: 5 })
    expect(snapshot.items.map(item => ({
      content: item.memory.content,
      sourceSpaceId: item.sourceSpaceId,
      authorization: item.authorization,
    }))).toEqual(expect.arrayContaining([
      {
        content: 'The coding style requires review.',
        sourceSpaceId: 'space-active',
        authorization: undefined,
      },
      {
        content: 'The coding style uses tabs.',
        sourceSpaceId: 'space-source',
        authorization: {
          kind: 'space-share-grant',
          relationId: 'grant-source-to-active',
          policyRevision: 'sharing-v1',
          memoryKinds: ['preference'],
          visibilities: ['personal'],
        },
      },
    ]))
    expect(snapshot.items.map(item => item.memory.content)).not.toContain(
      'The coding style summary is not shared.',
    )
    expect((await active.retrieve({
      context: access,
      query: 'coding style',
      limit: 1,
      maxCharacters: 100_000,
    })).items).toHaveLength(1)
    expect((await active.retrieve({
      context: access,
      query: 'coding style',
      memoryKinds: ['summary'],
    })).items.map(item => item.memory.content)).toEqual([
      'The coding style requires review.',
    ])
    if (borrowedMemory === undefined) throw new Error('expected borrowed memory fixture')
    await expect(active.forget({
      context: access,
      memoryId: borrowedMemory.id,
      sourceMessageId: 'attempt-borrowed-mutation',
    })).rejects.toThrow()
    await router.dispose()
  })
})
