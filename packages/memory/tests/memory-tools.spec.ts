import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as IdentityPlugin from '@mistymoon/dsh-identity'
import { describe, expect, it } from 'vitest'
import * as MemoryPlugin from '../src/index.js'
import { PERSONAL_COMPANION_ACCESS } from './fixtures.js'

const signal = new AbortController().signal
const DENIED_TOOL_CASES = [
  ['memory_candidate_propose', { content: 'Child output must not become Owner memory.', visibility: 'personal' }],
  ['memory_candidate_list', {}],
  ['memory_candidate_approve', { candidateId: 'candidate-fixture' }],
  ['memory_candidate_reject', { candidateId: 'candidate-fixture' }],
  ['memory_list', {}],
  ['memory_forget', { memoryId: 'memory-fixture' }],
  ['memory_replace', { memoryId: 'memory-fixture', content: 'Replacement fixture.' }],
] as const

async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  callId: string,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal, callId: CallId(callId), name, arguments: args, agent })
}

function toolAgent(ctx: Context, idText: string, delegationDepth?: number): Agent {
  const id = SessionId(idText)
  const session = Session.create(id, [], {
    version: 0,
    id,
    createdAt: 1,
    ...(delegationDepth === undefined ? {} : { origin: 'subagent' as const, delegationDepth }),
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Owner governance request.' }],
    source: { kind: 'user', rpcId: `rpc-${idText}` } as ReturnType<typeof createUserMessage>['source'],
  }), { surfaceOp: 'append' })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'running',
    ctx,
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function value(result: ToolExecutionResult): unknown {
  if (result.isError) throw new Error(`expected successful memory tool result: ${JSON.stringify(result.content)}`)
  expect(result.isError).toBe(false)
  return result.value
}

describe('MistyMoon memory tools', () => {
  it.each(DENIED_TOOL_CASES)('denies depth-one child access to %s without changing the archive', async (toolName, args) => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-child-tool-'))
    const path = join(root, 'memories.jsonl')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })
    const child = toolAgent(ctx, 'memory-child-tool-agent', 1)

    const result = await execute(ctx, toolName, args, `child-${toolName}`, child)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('authenticated Owner request')
    expect(ctx.mistymoonMemory.list({ context: PERSONAL_COMPANION_ACCESS })).toEqual([])
    expect(ctx.mistymoonMemory.listCandidates({ context: PERSONAL_COMPANION_ACCESS })).toEqual([])
  })

  it('lets the owner list, replace, and forget memories through DSH tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-tools-'))
    const path = join(root, 'memories.jsonl')
    const ids = ['observation-1', 'memory-1']
    const archive = await MemoryPlugin.openMemoryArchive({ path, createId: () => ids.shift() ?? 'unexpected-id' })
    await archive.observeExplicit({
      context: PERSONAL_COMPANION_ACCESS,
      memoryKind: 'preference',
      sourceMessageId: 'message-1',
      text: '请记住：我喜欢红茶。',
    })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })
    const agent = toolAgent(ctx, 'memory-owner-tools-agent')

    const listed = value(await execute(ctx, 'memory_list', { query: '红茶' }, 'call-list', agent))
    expect(listed).toEqual({
      memories: [expect.objectContaining({ id: 'memory-1', content: '我喜欢红茶。', status: 'confirmed' })],
    })

    const replaced = value(await execute(ctx, 'memory_replace', {
      memoryId: 'memory-1',
      content: '我现在更喜欢凤凰单丛。',
    }, 'call-replace', agent)) as { memory: { id: string } }
    expect(replaced).toEqual({
      memory: expect.objectContaining({ content: '我现在更喜欢凤凰单丛。', status: 'confirmed' }),
    })

    const forgotten = value(await execute(ctx, 'memory_forget', {
      memoryId: replaced.memory.id,
    }, 'call-forget', agent))
    expect(forgotten).toEqual({
      memory: expect.objectContaining({ id: replaced.memory.id, status: 'forgotten' }),
    })

    expect(value(await execute(ctx, 'memory_list', {}, 'call-list-final', agent))).toEqual({ memories: [] })
  })

  it('requires an explicit owner review before a proposed memory becomes active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-review-tools-'))
    const path = join(root, 'memories.jsonl')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(IdentityPlugin, { ownerId: 'owner-fixture' })
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })
    const agent = toolAgent(ctx, 'memory-owner-review-agent')

    const proposed = value(await execute(ctx, 'memory_candidate_propose', {
      content: '主人通常在周末整理书桌。',
      visibility: 'personal',
    }, 'call-propose', agent)) as { candidate: { id: string } }
    expect(proposed).toEqual({
      candidate: expect.objectContaining({ content: '主人通常在周末整理书桌。', status: 'pending' }),
    })
    expect(value(await execute(ctx, 'memory_candidate_list', {}, 'call-candidate-list', agent))).toEqual({
      candidates: [expect.objectContaining({ id: proposed.candidate.id, status: 'pending' })],
    })
    expect(value(await execute(ctx, 'memory_list', { query: '周末' }, 'call-memory-list', agent))).toEqual({ memories: [] })

    const approved = value(await execute(ctx, 'memory_candidate_approve', {
      candidateId: proposed.candidate.id,
    }, 'call-approve', agent))
    expect(approved).toEqual({
      memory: expect.objectContaining({ content: '主人通常在周末整理书桌。', status: 'confirmed' }),
    })
    expect(value(await execute(ctx, 'memory_candidate_list', {}, 'call-candidate-list-final', agent))).toEqual({ candidates: [] })
    expect(value(await execute(ctx, 'memory_list', { query: '周末' }, 'call-memory-list-final', agent))).toEqual({
      memories: [expect.objectContaining({ content: '主人通常在周末整理书桌。' })],
    })
  })
})
