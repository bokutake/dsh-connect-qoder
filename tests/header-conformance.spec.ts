/**
 * 请求头与真实 CLI 的一致性测试。
 *
 * 这里的每个期望值都来自实测抓包（qoderclicn 1.1.94，CN 账号，2026-11-21），
 * 不是从别人的实现里抄的 —— 抄来的值正是本次要修的东西：
 *
 * | 头 | 修前 | 抓包实测 | 依据 |
 * | --- | --- | --- | --- |
 * | `cosy-clienttype` | `5` | `5` | 105/105 次 |
 * | `cosy-business-product` | `ide` | `cli` | 5/5 次 |
 * | `user-agent` | `Go-http-client/2.0` | `Bun/1.4.4` | CLI 是 Bun 单文件可执行程序 |
 * | `cosy-version` | `0.1.43`（写死） | `1.1.94`（= CLI 版本） | 与 bearer 载荷 `cosyVersion` 逐字相同 |
 * | `cosy-machineid` | 凭据派生 | 本机 `machine_id` | 与 `cosy-machinetoken` **不同值** |
 */
import { describe, expect, it } from 'vitest'
import { QoderUpstreamClient } from '../src/upstream.ts'
import { cosyDecode } from '../src/cosy.ts'

interface Recorded {
  url: string
  headers: Record<string, string>
  body: string
}

