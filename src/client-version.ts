/**
 * 我们向 Qoder 声明的**客户端版本号**——全插件唯一的来源。
 *
 * ## 为什么不能硬编一个数
 *
 * 这个值同时出现在三个地方，三处必须同值：
 *
 * 1. `cosy-version` 请求头；
 * 2. `Authorization: Bearer COSY.<payload>` 载荷里的 `cosyVersion`（实测抓包
 *    解出的载荷是 `{version:"v1", requestId, info, cosyVersion:"1.1.94",
 *    ideVersion:""}`，与请求头逐字相同）；
 * 3. 请求体 `business.version`。
 *
 * ## 为什么不能填「一个看起来新」的编造值
 *
 * 服务端如果按这个字段核对客户端版本，那么一个**不存在**的版本号比一个「旧但
 * 真实」的版本号更显眼——旧版本是合法历史，不存在的版本是筛出来的异常。所以
 * 这里的取值顺序是「真实的版本号」优先，而不是「最大的数字」优先：
 *
 * 1. 用户显式配置的值（{@link resolveClientVersion} 的 `override`）；
 * 2. 从 Qoder 自己的 releases 接口拿到的最新 CLI 版本（真实存在）；
 * 3. 内置兜底 {@link BUNDLED_CLIENT_VERSION}（一个确实发布过的版本）。
 *
 * 这与 magpie 的取法不同：它把 `1.1.69` 写死，注释说「跟随 App 而非 CLI」，
 * 同时声称 `Cosy-ClientType: 10`（桌面通道）。那是自洽的，但我们是 CLI 通道
 * （`cosy-clienttype: 5`），所以版本也该跟 CLI。
 *
 * ## 只升不降
 *
 * 缓存里的值一旦比内置值新就保留，**不因为某次拉取失败或接口回退而降低**：
 * 版本号回退意味着「用新版本跑过之后又退回旧版本」，那在服务端看起来同样是
 * 异常行为，而它只会由我们这边的网络抖动引起，不是真实情况。
 *
 * @module dsh-connect-qoder/client-version
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 内置兜底：一个**确实发布过**的 CN CLI 版本（实测抓包用的就是它）。 */
export const BUNDLED_CLIENT_VERSION = '1.1.94'

/** Qoder CLI 的发布列表（两个区域共用，返回的是公开的版本清单）。 */
export const QODER_CLI_RELEASES_URL =
  'https://repo.qoder.com/repos/QoderAI/changelog-CLI/releases?per_page=5&page=1'

/** 缓存有效期：24 小时。 */
export const CLIENT_VERSION_TTL_MS = 24 * 60 * 60 * 1000

/** 拉取超时：拿不到就用缓存/兜底，不能让目录请求等着它。 */
const FETCH_TIMEOUT_MS = 3_000

/** 缓存文件名（放在 `$DSH_HOME` 下，与其它状态文件同级）。 */
export const CLIENT_VERSION_CACHE_FILENAME = '.qoder-cli-version-cache.json'

interface VersionCache {
  version: string
  fetchedAtMs: number
}

/**
 * 比较两个 `major.minor.patch` 形状的版本号。
 *
 * 只认三段纯数字；任一侧形状不对时返回 `undefined`（调用方按「比不出来」处理，
 * 保守地不采用新值）。预发布后缀（`-beta.1`）在 Qoder CLI 的发布里不存在，
 * 出现时整段丢掉。
 */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string): number[] | undefined => {
    const core = v.trim().split('-')[0] ?? ''
    const parts = core.split('.')
    if (parts.length !== 3) return undefined
    const nums = parts.map(p => (/^\d+$/.test(p) ? Number(p) : Number.NaN))
    return nums.every(n => Number.isSafeInteger(n) && n >= 0) ? nums : undefined
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa === undefined || pb === undefined) return undefined
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 从 releases 接口的响应里取最新的、形状合法的版本号。 */
export function pickLatestVersion(body: unknown): string | undefined {
  const list = Array.isArray(body)
    ? body
    : (typeof body === 'object' && body !== null && Array.isArray((body as Record<string, unknown>)['data']))
      ? (body as Record<string, unknown>)['data'] as unknown[]
      : []
  let best: string | undefined
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    // 两种形状都见过：`{tag_name}` / `{name}`，以及带 `v` 前缀的写法。
    const candidate = [raw['tag_name'], raw['name'], raw['version']]
      .find(v => typeof v === 'string' && v.trim() !== '')
    if (typeof candidate !== 'string') continue
    const version = candidate.trim().replace(/^v/i, '')
    if (compareVersions(version, '0.0.0') === undefined) continue
    if (best === undefined || (compareVersions(version, best) ?? 0) > 0) best = version
  }
  return best
}

