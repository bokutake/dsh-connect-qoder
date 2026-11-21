/**
 * 上游节点发现（`/api/v3/service/region/endpoints`）。
 *
 * ## 为什么要有这个模块
 *
 * 官方客户端不是「把请求打向一个写死的域名」的：它先向 **center** 节点要一份
 * 节点表，再从表里选一个 inference 节点把聊天请求打过去。同一份节点表把
 * center / inference / securityInference / openapi 分开列出 —— 因为它们的容量与
 * 计费口径不是一个东西。
 *
 * 我们此前把 `gateway` 写死在 `QODER_REGIONS` 里，于是聊天永远打同一个主机。
 * 后果不是「慢一点」：撞到该主机当天的额度/分区限制就整个不可用，而同一账号
 * 换一个 inference 节点是能用的（`pi-provider-qoder` 的注释记下了这个现象：
 * 发到某一类节点会得到 `403 code 110 "Billing daily count exceeded"`，而 CLI
 * 同一账号成功）。
 *
 * ## 字段以真实客户端为准，不照抄 pi
 *
 * `pi-provider-qoder/src/endpoints.ts` 的解析假设了一组字段
 * （`inferNodes` / `dataNodeMap.remote_agent` / `security` / `centerNodes`）。
 * 其中 **`dataNodeMap.remote_agent` 在真实客户端的响应里不存在**：客户端读的是
 *
 * ```js
 * // qoder-worker-runtime.obf.mjs, k$c 的分支
 * let s = cAt(o.centerNodes), g = cAt(o.inferNodes),
 *     l = A$c(o.fastMode),   c = ite,
 *     B = cAt(o.security),   Q = cAt(o.openapiNodes)
 * ```
 *
 * 另外还有一条 v5 形状（`createEndpointTopology`）：`{version:"v3" ? A.data : ...}`
 * 读的是 `A.data.{centerNodes,inferNodes,security,openapiNodes}` —— 即整个表可能
 * 被包在 `data` 里。两种形状这里都接受。
 *
 * 节点项可以是字符串，也可以是 `{url, type}`；`type` 为 `enterprise` 的在
 * 非企业环境要跳过（客户端 `A$c`：`if(!k9i(e)||P9i()&&"enterprise"===e)continue`）。
 *
 * ## 缓存
 *
 * 客户端每 5 分钟（`B9i = 3e5`）刷新一次，并对选举加 1 秒超时（`NCn=2e3` /
 * `1e3` 两处）—— 超时就退回环境默认端点，**绝不让发现拖慢首包**。这里照此办理：
 * 发现失败/超时一律静默退回 `region.gateway`，聊天照常。
 *
 * @module dsh-connect-qoder/endpoints
 */

/** 一地区发现到的节点集合（只用得到的部分）。 */
export interface QoderDiscoveredNodes {
  /** 中心节点（发现请求本身、以及部分控制面）。 */
  center: string[]
  /** 推理节点 —— 聊天请求该去这里。 */
  inference: string[]
  /** 安全推理节点（codebase/安全类负载）。 */
  securityInference: string[]
  /** OpenAPI 节点（用量/计划/签到）。 */
  openapi: string[]
}

/** 节点类型（客户端 `Vg` 模块的常量）。 */
export type QoderNodeKind = keyof QoderDiscoveredNodes

/**
 * 发现端点路径。
 *
 * `v3` 是客户端 `aAt` / `Axg` 用的那条；`v5`（`I9i` / `txg`，前缀 `/algo`）是
 * 同一份表的另一个版本。只打 v3：v5 在客户端里是可选/灰度路径，且返回形状
 * 还需 `data` 包装，多打一条没有收益。
 */
export const REGION_ENDPOINTS_PATH = '/api/v3/service/region/endpoints'

/** 与客户端 `B9i = 3e5` 同值：5 分钟。 */
export const ENDPOINTS_TTL_MS = 5 * 60 * 1000

/** 与客户端选举超时同量级：发现失败要立刻退回默认，不能拖慢首包。 */
export const ENDPOINTS_TIMEOUT_MS = 1_000

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * 规范成 `https://host/` 形式；无效项返回 undefined。
 *
 * 与 pi 的 `normalizeBaseUrl` 同法：允许上游只给主机名（客户端也这么处理：
 * `/^[a-z][a-z\d+.-]*:\/\//i.test(A) ? A : \`https://${A}\``）。
 */
