import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive } from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

async function pending(archive: Awaited<ReturnType<typeof openMemoryArchive>>, source: string, content: string) {
  return archive.propose({
    context: PERSONAL_COMPANION_ACCESS,
    sourceMessageId: source,
    content,
    visibility: 'personal',
    memoryKind: 'summary',
  })
}

describe('candidate edit and merge governance', () => {
  it('edits by appending one pending revision and exposes a payload-free audit row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-candidate-edit-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({
      path,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const source = await pending(archive, 'candidate-source', '中性原候选。')
    const revisionInput = {
      context: PERSONAL_COMPANION_ACCESS,
      candidateIds: [source.id],
      sourceMessageId: 'edit-request',
      content: '中性编辑后候选。',
      visibility: 'personal' as const,
      memoryKind: 'summary' as const,
    }
    const revised = await archive.editCandidate(revisionInput)
    const retry = await archive.editCandidate(revisionInput)

    expect(retry.id).toBe(revised.id)
    expect(revised).toMatchObject({ status: 'pending', sourceCandidateIds: [source.id] })
    expect(archive.listCandidates({ context: PERSONAL_COMPANION_ACCESS, includeResolved: true }))
      .toEqual(expect.arrayContaining([revised, expect.objectContaining({ id: source.id, status: 'superseded' })]))
    const audit = archive.listGovernanceAudit({ context: PERSONAL_COMPANION_ACCESS })
    expect(audit).toEqual([{
      schemaVersion: 1,
      action: 'candidate-edited',
      sourceCandidateIds: [source.id],
      resultCandidateId: revised.id,
      createdAt: '2026-08-20T12:00:00.000Z',
      sourceMessageId: 'edit-request',
    }])
    expect(JSON.stringify(audit)).not.toContain('中性编辑后候选')
    expect((await readFile(path, 'utf8')).trim().split(/\r?\n/u)).toHaveLength(3)
  })

  it('merges multiple pending candidates atomically and never recalls the result before approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-candidate-merge-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const first = await pending(archive, 'candidate-a', '中性候选 A。')
    const second = await pending(archive, 'candidate-b', '中性候选 B。')
    const merged = await archive.mergeCandidates({
      context: PERSONAL_COMPANION_ACCESS,
      candidateIds: [first.id, second.id],
      sourceMessageId: 'merge-request',
      content: '中性合并候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })
    expect(merged).toMatchObject({ status: 'pending', sourceCandidateIds: [first.id, second.id] })
    expect(archive.listCandidates({ context: PERSONAL_COMPANION_ACCESS })).toEqual([merged])
    expect(archive.recall({ context: PERSONAL_COMPANION_ACCESS, query: '中性合并' })).toEqual([])
    expect(archive.listGovernanceAudit({ context: PERSONAL_COMPANION_ACCESS })[0])
      .toMatchObject({ action: 'candidates-merged', resultCandidateId: merged.id })
  })
})