/**
 * 版本的解析器。
 *
 * 一个实例一份状态：缓存路径可注入（测试用），`fetchImpl` 可注入（离线测试）。
 */
export class ClientVersionResolver {
  private cached: VersionCache | undefined
  private loading: Promise<string> | undefined

  constructor(
    private readonly options: {
      cachePath?: string
      fetchImpl?: typeof fetch
      /** 显式配置的值：给了就**完全**取代自动发现。 */
      override?: string
      now?: () => number
    } = {},
  ) {}

  /** 当前该用的版本号。同步返回，永不抛。 */
  current(): string {
    const override = this.options.override?.trim()
    if (override !== undefined && compareVersions(override, '0.0.0') !== undefined) return override
    const cached = this.cached?.version
    if (cached !== undefined && (compareVersions(cached, BUNDLED_CLIENT_VERSION) ?? 0) > 0) return cached
    return BUNDLED_CLIENT_VERSION
  }

  /**
   * 必要时刷新一次缓存。**永不抛**，失败就保持现状。
   *
   * 并发调用共享同一次拉取（`loading`），避免一次启动里打十几次 releases。
   */
  async refresh(): Promise<string> {
    if (this.options.override?.trim() !== undefined && this.options.override.trim() !== '') {
      return this.current()
    }
    const now = this.options.now?.() ?? Date.now()
    if (this.cached !== undefined && now - this.cached.fetchedAtMs < CLIENT_VERSION_TTL_MS) {
      return this.current()
    }
    if (this.loading !== undefined) return this.loading
    this.loading = this.load(now).finally(() => { this.loading = undefined })
    return this.loading
  }

  private async load(now: number): Promise<string> {
    const path = this.options.cachePath
    if (this.cached === undefined && path !== undefined) {
      const fromDisk = await this.readCache(path)
      if (fromDisk !== undefined) {
        this.cached = fromDisk
        if (now - fromDisk.fetchedAtMs < CLIENT_VERSION_TTL_MS) return this.current()
      }
    }
    const fetched = await this.fetchLatest()
    if (fetched !== undefined) {
      // 只在**比现有值新**时采纳：发布列表里可能有比当前更旧的条目被置顶，
      // 也可能拿到一个回退的版本号。两种都不该让我们降版本。
      const isNewer = (compareVersions(fetched, this.current()) ?? 0) > 0
      if (isNewer) {
        this.cached = { version: fetched, fetchedAtMs: now }
        if (path !== undefined) await this.writeCache(path, this.cached)
      } else if (this.cached === undefined) {
        // 拉到了但不比内置值新：仍然记下时间戳，免得每个请求都重试。
        this.cached = { version: this.current(), fetchedAtMs: now }
        if (path !== undefined) await this.writeCache(path, this.cached)
      }
    }
    return this.current()
  }

  private async fetchLatest(): Promise<string | undefined> {
    const impl = this.options.fetchImpl ?? globalThis.fetch
    if (typeof impl !== 'function') return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    // 定时器不该把进程钉住（测试里尤其明显）。
    ;(timer as unknown as { unref?: () => void }).unref?.()
    try {
      const res = await impl(QODER_CLI_RELEASES_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) return undefined
      return pickLatestVersion(await res.json())
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  private async readCache(path: string): Promise<VersionCache | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const raw = parsed as Record<string, unknown>
      const version = raw['version']
      const fetchedAtMs = raw['fetchedAtMs']
      if (typeof version !== 'string' || compareVersions(version, '0.0.0') === undefined) return undefined
      if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0) return undefined
      return { version, fetchedAtMs }
    } catch {
      return undefined
    }
  }

  private async writeCache(path: string, cache: VersionCache): Promise<void> {
    try {
      await writeFile(path, JSON.stringify(cache, null, 2), 'utf8')
    } catch {
      // 缓存写不进去只影响下次是否重新拉取，不影响本次请求。
    }
  }
}

/**
 * 解析版本号的便捷入口：给一个 `$DSH_HOME`，返回该用的版本。
 *
 * 供 `bin.ts` / `index.ts` 这种「没有实例状态」的场景使用。
 */
export function resolveClientVersion(home: string, override?: string): ClientVersionResolver {
  return new ClientVersionResolver({
    cachePath: join(home, CLIENT_VERSION_CACHE_FILENAME),
    ...(override === undefined ? {} : { override }),
  })
}
