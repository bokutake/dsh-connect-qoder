/**
 * 节点发现解析：字段名以真实客户端为准。
 *
 * 这里最值得钉住的一条是**不认 `dataNodeMap.remote_agent`**：pi-provider-qoder
 * 假设它存在并把聊天请求优先打到那个节点，而真实客户端的响应里没有这个字段
 * （`k$c` 只读 `centerNodes/inferNodes/fastMode/security/openapiNodes`）。跟着
 * pi 走，等于把请求发给一个「从表里查不到」的节点。
 *
 * @module dsh-connect-qoder/tests/endpoints.spec.ts
 */
import { describe, expect, it } from 'vitest'
import {
  ENDPOINTS_TTL_MS,
  QoderEndpointCache,
  orderWithLastFirst,
  parseRegionEndpoints,
} from '../src/endpoints.ts'

describe('parseRegionEndpoints', () => {
  it('读客户端真实字段：centerNodes / inferNodes / security / openapiNodes', () => {
    const parsed = parseRegionEndpoints({
      centerNodes: ['center.example.com'],
      inferNodes: ['infer.example.com', 'infer2.example.com'],
      security: ['sec.example.com'],
      openapiNodes: ['api.example.com'],
    })
    expect(parsed).toBeDefined()
    expect(parsed!.center).toEqual(['https://center.example.com/'])
    expect(parsed!.inference).toEqual(['https://infer.example.com/', 'https://infer2.example.com/'])
    expect(parsed!.securityInference).toEqual(['https://sec.example.com/'])
    expect(parsed!.openapi).toEqual(['https://api.example.com/'])
  })

  it('接受客户端 createEndpointTopology 的 data 包装形状', () => {
    const parsed = parseRegionEndpoints({
      version: 'v3',
      data: { centerNodes: ['c.example.com'], inferNodes: ['i.example.com'] },
    })
    expect(parsed!.center).toEqual(['https://c.example.com/'])
    expect(parsed!.inference).toEqual(['https://i.example.com/'])
  })

  it('**不**认 pi 假设的 dataNodeMap.remote_agent', () => {
    // pi 的写法是 dataNodeMap.remote_agent；真实客户端没有这个字段。
    // 若我们把 chat 指向它，只会在空表上退化成默认网关 —— 所以这里要求
    // 它根本不产生 inference 候选。
    const parsed = parseRegionEndpoints({
      dataNodeMap: { remote_agent: ['agent.example.com'] },
    })
    expect(parsed).toBeUndefined()
  })

  it('跳过 enterprise 类型节点（个人 PAT 环境不接受）', () => {
    const parsed = parseRegionEndpoints({
      inferNodes: [
        { url: 'public.example.com', type: 'public' },
        { url: 'corp.example.com', type: 'enterprise' },
        { url: 'plain.example.com' },
      ],
    })
    expect(parsed!.inference).toEqual(['https://public.example.com/', 'https://plain.example.com/'])
  })

  it('兼容已带 scheme 的 URL，并去重', () => {
    const parsed = parseRegionEndpoints({
      inferNodes: ['https://a.example.com', 'https://a.example.com/', 'http://b.example.com'],
    })
    expect(parsed!.inference).toEqual(['https://a.example.com/', 'http://b.example.com/'])
  })

  it('全空时返回 undefined（调用方退回默认网关）', () => {
    expect(parseRegionEndpoints({ centerNodes: [], inferNodes: [] })).toBeUndefined()
    expect(parseRegionEndpoints({})).toBeUndefined()
    expect(parseRegionEndpoints(null)).toBeUndefined()
    expect(parseRegionEndpoints('nope')).toBeUndefined()
  })

  it('只要有一类节点非空就算成功（与客户端一致）', () => {
    const parsed = parseRegionEndpoints({ openapiNodes: ['o.example.com'] })
    expect(parsed).toBeDefined()
    expect(parsed!.openapi).toEqual(['https://o.example.com/'])
    expect(parsed!.inference).toEqual([])
  })
})

describe('orderWithLastFirst', () => {
  it('把上次用过的节点提到最前，保留其余候选', () => {
    expect(orderWithLastFirst(['a/', 'b/', 'c/'], 'b/')).toEqual(['b/', 'a/', 'c/'])
  })

  it('上次的节点已不在表里时原样返回', () => {
    expect(orderWithLastFirst(['a/', 'b/'], 'gone/')).toEqual(['a/', 'b/'])
  })

  it('没有上次记录时原样返回', () => {
    expect(orderWithLastFirst(['a/', 'b/'], undefined)).toEqual(['a/', 'b/'])
  })
})

describe('QoderEndpointCache', () => {
  it('写入后在 TTL 内新鲜，过期后失效', () => {
    const cache = new QoderEndpointCache(ENDPOINTS_TTL_MS)
    const nodes = { center: [], inference: ['i/'], securityInference: [], openapi: [] }
    const now = 1_000_000
    cache.write(nodes, now)
    expect(cache.isFresh(now + 1_000)).toBe(true)
    expect(cache.read(now + 1_000)).toEqual(nodes)
    expect(cache.isFresh(now + ENDPOINTS_TTL_MS + 1)).toBe(false)
    expect(cache.read(now + ENDPOINTS_TTL_MS + 1)).toBeUndefined()
  })

  it('clear() 之后不再新鲜（换账号时节点表要重读）', () => {
    const cache = new QoderEndpointCache()
    cache.write({ center: [], inference: ['i/'], securityInference: [], openapi: [] })
    cache.clear()
    expect(cache.isFresh()).toBe(false)
  })

  it('TTL 与客户端 B9i=3e5 同值（5 分钟）', () => {
    expect(ENDPOINTS_TTL_MS).toBe(5 * 60 * 1000)
  })
})
