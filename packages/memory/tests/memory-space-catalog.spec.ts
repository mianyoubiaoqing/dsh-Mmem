import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openMemorySpaceCatalog } from '../src/index.js'

describe('MemorySpaceCatalogV1', () => {
  it('persists an Owner-created Memory Space across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-space-catalog-'))
    const path = join(root, 'catalog.json')
    const first = await openMemorySpaceCatalog({
      path,
      createId: () => 'space-engineering-standards',
      now: () => new Date('2026-08-21T18:00:00.000Z'),
    })

    await expect(first.createSpace({
      ownerId: 'owner-fixture',
      name: 'Engineering Standards',
    })).resolves.toEqual({
      schemaVersion: 1,
      id: 'space-engineering-standards',
      ownerId: 'owner-fixture',
      name: 'Engineering Standards',
      createdAt: '2026-08-21T18:00:00.000Z',
    })

    const reopened = await openMemorySpaceCatalog({ path })
    await expect(reopened.inspect({ ownerId: 'owner-fixture' })).resolves.toEqual({
      schemaVersion: 1,
      ownerId: 'owner-fixture',
      spaces: [{
        schemaVersion: 1,
        id: 'space-engineering-standards',
        ownerId: 'owner-fixture',
        name: 'Engineering Standards',
        createdAt: '2026-08-21T18:00:00.000Z',
      }],
    })
  })

  it('resolves the same default Space for DSH Sessions with the same exact cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-workspace-binding-'))
    const path = join(root, 'catalog.json')
    const ids = ['space-project-alpha', 'binding-project-alpha-v1']
    const first = await openMemorySpaceCatalog({
      path,
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-21T18:30:00.000Z'),
    })
    const space = await first.createSpace({
      ownerId: 'owner-fixture',
      name: 'Project Alpha',
    })

    await expect(first.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: { cwd: 'D:\\workspaces\\project-alpha' },
      spaceId: space.id,
      access: 'read-write',
      defaultWrite: true,
    })).resolves.toEqual({
      schemaVersion: 1,
      ownerId: 'owner-fixture',
      dshWorkspaceCwd: 'D:\\workspaces\\project-alpha',
      spaceId: 'space-project-alpha',
      access: 'read-write',
      defaultWrite: true,
      revision: 'binding-project-alpha-v1',
      createdAt: '2026-08-21T18:30:00.000Z',
    })

    const reopened = await openMemorySpaceCatalog({ path })
    await expect(reopened.resolveActiveSpace({
      ownerId: 'owner-fixture',
      sessionHeader: { cwd: 'D:\\workspaces\\project-alpha' },
    })).resolves.toEqual({
      schemaVersion: 1,
      kind: 'active',
      spaceId: 'space-project-alpha',
      access: 'read-write',
      bindingRevision: 'binding-project-alpha-v1',
    })
  })

  it('fails closed when a Binding request has no DSH Workspace evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-missing-workspace-'))
    const catalog = await openMemorySpaceCatalog({
      path: join(root, 'catalog.json'),
      createId: () => 'space-private',
      now: () => new Date('2026-08-21T19:00:00.000Z'),
    })
    const space = await catalog.createSpace({ ownerId: 'owner-fixture', name: 'Private' })

    await expect(catalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: {},
      spaceId: space.id,
      access: 'read-write',
      defaultWrite: true,
    })).rejects.toMatchObject({ code: 'DSH_WORKSPACE_UNAVAILABLE' })
  })

  it('allows an Owner to select a non-default read-only Space bound to the same DSH Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-multiple-spaces-'))
    const ids = ['space-project', 'space-standards', 'binding-project-v1', 'binding-standards-v1']
    const catalog = await openMemorySpaceCatalog({
      path: join(root, 'catalog.json'),
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-21T19:30:00.000Z'),
    })
    const project = await catalog.createSpace({ ownerId: 'owner-fixture', name: 'Project Alpha' })
    const standards = await catalog.createSpace({ ownerId: 'owner-fixture', name: 'Engineering Standards' })
    const sessionHeader = { cwd: 'D:\\workspaces\\project-alpha' }
    await catalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader,
      spaceId: project.id,
      access: 'read-write',
      defaultWrite: true,
    })
    await catalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader,
      spaceId: standards.id,
      access: 'read',
      defaultWrite: false,
    })

    await expect(catalog.resolveActiveSpace({
      ownerId: 'owner-fixture',
      sessionHeader,
      requestedSpaceId: standards.id,
    })).resolves.toEqual({
      schemaVersion: 1,
      kind: 'active',
      spaceId: 'space-standards',
      access: 'read',
      bindingRevision: 'binding-standards-v1',
    })
  })

  it('lists one shared Memory Space bound to multiple DSH Workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-shared-space-'))
    const ids = ['space-standards', 'binding-frontend-v1', 'binding-backend-v1']
    const catalog = await openMemorySpaceCatalog({
      path: join(root, 'catalog.json'),
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-21T20:00:00.000Z'),
    })
    const standards = await catalog.createSpace({
      ownerId: 'owner-fixture',
      name: 'Engineering Standards',
    })
    await catalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: { cwd: 'D:\\workspaces\\frontend' },
      spaceId: standards.id,
      access: 'read-write',
      defaultWrite: true,
    })
    await catalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: { cwd: 'D:\\workspaces\\backend' },
      spaceId: standards.id,
      access: 'read-write',
      defaultWrite: true,
    })

    await expect(catalog.listBindings({ ownerId: 'owner-fixture' })).resolves.toEqual({
      schemaVersion: 1,
      ownerId: 'owner-fixture',
      bindings: [
        {
          schemaVersion: 1,
          ownerId: 'owner-fixture',
          dshWorkspaceCwd: 'D:\\workspaces\\frontend',
          spaceId: 'space-standards',
          access: 'read-write',
          defaultWrite: true,
          revision: 'binding-frontend-v1',
          createdAt: '2026-08-21T20:00:00.000Z',
        },
        {
          schemaVersion: 1,
          ownerId: 'owner-fixture',
          dshWorkspaceCwd: 'D:\\workspaces\\backend',
          spaceId: 'space-standards',
          access: 'read-write',
          defaultWrite: true,
          revision: 'binding-backend-v1',
          createdAt: '2026-08-21T20:00:00.000Z',
        },
      ],
    })
  })

  it('preserves concurrent Space creation across Catalog instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-concurrent-catalog-'))
    const path = join(root, 'catalog.json')
    const first = await openMemorySpaceCatalog({
      path,
      createId: () => 'space-frontend',
      now: () => new Date('2026-08-21T20:30:00.000Z'),
    })
    const second = await openMemorySpaceCatalog({
      path,
      createId: () => 'space-backend',
      now: () => new Date('2026-08-21T20:30:01.000Z'),
    })

    await Promise.all([
      first.createSpace({ ownerId: 'owner-fixture', name: 'Frontend' }),
      second.createSpace({ ownerId: 'owner-fixture', name: 'Backend' }),
    ])

    const reopened = await openMemorySpaceCatalog({ path })
    const snapshot = await reopened.inspect({ ownerId: 'owner-fixture' })
    expect(snapshot.spaces.map(space => space.name).sort()).toEqual(['Backend', 'Frontend'])
  })

  it('reads Catalog changes committed by another long-running instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-catalog-refresh-'))
    const path = join(root, 'catalog.json')
    const first = await openMemorySpaceCatalog({ path, createId: () => 'space-first' })
    const second = await openMemorySpaceCatalog({ path, createId: () => 'space-second' })
    await first.createSpace({ ownerId: 'owner-fixture', name: 'First' })
    await second.createSpace({ ownerId: 'owner-fixture', name: 'Second' })

    const snapshot = await first.inspect({ ownerId: 'owner-fixture' })
    expect(snapshot.spaces.map(space => space.name)).toEqual(['First', 'Second'])
  })

  it('rejects a second Default Write Space for the same DSH Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-unique-default-'))
    const ids = ['space-first', 'space-second', 'binding-first-v1']
    const catalog = await openMemorySpaceCatalog({
      path: join(root, 'catalog.json'),
      createId: () => ids.shift() ?? 'unexpected-id',
    })
    const first = await catalog.createSpace({ ownerId: 'owner-fixture', name: 'First' })
    const second = await catalog.createSpace({ ownerId: 'owner-fixture', name: 'Second' })
    const sessionHeader = { cwd: 'D:\\workspaces\\shared' }
    await catalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader,
      spaceId: first.id,
      access: 'read-write',
      defaultWrite: true,
    })

    await expect(catalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader,
      spaceId: second.id,
      access: 'read-write',
      defaultWrite: true,
    })).rejects.toMatchObject({ code: 'DEFAULT_WRITE_SPACE_ALREADY_BOUND' })
  })
})
