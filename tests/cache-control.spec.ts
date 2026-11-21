/**
 * `cache_control` 标记：默认关闭，打开后只标 system 消息的最后一个非空文本块。
 *
 * 这个文件存在的理由是**防止把 magpie 的行为误当客户端行为**：magpie 标最后一条
 * user turn，真实客户端 `BHc(A,e)` 标最后一条 system 消息。两者的缓存命中位置
 * 完全不同，标错地方等于白发一个字段还被上游忽略。
 *
 * @module dsh-connect-qoder/tests/cache-control.spec.ts
 */
import { describe, expect, it } from 'vitest'
import { applyCacheControl, type QoderIncomingMessage } from '../src/messages.ts'

const ephemeral = { type: 'ephemeral' as const }

function conversation(): QoderIncomingMessage[] {
  return [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ]
}

describe('applyCacheControl', () => {
  it('关闭时原样返回，一个字节都不改', () => {
    const input = conversation()
    const out = applyCacheControl(input, undefined)
    expect(out).toBe(input)
    expect(out[0]!.content).toBe('你是助手')
  })

  it('打开时只标 system 消息，不碰最后一条 user turn', () => {
    const out = applyCacheControl(conversation(), ephemeral)
    // 客户端 BHc：只标 system。
    const system = out[0]!.content as Array<Record<string, unknown>>
    expect(Array.isArray(system)).toBe(true)
    expect(system[0]!.cache_control).toEqual(ephemeral)

    // magpie 会标这里 —— 但真实客户端不标，所以必须断言「没标」。
    const lastUser = out[3]!
    expect(lastUser.content).toBe('第二问')
    expect(JSON.stringify(lastUser)).not.toContain('cache_control')
  })

  it('标的是 system 里最后一个非空文本块', () => {
    const out = applyCacheControl([
      {
        role: 'system',
        content: [
          { type: 'text', text: '前一段' },
          { type: 'text', text: '' },
          { type: 'text', text: '后一段' },
        ],
      },
      { role: 'user', content: '问' },
    ], ephemeral)
    const parts = out[0]!.content as Array<Record<string, unknown>>
    expect(parts[0]).toStrictEqual({ type: 'text', text: '前一段' })
    expect(parts[1]).toStrictEqual({ type: 'text', text: '' })
    expect(parts[2]!.cache_control).toEqual(ephemeral)
  })

  it('没有 system 消息时不动任何东西', () => {
    const input: QoderIncomingMessage[] = [{ role: 'user', content: '只有用户' }]
    const out = applyCacheControl(input, ephemeral)
    expect(out).toBe(input)
  })

  it('system 内容为空时不标（没有可标记的块）', () => {
    const input: QoderIncomingMessage[] = [
      { role: 'system', content: '' },
      { role: 'user', content: '问' },
    ]
    const out = applyCacheControl(input, ephemeral)
    expect(out).toBe(input)
  })

  it('已标记过的块不会被打上两次', () => {
    const out = applyCacheControl(conversation(), ephemeral)
    const twice = applyCacheControl(out, ephemeral)
    const parts = twice[0]!.content as Array<Record<string, unknown>>
    expect(parts.filter(p => p.cache_control !== undefined)).toHaveLength(1)
  })
})
