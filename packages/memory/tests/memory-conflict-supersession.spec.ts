import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive } from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mistymoon-conflict-'))
  const archive = await openMemoryArchive({
    path: join(root, 'memory.jsonl'),
    now: () => new Date('2026-08-20T12:00:00.000Z'),
  })
  const current = await archive.observeExplicit({
    context: PERSONAL_COMPANION_ACCESS,
    sourceMessageId: 'current-preference',
    text: '请记住：Owner 的饮品偏好是红茶。',
    memoryKind: 'preference',
  })
  if (current === undefined) throw new Error('fixture did not create current memory')
  const candidate = await archive.propose({
    context: PERSONAL_COMPANION_ACCESS,
    sourceMessageId: 'candidate-preference',
    content: 'Owner 的饮品偏好是乌龙茶。',
    visibility: 'personal',
    memoryKind: 'preference',
  })
  return { archive, current, candidate }
}

describe('memory conflict and supersession', () => {
  it('requires an Owner decision for a detected conflict and atomically supersedes the selected version', async () => {
    const { archive, current, candidate } = await fixture()
    const assessment = archive.assessCandidate({
      context: PERSONAL_COMPANION_ACCESS,
      candidateId: candidate.id,
    })
    expect(assessment.relationships).toEqual([
      expect.objectContaining({ memoryId: current.id, relation: 'conflict', reason: 'same-kind-near-match' }),
    ])

    await expect(archive.approveCandidate({
      context: PERSONAL_COMPANION_ACCESS,
      candidateId: candidate.id,
      sourceMessageId: 'approve-without-decision',
    })).rejects.toMatchObject({ code: 'MEMORY_CONFLICT_DECISION_REQUIRED' })

    const replacement = await archive.approveCandidate({
      context: PERSONAL_COMPANION_ACCESS,
      candidateId: candidate.id,
      sourceMessageId: 'approve-supersede',
      resolution: { kind: 'supersede', memoryId: current.id },
    })
    expect(replacement).toMatchObject({
      sourceCandidateId: candidate.id,
      supersedesMemoryId: current.id,
      status: 'confirmed',
    })
    expect(archive.list({ context: PERSONAL_COMPANION_ACCESS })).toEqual([replacement])
    expect(archive.list({ context: PERSONAL_COMPANION_ACCESS, includeInactive: true }))
      .toEqual(expect.arrayContaining([replacement, expect.objectContaining({ id: current.id, status: 'superseded' })]))
  })

  it('allows an explicit keep-both decision without inventing a supersession link', async () => {
    const { archive, current, candidate } = await fixture()
    const approved = await archive.approveCandidate({
      context: PERSONAL_COMPANION_ACCESS,
      candidateId: candidate.id,
      sourceMessageId: 'approve-keep-both',
      resolution: { kind: 'keep-both' },
    })
    expect(approved.supersedesMemoryId).toBeUndefined()
    expect(archive.list({ context: PERSONAL_COMPANION_ACCESS }).map(item => item.id))
      .toEqual(expect.arrayContaining([current.id, approved.id]))
  })
})
