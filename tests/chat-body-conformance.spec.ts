/**
 * 请求体对官方客户端的字段一致性。
 *
 * 每一条断言都来自反编译证据，不是猜的：
 *
 * | 字段 | 证据 |
 * | --- | --- |
 * | `business.product` | `electronMain.js`：`Od=Object.freeze({clientType:10,businessProduct:"app"})`；worker 侧 `MKA="cli"` 是 CLI 产品线默认 |
 * | `business.type` | `rk()` → `type: process.env[S0e] ?? "agent"` |
 * | `business.version` | `Gr()` → 客户端自报版本（`NO()` 的 `"1.1.86-hotfix.16"` 兜底） |
 * | `business.stage` | `pye` 类：`init → start → processing → complete` |
 * | `session_type` | `SPr = ti ? "qoderclicn" : "qodercli"`（`ti` 即国内版判定） |
 * | `max_tokens` | `lYa(A)` **总是**写 `max_tokens`，值来自 `cYa()` |
 *
 * 后两条尤其值得钉住：`session_type` 此前写死成 `'qodercli'`（国内版客户端
 * 发的是 `qoderclicn`），`max_tokens` 则**从来不发** —— 而客户端每一帧都发。
 *
 * @module dsh-connect-qoder/tests/chat-body-conformance
 */
import { describe, expect, it } from 'vitest'
import { cosyDecode } from '../src/cosy.ts'
import { QoderUpstreamClient } from '../src/upstream.ts'

/** 跑一次 chatStream，回解 cosy 编码的请求体。 */
function capture(region: 'cn' | 'global' = 'cn', extra: { userType?: string } = {}) {
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('jobToken')) {
      return new Response(JSON.stringify({
        id: 'u',
        name: 'n',
        expireTime: Date.now() + 1_000_000,
        securityOauthToken: 'jt-TEST',
        refreshToken: 'r',
        userType: extra.userType ?? 'personal_standard',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const encoded = typeof init?.body === 'string' ? init.body : ''
    bodies.push(JSON.parse(Buffer.from(cosyDecode(encoded)).toString('utf8')) as Record<string, unknown>)
    return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { bodies, client: new QoderUpstreamClient(region, { fetch: fetchImpl }) }
}

type Business = Record<string, unknown>

describe('business 字段与官方客户端一致', () => {
  it('写完 product / type / version / stage，不只 id/name/begin_at', async () => {
    const { bodies, client } = capture()
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], { onDelta: () => {} })
    const business = bodies[0]!.business as Business

    // 三件必有的身份字段：此前一个都没有（只有 id/name/begin_at）。
    expect(typeof business.product).toBe('string')
    expect(business.product).not.toBe('')
    expect(business.type).toBe('agent')
    expect(typeof business.version).toBe('string')
    expect(business.version).not.toBe('')

    // stage 必须是已知枚举之一，不能是自由文本。
    expect(['init', 'start', 'processing', 'complete', 'abort', 'error']).toContain(business.stage)

    // 原有三个字段不能因此消失。
    expect(typeof business.id).toBe('string')
    expect(typeof business.name).toBe('string')
    expect(typeof business.begin_at).toBe('number')
  })

  it('product 默认按 CLI 通道发 cli，且可被配置覆盖', async () => {
    const { bodies, client } = capture()
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], { onDelta: () => {} })
    // 我们走 PAT + /algo/api/v3/user/jobToken，形态上属 CLI 通道；
    // 桌面客户端的 "app" 是另一条通道，不由这条路径发出。
    expect((bodies[0]!.business as Business).product).toBe('cli')
  })

  it('配置里的 businessProductOf 能覆盖默认值', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
          securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const encoded = typeof init?.body === 'string' ? init.body : ''
      bodies.push(JSON.parse(Buffer.from(cosyDecode(encoded)).toString('utf8')) as Record<string, unknown>)
      return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const client = new QoderUpstreamClient('cn', { fetch: fetchImpl, businessProduct: 'app' })
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], { onDelta: () => {} })
    expect((bodies[0]!.business as Business).product).toBe('app')
  })

  it('stage 在同一轮内从 start 推进到 processing', async () => {
    const { bodies, client } = capture()
    const sessionId = 'session-stage-progression'
    // **同一句用户提示**连发三次 = 一轮里的工具循环。
    //
    // 这里以前每轮换一句提示（`t${i}`），靠「整场会话共用一条 business 记录」
    // 才看得出推进。而记录的粒度是**一条用户输入**，换提示就是换轮次，三份都该
    // 是 `start`。要观察 changeBusinessState() 的推进，必须留在同一轮里。
    const messages = [{ role: 'user', content: 'same prompt' }]
    for (let i = 0; i < 3; i += 1) {
      await client.chatStream('pt-x', 'qfmodel', messages, {
        sessionId,
        onDelta: () => {},
      })
    }
    const stages = bodies.map(b => (b.business as Business).stage)
    // 客户端 changeBusinessState(): init → start，start → processing，之后停住。
    expect(stages[0]).toBe('start')
    expect(stages[1]).toBe('processing')
    expect(stages[2]).toBe('processing')
  })

  it('换成新的用户提示就是新的一轮：stage 回到 start，business.id 换新', async () => {
    const { bodies, client } = capture()
    const sessionId = 'session-new-turn'
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: '第一条' }], {
      sessionId, onDelta: () => {},
    })
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: '第二条' }], {
      sessionId, onDelta: () => {},
    })
    // 两条用户输入 = 两条 business 记录（客户端按 requestSetId 生成 id）。
    expect((bodies[0]!.business as Business).id).not.toBe((bodies[1]!.business as Business).id)
    expect((bodies[0]!.business as Business).stage).toBe('start')
    expect((bodies[1]!.business as Business).stage).toBe('start')
  })
})

describe('session_type 按区域取值', () => {
  it('国内版发 qoderclicn（客户端 SPr = ti ? "qoderclicn" : "qodercli"）', async () => {
    const { bodies, client } = capture('cn')
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], { onDelta: () => {} })
    expect(bodies[0]!.session_type).toBe('qoderclicn')
  })

  it('国际版发 qodercli', async () => {
    const { bodies, client } = capture('global')
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], { onDelta: () => {} })
    expect(bodies[0]!.session_type).toBe('qodercli')
  })
})

describe('max_tokens 必须下发，且按模型取值', () => {
  it('默认带上调用方给的 maxOutputTokens', async () => {
    const { bodies, client } = capture()
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], {
      maxOutputTokens: 65_536,
      onDelta: () => {},
    })
    const params = bodies[0]!.parameters as Record<string, unknown>
    expect(params.max_tokens).toBe(65_536)
  })

  it('调用方没给时用上游目录兜底值（不是凭空一个数）', async () => {
    const { bodies, client } = capture()
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], { onDelta: () => {} })
    const params = bodies[0]!.parameters as Record<string, unknown>
    expect(typeof params.max_tokens).toBe('number')
    expect(params.max_tokens as number).toBeGreaterThan(0)
  })

  it('与 reasoning_effort 共存，互不覆盖', async () => {
    const { bodies, client } = capture()
    await client.chatStream('pt-x', 'qfmodel', [{ role: 'user', content: 'hi' }], {
      reasoningEffort: 'high',
      maxOutputTokens: 32_000,
      onDelta: () => {},
    })
    const params = bodies[0]!.parameters as Record<string, unknown>
    expect(params.reasoning_effort).toBe('high')
    expect(params.max_tokens).toBe(32_000)
  })
})
