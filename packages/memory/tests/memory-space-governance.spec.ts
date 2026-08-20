import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as IdentityPlugin from '@mistymoon/dsh-identity'
import { describe, expect, it } from 'vitest'
import * as MemoryPlugin from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

describe('MemorySpaceGovernanceResolverV1', () => {
  it('reviews a pending Candidate in the Active Space without accepting an Owner parameter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-space-governance-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, {
      spaceCatalogPath: join(root, 'catalog.json'),
      spacesRoot: join(root, 'spaces'),
    })
    const sessionHeader = { cwd: 'D:\\workspaces\\project-alpha' }
    const space = await ctx.dshMmemSpaceCatalog.createSpace({
      ownerId: 'owner-fixture',
      name: 'Project Alpha',
    })
    await ctx.dshMmemSpaceCatalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader,
      spaceId: space.id,
      access: 'read-write',
      defaultWrite: true,
    })
    const active = await ctx.dshMmemSpaceRouter.resolveSession({
      ownerId: 'owner-fixture',
      sessionHeader,
    })
    if (active.kind !== 'active') throw new Error('expected an Active Space')
    const candidate = await active.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-governance-candidate-1',
      content: 'Project Alpha 使用蓝绿部署。',
      visibility: 'personal',
      memoryKind: 'summary',
    })

    const governance = await ctx.dshMmemSpaceGovernance.resolve({ sessionHeader })
    expect(governance).toMatchObject({
      schemaVersion: 1,
      spaceId: space.id,
      access: 'read-write',
    })
    expect(governance.listCandidates()).toEqual([
      expect.objectContaining({ id: candidate.id, status: 'pending' }),
    ])
    await governance.approveCandidate({
      candidateId: candidate.id,
      sourceMessageId: 'settings-approve-1',
    })
    expect(active.recall({
      context: PERSONAL_COMPANION_ACCESS,
      query: '蓝绿部署',
      limit: 5,
    })).toEqual([
      expect.objectContaining({ content: 'Project Alpha 使用蓝绿部署。', status: 'confirmed' }),
    ])
  })

  it('allows inspection but fails closed when Settings tries to approve in a read-only Space', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-read-only-governance-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, {
      spaceCatalogPath: join(root, 'catalog.json'),
      spacesRoot: join(root, 'spaces'),
    })
    const seedHeader = { cwd: 'D:\\workspaces\\standards-owner' }
    const readOnlyHeader = { cwd: 'D:\\workspaces\\project-alpha' }
    const space = await ctx.dshMmemSpaceCatalog.createSpace({
      ownerId: 'owner-fixture',
      name: 'Engineering Standards',
    })
    await ctx.dshMmemSpaceCatalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: seedHeader,
      spaceId: space.id,
      access: 'read-write',
      defaultWrite: true,
    })
    await ctx.dshMmemSpaceCatalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader: readOnlyHeader,
      spaceId: space.id,
      access: 'read',
      defaultWrite: false,
    })
    const writable = await ctx.dshMmemSpaceRouter.resolveSession({
      ownerId: 'owner-fixture',
      sessionHeader: seedHeader,
    })
    if (writable.kind !== 'active') throw new Error('expected a writable Active Space')
    const candidate = await writable.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-read-only-candidate-1',
      content: '工程标准候选需要人工审核。',
      visibility: 'personal',
      memoryKind: 'summary',
    })

    const governance = await ctx.dshMmemSpaceGovernance.resolve({
      sessionHeader: readOnlyHeader,
      requestedSpaceId: space.id,
    })
    expect(governance.listCandidates()).toEqual([
      expect.objectContaining({ id: candidate.id, status: 'pending' }),
    ])
    await expect(governance.approveCandidate({
      candidateId: candidate.id,
      sourceMessageId: 'settings-read-only-approve-1',
    })).rejects.toMatchObject({ code: 'MEMORY_SPACE_READ_ONLY' })
  })

  it('reports a stable unavailable error for an unbound DSH Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-unbound-governance-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, {
      spaceCatalogPath: join(root, 'catalog.json'),
      spacesRoot: join(root, 'spaces'),
    })

    await expect(ctx.dshMmemSpaceGovernance.resolve({
      sessionHeader: { cwd: 'D:\\workspaces\\unbound' },
    })).rejects.toMatchObject({
      code: 'MEMORY_SPACE_GOVERNANCE_UNAVAILABLE',
      reason: 'default-write-space-unavailable',
    })
  })

  it('never lists Candidates from another Space bound to the same DSH Workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mmem-isolated-governance-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, {
      spaceCatalogPath: join(root, 'catalog.json'),
      spacesRoot: join(root, 'spaces'),
    })
    const sessionHeader = { cwd: 'D:\\workspaces\\shared-bindings' }
    const project = await ctx.dshMmemSpaceCatalog.createSpace({
      ownerId: 'owner-fixture',
      name: 'Project',
    })
    const privateNotes = await ctx.dshMmemSpaceCatalog.createSpace({
      ownerId: 'owner-fixture',
      name: 'Private Notes',
    })
    await ctx.dshMmemSpaceCatalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader,
      spaceId: project.id,
      access: 'read-write',
      defaultWrite: true,
    })
    await ctx.dshMmemSpaceCatalog.bindDshWorkspace({
      ownerId: 'owner-fixture',
      sessionHeader,
      spaceId: privateNotes.id,
      access: 'read-write',
      defaultWrite: false,
    })
    const projectArchive = await ctx.dshMmemSpaceRouter.resolveSession({
      ownerId: 'owner-fixture',
      sessionHeader,
    })
    const privateArchive = await ctx.dshMmemSpaceRouter.resolveSession({
      ownerId: 'owner-fixture',
      sessionHeader,
      requestedSpaceId: privateNotes.id,
    })
    if (projectArchive.kind !== 'active' || privateArchive.kind !== 'active') {
      throw new Error('expected both bound Spaces to resolve')
    }
    const projectCandidate = await projectArchive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-project-candidate-1',
      content: '项目空间候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })
    const privateCandidate = await privateArchive.propose({
      context: PERSONAL_COMPANION_ACCESS,
      sourceMessageId: 'message-private-candidate-1',
      content: '私有空间候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })

    const governance = await ctx.dshMmemSpaceGovernance.resolve({ sessionHeader })
    expect(governance.listCandidates().map(candidate => candidate.id)).toEqual([projectCandidate.id])
    expect(governance.listCandidates().map(candidate => candidate.id)).not.toContain(privateCandidate.id)
  })
})
