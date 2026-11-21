/**
 * 客户端版本解析器的测试。
 *
 * 这个值同时进 `cosy-version` 头、bearer 载荷的 `cosyVersion`、以及
 * `business.version`，三处必须同值；所以解析器只做两件事：**选一个真实存在的
 * 版本号**，以及**永不抛**。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUNDLED_CLIENT_VERSION,
  CLIENT_VERSION_TTL_MS,
  ClientVersionResolver,
  compareVersions,
  pickLatestVersion,
} from '../src/client-version.ts'

describe('compareVersions', () => {
  it('按三段数字比较', () => {
    expect(compareVersions('1.1.93', '1.1.94')).toBe(-1)
    expect(compareVersions('1.2.0', '1.1.99')).toBe(1)
    expect(compareVersions('1.1.94', '1.1.94')).toBe(0)
  })

  it('形状不对返回 undefined（调用方据此保守处理）', () => {
    for (const bad of ['', '1.1', '1.1.1.1', 'abc', '1.1.x']) {
      expect(compareVersions(bad, '1.1.94')).toBeUndefined()
    }
  })

  it('预发布后缀整段丢掉', () => {
    expect(compareVersions('1.1.94-beta.1', '1.1.94')).toBe(0)
  })
})

describe('pickLatestVersion', () => {
  it('从数组里挑最大的，并去掉 v 前缀', () => {
    expect(pickLatestVersion([
      { tag_name: 'v1.1.92' },
      { name: '1.1.94' },
      { tag_name: 'v1.1.93' },
    ])).toBe('1.1.94')
  })

  it('认 {data:[…]} 形状（releases 接口的包装）', () => {
    expect(pickLatestVersion({ data: [{ name: '1.2.0' }] })).toBe('1.2.0')
  })

  it('形状不成形时返回 undefined', () => {
    expect(pickLatestVersion(null)).toBeUndefined()
    expect(pickLatestVersion({})).toBeUndefined()
    expect(pickLatestVersion([{ name: 'not-a-version' }])).toBeUndefined()
  })
})

describe('ClientVersionResolver', () => {
  it('没有缓存、拉不到时用内置兜底', () => {
    const resolver = new ClientVersionResolver({
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    })
    expect(resolver.current()).toBe(BUNDLED_CLIENT_VERSION)
  })

  it('拉到的版本比内置值新时采纳', async () => {
    const resolver = new ClientVersionResolver({
      fetchImpl: (async () => new Response(JSON.stringify([{ tag_name: 'v9.9.9' }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    })
    await resolver.refresh()
    expect(resolver.current()).toBe('9.9.9')
  })

  it('**只升不降**：拉到更旧的版本不采纳', async () => {
    const resolver = new ClientVersionResolver({
      fetchImpl: (async () => new Response(JSON.stringify([{ tag_name: 'v0.0.1' }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    })
    await resolver.refresh()
    expect(resolver.current()).toBe(BUNDLED_CLIENT_VERSION)
  })

  it('显式 override 完全取代自动发现，且不再发请求', async () => {
    let called = false
    const resolver = new ClientVersionResolver({
      override: '1.1.94',
      fetchImpl: (async () => {
        called = true
        return new Response('[]', { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(resolver.current()).toBe('1.1.94')
    await resolver.refresh()
    expect(called).toBe(false)
  })

  it('形状不成形的 override 被忽略（退回自动发现）', () => {
    const resolver = new ClientVersionResolver({ override: 'not-a-version' })
    expect(resolver.current()).toBe(BUNDLED_CLIENT_VERSION)
  })

  it('并发 refresh 只打一次上游', async () => {
    let calls = 0
    const resolver = new ClientVersionResolver({
      fetchImpl: (async () => {
        calls += 1
        return new Response(JSON.stringify([{ tag_name: 'v9.9.9' }]), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await Promise.all([resolver.refresh(), resolver.refresh(), resolver.refresh()])
    expect(calls).toBe(1)
  })

  it('缓存 TTL 内不重复拉取；过期后重拉', async () => {
    let nowMs = 1_700_000_000_000
    let calls = 0
    const resolver = new ClientVersionResolver({
      now: () => nowMs,
      fetchImpl: (async () => {
        calls += 1
        return new Response(JSON.stringify([{ tag_name: 'v9.9.9' }]), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await resolver.refresh()
    expect(calls).toBe(1)
    await resolver.refresh()
    expect(calls).toBe(1)
    nowMs += CLIENT_VERSION_TTL_MS + 1
    await resolver.refresh()
    expect(calls).toBe(2)
  })

  it('缓存文件读得回来（重启后不必立刻重拉）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qoder-ver-'))
    try {
      const path = join(dir, 'cache.json')
      await writeFile(path, JSON.stringify({ version: '9.9.9', fetchedAtMs: Date.now() }), 'utf8')
      let called = false
      const resolver = new ClientVersionResolver({
        cachePath: path,
        fetchImpl: (async () => {
          called = true
          return new Response('[]', { status: 200 })
        }) as unknown as typeof fetch,
      })
      await resolver.refresh()
      expect(resolver.current()).toBe('9.9.9')
      expect(called).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('缓存文件坏掉不抛，退回兜底', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qoder-ver-'))
    try {
      const path = join(dir, 'cache.json')
      await writeFile(path, '{ not json', 'utf8')
      const resolver = new ClientVersionResolver({
        cachePath: path,
        fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
      })
      await expect(resolver.refresh()).resolves.toBe(BUNDLED_CLIENT_VERSION)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
