import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evaluateMemoryRetrieval,
  openMemoryArchive,
  type MemoryAccessContextV1,
  type MemoryRecord,
} from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

describe('neutral Chinese RP retrieval evaluation', () => {
  it('covers six continuity classes with complete explanations and zero cross-scope leakage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-retrieval-eval-'))
    const archive = await openMemoryArchive({
      path: join(root, 'memory.jsonl'),
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const rows = [
      ['称呼边界', '请记住：称呼边界关键词，小岚。', 'boundary'],
      ['共同事件', '请记住：共同事件关键词，雨天书店。', 'episode'],
      ['未完承诺', '请记住：未完承诺关键词，整理相册。', 'commitment'],
      ['当前偏好', '请记住：当前偏好关键词，燕麦早餐。', 'preference'],
      ['短期状态', '请记住：短期状态关键词，手腕恢复期。', 'state'],
      ['关系连续', '请记住：关系连续关键词，每周问候。', 'relationship'],
    ] as const
    const memories: MemoryRecord[] = []
    for (const [source, text, memoryKind] of rows) {
      const memory = await archive.observeExplicit({
        context: PERSONAL_COMPANION_ACCESS,
        sourceMessageId: source,
        text,
        memoryKind,
      })
      if (memory === undefined) throw new Error('evaluation fixture memory missing')
      memories.push(memory)
    }
    const sceneContext: MemoryAccessContextV1 = {
      ...PERSONAL_COMPANION_ACCESS,
      scope: { version: 1, kind: 'character-scene', sceneId: 'scene-fixture' },
    }
    const scene = await archive.observeExplicit({
      context: sceneContext,
      sourceMessageId: 'scene-cross-scope',
      text: '请记住：共同事件关键词，虚构场景干扰。',
      memoryKind: 'episode',
    })
    if (scene === undefined) throw new Error('evaluation scene memory missing')

    const report = await evaluateMemoryRetrieval(rows.map(([query], index) => ({
      name: query,
      expectedMemoryIds: [memories[index]!.id],
      forbiddenMemoryIds: [scene.id],
      run: () => archive.retrieve({ context: PERSONAL_COMPANION_ACCESS, query, limit: 1 }),
    })))

    expect(report).toMatchObject({
      schemaVersion: 1,
      caseCount: 6,
      precisionAtK: 1,
      criticalRecallRate: 1,
      scopeLeakageCount: 0,
      explanationCompleteness: 1,
    })
    expect(report.p95LatencyMs).toBeGreaterThanOrEqual(0)
  })
})