export function normalizeNodeUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.endsWith('/') ? withScheme : `${withScheme}/`
}

/**
 * 解析一条节点数组。
 *
 * `enterprise` 类型的节点在这里**一律跳过**：本插件走个人 PAT，不是企业环境，
 * 而客户端在非企业环境下也是跳过它们的（`A$c`）。把企业节点当普通节点轮换，
 * 只会撞到「该节点不接受你」的 403。
 */
function parseNodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    let raw: string | undefined
    if (typeof item === 'string') {
      raw = item
    } else {
      const record = asRecord(item)
      if (record === undefined) continue
      const type = typeof record.type === 'string' ? record.type : 'public'
      if (type === 'enterprise') continue
      if (typeof record.url !== 'string') continue
      raw = record.url
    }
    const normalized = normalizeNodeUrl(raw)
    if (normalized === undefined || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * 解析发现响应。整体形状不成立时返回 undefined（调用方退回默认网关）。
 *
 * 接受两种包装：直接在根上（`{centerNodes,...}`），或包在 `data` 里
 * （`{version, data:{centerNodes,...}}`，客户端 `createEndpointTopology` 的形状）。
 *
 * 只要**有任何一个**节点列表非空就算成功 —— 与客户端一致（它的
 * `createEndpointTopology` 只在「所有集合都空」时才放弃）。
 */
export function parseRegionEndpoints(payload: unknown): QoderDiscoveredNodes | undefined {
  const root = asRecord(payload)
  if (root === undefined) return undefined
  const data = asRecord(root.data)
  // 先看 data 包装，再退回根 —— 两种形状的字段名一致。
  const source = data ?? root
  const nodes: QoderDiscoveredNodes = {
    center: parseNodes(source.centerNodes),
    inference: parseNodes(source.inferNodes),
    securityInference: parseNodes(source.security),
    openapi: parseNodes(source.openapiNodes),
  }
  const any = nodes.center.length + nodes.inference.length + nodes.securityInference.length + nodes.openapi.length
  return any === 0 ? undefined : nodes
}

/**
 * 把「上一次用的节点」排到最前，其余保持原序。
 *
 * 这就是客户端 `orderEndpointSet` 的做法（`let t = ...candidates[0]?.origin`，
 * 然后把 `t` 提到首位）：**上次成功的节点优先**，但不丢弃其余候选。这样既不会
 * 每轮跳节点（跳节点等于丢 KV cache），又能在它坏掉时自然滑到下一个。
 */
export function orderWithLastFirst(nodes: string[], lastUsed: string | undefined): string[] {
  if (lastUsed === undefined || !nodes.includes(lastUsed)) return nodes.slice()
  return [lastUsed, ...nodes.filter(node => node !== lastUsed)]
}

/**
 * 缓存节点表。
 *
 * 刻意用**实例**而不是模块级单例：上游客户端在测试里会被反复新建，模块级状态
 * 会让测试互相污染（pi 那边为此专门加了 `QODER_ENDPOINTS_CACHE_PATH` 环境变量
 * 来隔离，说明模块级状态确实咬过人）。
 */
export class QoderEndpointCache {
  private nodes: QoderDiscoveredNodes | undefined
  private fetchedAtMs = 0

  constructor(private readonly ttlMs: number = ENDPOINTS_TTL_MS) {}

  /** 缓存是否仍然新鲜。 */
  isFresh(nowMs = Date.now()): boolean {
    return this.nodes !== undefined && nowMs - this.fetchedAtMs < this.ttlMs
  }

  /** 读缓存（不新鲜则为 undefined）。 */
  read(nowMs = Date.now()): QoderDiscoveredNodes | undefined {
    return this.isFresh(nowMs) ? this.nodes : undefined
  }

  /** 写入缓存。 */
  write(nodes: QoderDiscoveredNodes, nowMs = Date.now()): void {
    this.nodes = nodes
    this.fetchedAtMs = nowMs
  }

  /** 清空（登出/换账号时用：节点表按账号下发）。 */
  clear(): void {
    this.nodes = undefined
    this.fetchedAtMs = 0
  }
}