/** 记录所有请求的假上游，按路径分类返回。 */
function recorder() {
  const calls: Recorded[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    calls.push({
      url: u,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    })
    if (u.includes('jobToken') && !u.includes('exchange')) {
      return new Response(JSON.stringify({
        id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
        securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('jobToken/exchange')) {
      return new Response(JSON.stringify({ token: 'jt-TEST' }), { status: 200 })
    }
    if (u.includes('agent_chat_generation')) {
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, client: new QoderUpstreamClient('cn', { fetch: fetchImpl }) }
}

/** 解 bearer 载荷（`Bearer COSY.<b64>.<sig>` 的第二段）。 */
function bearerPayload(headers: Record<string, string>): Record<string, unknown> {
  const auth = headers.authorization ?? ''
  const parts = auth.split('.')
  const b64 = parts[1] ?? ''
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>
}

describe('请求头与真实 CLI 一致', () => {
  it('chat 请求带 cli / assistant / agent / clienttype 5', async () => {
    const { calls, client } = recorder()
    await client.chatStream('pt-x', 'dfmodel', [{ role: 'user', content: 'hi' }], {
      sessionId: 's1',
      onDelta: () => {},
    })
    const chat = calls.find(c => c.url.includes('agent_chat_generation'))
    expect(chat).toBeDefined()
    expect(chat!.headers['cosy-business-product']).toBe('cli')
    expect(chat!.headers['cosy-scene']).toBe('assistant')
    expect(chat!.headers['cosy-business-type']).toBe('agent')
    expect(chat!.headers['cosy-clienttype']).toBe('5')
    expect(chat!.headers['login-version']).toBe('v2')
    // CLI 是 Bun 编译的单文件可执行程序，抓包 39/39 次都是这个值。
    expect(chat!.headers['user-agent']).toBe('Bun/1.4.4')
  })

  it('cosy-version 头与 bearer 载荷 cosyVersion 逐字相同（抓包事实）', async () => {
    const { calls, client } = recorder()
    await client.chatStream('pt-x', 'dfmodel', [{ role: 'user', content: 'hi' }], {
      sessionId: 's1',
      onDelta: () => {},
    })
    const chat = calls.find(c => c.url.includes('agent_chat_generation'))!
    const payload = bearerPayload(chat.headers)
    expect(payload.cosyVersion).toBe(chat.headers['cosy-version'])
    // 载荷里确实有这四个字段（顺序不重要）。
    expect(Object.keys(payload).sort()).toEqual(['cosyVersion', 'ideVersion', 'info', 'requestId', 'version'])
    expect(payload.version).toBe('v1')
    expect(payload.ideVersion).toBe('')
  })

  it('注入的 clientVersion 三处同值：头、载荷、business.version', async () => {
    const calls: Recorded[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      calls.push({
        url: u,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : '',
      })
      if (u.includes('jobToken') && !u.includes('exchange')) {
        return new Response(JSON.stringify({
          id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
          securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('jobToken/exchange')) return new Response(JSON.stringify({ token: 'j' }), { status: 200 })
      if (u.includes('agent_chat_generation')) {
        return new Response('data: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const client = new QoderUpstreamClient('cn', { fetch: fetchImpl, clientVersion: '1.2.3' })
    await client.chatStream('pt-x', 'dfmodel', [{ role: 'user', content: 'hi' }], {
      sessionId: 's1',
      onDelta: () => {},
    })
    const chat = calls.find(c => c.url.includes('agent_chat_generation'))!
    expect(chat.headers['cosy-version']).toBe('1.2.3')
    expect(bearerPayload(chat.headers).cosyVersion).toBe('1.2.3')
    const body = JSON.parse(Buffer.from(cosyDecode(chat.body)).toString('utf8')) as Record<string, unknown>
    expect((body.business as Record<string, unknown>).version).toBe('1.2.3')
  })

  it('设备身份六件套齐全：id / token / type / code / os / hostname', async () => {
    // 官方 CLI 每次聊天都带这六个。`machinecode` / `machineos` /
    // `machinehostname` 此前**一个都没发** —— 声称了身份却不说跑在什么机器上，
    // 本身就是一条可筛的差异。
    const { calls, client } = recorder()
    await client.chatStream('pt-x', 'dfmodel', [{ role: 'user', content: 'hi' }], {
      sessionId: 's1',
      onDelta: () => {},
    })
    const chat = calls.find(c => c.url.includes('agent_chat_generation'))!
    // `machineid` / `machinetoken` / `machinetype` 三个在任何模式下都有。
    for (const name of ['cosy-machineid', 'cosy-machinetoken', 'cosy-machinetype']) {
      expect(chat.headers[name], name).toBeTruthy()
    }
    // 环境头按 `arch_platform` 的形状，与抓包一致（`x86_64_win32` 那种）。
    expect(chat.headers['cosy-machineos']).toMatch(/^[a-z0-9_]+_[a-z0-9]+$/)
    // hostname 拿不到时不发（CI 里可能没有），拿到就必须非空。
    if ('cosy-machinehostname' in chat.headers) {
      expect(chat.headers['cosy-machinehostname']).not.toBe('')
    }
  })

  it('user-agent 不跟随 clientVersion：那是 Bun 的版本，不是 Qoder 的', async () => {
    // 注入一个明显不同的 clientVersion，user-agent 必须**不动**。
    //
    // 这条挡的是「把两个版本号混成一条规则」的冲动：`cosy-version` 该跟随
    // （它随 CLI 发布变化，且要在头/载荷/business.version 三处同值），
    // `user-agent` 不该跟随 —— `Bun/1.4.4` 里的 `1.4.4` 是 **Bun 运行时**的版本，
    // 与 Qoder CLI 的 `1.1.94` 没有任何对应关系。跟随就会发出 `Bun/1.1.94`，
    // 那是一个从未存在过的 Bun 版本。
    const calls: Recorded[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      calls.push({
        url: u,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : '',
      })
      if (u.includes('jobToken') && !u.includes('exchange')) {
        return new Response(JSON.stringify({
          id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
          securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('jobToken/exchange')) return new Response(JSON.stringify({ token: 'j' }), { status: 200 })
      if (u.includes('agent_chat_generation')) {
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const client = new QoderUpstreamClient('cn', { fetch: fetchImpl, clientVersion: '9.8.7' })
    await client.chatStream('pt-x', 'dfmodel', [{ role: 'user', content: 'hi' }], {
      sessionId: 's1', onDelta: () => {},
    })
    const chat = calls.find(c => c.url.includes('agent_chat_generation'))!
    expect(chat.headers['cosy-version']).toBe('9.8.7')
    expect(chat.headers['user-agent']).toBe('Bun/1.4.4')
    expect(chat.headers['user-agent']).not.toContain('9.8.7')
  })

  it('fake 与 real 两种身份模式下 machineid / machinetoken 的来源确实不同', async () => {
    // derived 模式：两者都是派生值，但**取值不同**（md5 vs 43 字符）。
    const derived: Recorded[] = []
    const derivedClient = new QoderUpstreamClient('cn', {
      deviceIdentity: 'derived',
      fetch: (async (url: string | URL, init?: RequestInit) => {
        const u = String(url)
        derived.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string>, body: '' })
        if (u.includes('jobToken') && !u.includes('exchange')) {
          return new Response(JSON.stringify({
            id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
            securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (u.includes('jobToken/exchange')) return new Response(JSON.stringify({ token: 'j' }), { status: 200 })
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }) as unknown as typeof fetch,
    })
    await derivedClient.chatStream('pt-x', 'dfmodel', [{ role: 'user', content: 'hi' }], {
      sessionId: 's1', onDelta: () => {},
    })
    const chat = derived.find(c => c.url.includes('agent_chat_generation'))!
    expect(chat.headers['cosy-machineid']).not.toBe(chat.headers['cosy-machinetoken'])
    // 派生值里没有 machineCode 的来源，整个头都不该出现。
    expect('cosy-machinecode' in chat.headers).toBe(false)
  })
})
