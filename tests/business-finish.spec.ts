/**
 * `business/finish` 闭合的专项测试。
 *
 * 这一条是本插件长期缺的那一环：没有它，服务端只能等 TTL 释放租约，那一轮在
 * 记账上永远是「进行中」，控制台里也就不产生逐条消费行。
 *
 * 期望值全部来自实测抓包（qoderclicn 1.1.94，2026-11-21）与客户端源码
 * `Qd.finish()` / `kVe()` / `Mh.finalize()`，不是我们自己编的形状。
 */
import { describe, expect, it } from 'vitest'
import { QoderUpstreamClient } from '../src/upstream.ts'
import { cosyDecode } from '../src/cosy.ts'

interface FinishCall {
  url: string
  /** **解信封之后的**那个对象（`payload` 里 JSON 化之前的东西）。 */
  envelope: Record<string, unknown>
  body: Record<string, unknown>
  headers: Record<string, string>
}

/**
 * 造一个假上游：认得出 jobToken / chat / finish 三条路径。
 *
 * 返回的 `finishes` 是所有闭合请求的解析结果，供断言其形状与次数。
 */
function upstream() {
  const finishes: FinishCall[] = []
  let chatCalls = 0
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('jobToken') && !u.includes('exchange')) {
      return new Response(JSON.stringify({
        id: 'u', name: 'acct-demo', expireTime: Date.now() + 1_000_000,
        securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-TEST' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (u.includes('/service/business/finish')) {
      const encoded = typeof init?.body === 'string' ? init.body : ''
      const decoded = Buffer.from(cosyDecode(encoded)).toString('utf8')
      const envelope = JSON.parse(decoded) as Record<string, unknown>
      // 明文是 `{payload: "<json 字符串>", encodeVersion: "1"}` —— 与聊天请求
      // 那种「明文就是 body」的形状不同，所以这里要再解一层。
      const body = JSON.parse(String(envelope['payload'])) as Record<string, unknown>
      finishes.push({
        url: u,
        envelope,
        body,
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('agent_chat_generation')) {
      chatCalls += 1
      // 回一帧最小可用的 SSE，让 chatStream 正常结束。
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }
    // 节点发现之类的其它路径：一律 500，让客户端静默走默认网关。
    return new Response('boom', { status: 500 })
  }) as unknown as typeof fetch
  return { finishes, chatCalls: () => chatCalls, client: new QoderUpstreamClient('cn', { fetch: fetchImpl }) }
}

const TURN = {
  sessionId: 'session-finish-1',
  key: 'session-finish-1\u0000hello',
  businessId: 'biz-1',
  beginAt: 1_700_000_000_000,
  name: 'hello',
  modelKey: 'dfmodel',
  product: 'cli' as const,
  version: '1.1.94',
}

describe('business/finish 闭合', () => {
  it('明文是 {payload, encodeVersion} 双层信封 —— 不是 business 对象本身', async () => {
    const { finishes, client } = upstream()
    await client.finishTurn('pt-x', TURN, 'end_turn')
    expect(finishes).toHaveLength(1)
    const { envelope } = finishes[0]!
    // 顶层只有这两个键。官方 CLI 解出来的明文逐字就是这样
    // （captures/20261121-050020 的 0039-req.bin，解密后 522 B）。
    expect(Object.keys(envelope).sort()).toEqual(['encodeVersion', 'payload'])
    expect(envelope.encodeVersion).toBe('1')
    // `payload` 是**字符串**，不是对象 —— 这一层写错会让上游直接 500。
    expect(typeof envelope.payload).toBe('string')
    expect(() => JSON.parse(String(envelope.payload))).not.toThrow()
  })

  it('发出的一次闭合带齐客户端那套字段，且 stage/end_at 由 kVe 决定', async () => {
    const { finishes, client } = upstream()
    await client.finishTurn('pt-x', TURN, 'end_turn')

    expect(finishes).toHaveLength(1)
    const call = finishes[0]!
    expect(call.url).toContain('/algo/api/v2/service/business/finish')
    expect(call.url).toContain('Encode=1')

    // 信封：客户端 `BUSINESS_FINISH` 的形状，aid/oid/yid/uid 都是空串。
    expect(call.body.event_type).toBe('BUSINESS_FINISH')
    expect(typeof call.body.event_time).toBe('number')
    expect(typeof call.body.rid).toBe('string')
    for (const key of ['aid', 'oid', 'yid', 'uid']) expect(call.body[key]).toBe('')

    const data = call.body.event_data as Record<string, unknown>
    expect(data.session_id).toBe(TURN.sessionId)
    const biz = data.business as Record<string, unknown>
    expect(biz.id).toBe('biz-1')
    expect(biz.product).toBe('cli')
    expect(biz.version).toBe('1.1.94')
    expect(biz.type).toBe('agent')
    expect(biz.model_key).toBe('dfmodel')
    expect(biz.begin_at).toBe(TURN.beginAt)
    // `end_at` 是**这次闭合的时刻**，必须晚于 `begin_at`。
    expect(typeof biz.end_at).toBe('number')
    expect(biz.end_at as number).toBeGreaterThan(TURN.beginAt)
    expect(biz.stage).toBe('complete')
    expect(biz.name).toBe('hello')
  })

  it('同一轮只闭合一次（幂等闸），第二轮再调不会重发', async () => {
    const { finishes, client } = upstream()
    // 先把这一轮「开」出来，闭合才有记录可关。
    await client.chatStream('pt-x', 'dfmodel', [{ role: 'user', content: 'hello' }], {
      sessionId: TURN.sessionId,
      onDelta: () => {},
    })
    await client.finishCurrentTurn('pt-x', 'end_turn')
    await client.finishCurrentTurn('pt-x', 'end_turn')
    expect(finishes).toHaveLength(1)
  })

  it('stage 映射逐字照抄客户端 kVe：abort / error / complete 三支', async () => {
    for (const [reason, expected] of [
      ['end_turn', 'complete'],
      ['abort', 'abort'],
      ['repeated_tool_call_denied', 'abort'],
      ['error', 'error'],
      ['max_turns', 'error'],
    ] as const) {
      const { finishes, client } = upstream()
      await client.finishTurn('pt-x', { ...TURN, key: `k-${reason}` }, reason)
      expect(finishes).toHaveLength(1)
      const biz = (finishes[0]!.body.event_data as Record<string, unknown>).business as Record<string, unknown>
      expect(biz.stage).toBe(expected)
    }
  })

  it('business 恰好九个键 —— sub_task / orphan / feature_switches 刻意不发', async () => {
    // 客户端 `Qd.finish()` 的模板里有这三个键，但它们在主对话里本来就是
    // `undefined`，`JSON.stringify` 会把它们省掉。官方 CLI 的明文（解密
    // captures/20261121-050020 的 0039-req.bin）逐字核对过：只有这九个。
    //
    // 这条断言的作用是**挡住「补齐」的冲动**：日后若有人照着客户端源码把手写的
    // `feature_switches: {}` 或 `orphan: false` 加进来，等于发出一项官方客户端
    // 根本不发的内容 —— 那不是对齐，是造偏差。
    const { finishes, client } = upstream()
    await client.finishTurn('pt-x', TURN)
    const biz = (finishes[0]!.body.event_data as Record<string, unknown>).business as Record<string, unknown>
    expect(Object.keys(biz).sort()).toEqual([
      'begin_at',
      'end_at',
      'id',
      'model_key',
      'name',
      'product',
      'stage',
      'type',
      'version',
    ])
    for (const absent of ['sub_task', 'orphan', 'feature_switches']) {
      expect(absent in biz, `${absent} 不该出现`).toBe(false)
    }
  })

  it('没有 business.id 或无法归组时不发请求', async () => {
    const { finishes, client } = upstream()
    await client.finishTurn('pt-x', { ...TURN, key: '' })
    await client.finishTurn('pt-x', { ...TURN, businessId: '' })
    expect(finishes).toHaveLength(0)
  })

  it('闭合请求带 cosy 头，且不带 accept: text/event-stream（它不是流式）', async () => {
    const { finishes, client } = upstream()
    await client.finishTurn('pt-x', TURN)
    const headers = finishes[0]!.headers
    expect(headers['cosy-clienttype']).toBe('5')
    expect(headers['cosy-business-product']).toBe('cli')
    expect(headers['cosy-version']).toBeTruthy()
    expect(headers.authorization).toMatch(/^Bearer /)
    expect(headers.accept).not.toBe('text/event-stream')
  })

  it('闭合失败不影响调用方（不抛）', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('jobToken') && !u.includes('exchange')) {
        return new Response(JSON.stringify({
          id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
          securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('jobToken/exchange')) {
        return new Response(JSON.stringify({ token: 'jt-TEST' }), { status: 200 })
      }
      if (u.includes('business/finish')) return new Response('nope', { status: 500 })
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch
    const client = new QoderUpstreamClient('cn', { fetch: fetchImpl })
    await expect(client.finishTurn('pt-x', TURN)).resolves.toBeUndefined()
  })
})
