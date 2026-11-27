/**
 * Qoder 上游 HTTP 客户端：cosy 签名请求、jobToken 交换、聊天 SSE、
 * 模型目录与用量查询。
 *
 * 端点映射（CN 与 Global 双区域）。两区域**各自一个网关主机**，chat / models /
 * jobToken 三个端点共用它（见 `QODER_REGIONS` 的 `gateway` 字段）：
 *
 * ```text
 * CN     gateway: gateway.qoder.com.cn
 *        chat:     /algo/api/v2/service/pro/sse/agent_chat_generation
 *        models:   /algo/api/v2/model/list
 *        jobToken: /algo/api/v3/user/jobToken
 *        openapi:  openapi.qoder.com.cn
 * Global gateway: api1.qoder.sh
 *        chat:     /algo/api/v2/service/pro/sse/agent_chat_generation
 *        models:   /algo/api/v2/model/list
 *        jobToken: /algo/api/v3/user/jobToken
 *        openapi:  openapi.qoder.sh
 * ```
 *
 * 注：早期注释称国际版的 models 走 `api2.qoder.sh`、jobToken 走
 * `center.qoder.sh`。实测（2026-10）三者对本插件用到的端点**完全等效**——
 * 对同一个假 PAT 都回 `401 personal token is invalid`（凭据层被拒，而非
 * `Signature invalid`），说明三者都接受同一套 cosy 签名、只是拒绝坏凭据。
 * 所以国际版统一用 `api1.qoder.sh`，不按端点分主机；若将来真要分流，请改
 * `QODER_REGIONS` 的配置表，而不是只改这段注释。
 *
 * @module dsh-connect-qoder/upstream
 */

import {
  buildPayloadB64,
  composeBearer,
  cosyEncode,
  currentRfc1123Date,
  deriveFingerprint,
  newCosySession,
  pathSigFrom,
  signLegacy,
  signRequest,
  type CosyFingerprint,
  type CosySessionContext,
} from './cosy.ts'
import {
  createChatBodyTemplate,
  buildQoderMessages,
  extractLatestUserPrompt,
  deepClone,
  applyModelKey,
  applyBusinessIdentity,
  applyCacheControl,
  sessionTypeOf,
  type QoderChatTemplate,
  type QoderBusinessProduct,
  type QoderBusinessStage,
} from './messages.ts'
import { readDeviceRisk } from './device-risk.ts'
import {
  identityHeaders,
  localMachineEnv,
  resolveDeviceIdentity,
  type QoderDeviceIdentity,
  type QoderIdentityOverride,
  type DeviceIdentityMode as QoderDeviceIdentityMode,
} from './device-identity.ts'
import { ClientVersionResolver } from './client-version.ts'
import { QODER_UPSTREAM_DOMAIN } from './status-paths.ts'
import { isRouterModelId } from './native-modality.ts'
import { QODER_CONNECT_VERSION } from './version.ts'
import {
  REGION_ENDPOINTS_PATH,
  ENDPOINTS_TIMEOUT_MS,
  orderWithLastFirst,
  parseRegionEndpoints,
  QoderEndpointCache,
} from './endpoints.ts'

// ---------------------------------------------------------------------------
// 区域
// ---------------------------------------------------------------------------

export type QoderRegion = 'cn' | 'global'

export interface QoderRegionConfig {
  /** 网关主机（chat / models / jobToken 共用）。 */
  gateway: string
  /** OpenAPI 主机（用量/计划/签到等 sash 接口）。 */
  openapi: string
  /** SSE 聊天端点。 */
  chatPath: string
  /** 模型目录端点。 */
  modelsPath: string
  /** jobToken 交换端点。 */
  jobTokenPath: string
  /** 每日签到的活动列表端点（sash 的 v1 campaigns）。 */
  campaignsPath: string
  /**
   * 该区域的签到是否需要**设备风控头**（`Cosy-MachineToken/Code/Type`）。
   *
   * 国际版为 true：它的签到活动只下发给带这些头的请求，缺了拿不到活动列表
   * （实测端点存在，返回 401 而不是 404）。国内版为 false —— 实测不需要，
   * 多发反而在另一侧成为噪音。三件套由本机 UMID 组件生成，见 device-risk.ts。
   */
  requiresDeviceRisk: boolean
}

/** 一条活动（`GET /sash/api/v1/me/campaigns` 的条目，只取用得到的字段）。 */
export interface QoderCampaign {
  campaignId: string
  /** `CLAIM_BENEFIT` = 可领权益；`VIEW_DETAILS` = 纯展示（banner / 集结）。 */
  actionType: string
  /** `CLAIMABLE` = 今天可领；`CLAIMED` = 已领。 */
  claimStatus: string
  /** 奖励数额（Credits），来自 `benefit.amount`。 */
  amount?: number
  /**
   * 有效期天数，来自 `benefit.validity.days`。
   *
   * 只在 `validity.mode === 'RELATIVE_DAYS'` 时给出 —— 「领取后再过 N 天作废」
   * 这个口径成立的前提是**相对**。上游若哪天改成 `ABSOLUTE`（给一个绝对时刻），
   * 天数就不再是那个意思，这里会**不写** `validityDays`：宁可不显示到期，也不
   * 拿一个口径不对的数字去算「什么时候作废」（issue #31 建议 3）。
   */
  validityDays?: number
  /**
   * 这条活动**开窗**的时刻（epoch **秒** —— 上游给的就是秒，不是毫秒）。
   *
   * 实测（`campaignKey: act-20261009-057`）：`startAt` = 当天 10:00:00 UTC+8，
   * `endAt` = 次日 09:59:00 UTC+8，与活动文案「每日 10:00（UTC+8）刷新」一致。
   * 所以「下一次刷新还有多久」是**上游给的**，不是本地按零点或「上次领取 +24h」
   * 猜出来的 —— 用户实拍里那个 `09:22:23` 就是 `endAt − 当前时间`。
   */
  startAt?: number
  /** 这条活动**关窗**的时刻（epoch 秒），即下一次刷新的时刻。 */
  endAt?: number
  /** 上游的活动键（如 `act-20261021-587`），只作展示用。 */
  campaignKey?: string
  /** 这条活动的落地页：`placements[*].campaignUrl` 的第一个，缺则顶层 `campaignUrl`。 */
  campaignUrl?: string
  /**
   * `placements[*].content` 按语言收拢后的**卡片文案**（`zh` / `en` 各一份，可能都缺）。
   *
   * 「1024 创造力集结」「首月订阅 Credits 翻倍」这类 banner 的标题、描述与
   * 「查看详情」链接就在这儿 —— 上游只下发它有的语言，这里不做翻译、不编造。
   */
  content?: Record<string, QoderCampaignContent>
}

/** 一条活动卡片文案（某一语言）。 */
export interface QoderCampaignContent {
  title?: string
  description?: string
  detailUrl?: string
  buttonText?: string
}

/** `GET /sash/api/v1/me/campaigns` 的整份响应（含活动列表之外的顶层字段）。 */
export interface QoderCampaignFeed {
  campaigns: QoderCampaign[]
  /** 顶层活动落地页（成长页 iframe）；某条活动缺 `detailUrl` 时的兜底链接。 */
  campaignUrl?: string
  /** 上游显式说「这次不下发活动」（开关 / 非目标人群）。 */
  showCampaign?: boolean
  /** 上游显式说「本次不可领」。 */
  claimable?: boolean
}

/** 一次签到尝试的结果。 */
export type QoderCheckinOutcome =
  | {
      status: 'claimed'
      amount?: number
      validityDays?: number
      /**
       * 下一窗的开门时刻（epoch 毫秒，来自上游 `endAt` × 1000）。
       *
       * 领取**不是**「今天到此为止」—— 领取只是把这一窗从 `CLAIMABLE` 变成
       * `CLAIMED`，而下一窗什么时候开上游早就写在了 `endAt` 里。没有它，UI 只能
       * 说「已领取」，用户会以为要等到明天零点（用户实拍：领取后页面上的倒计时
       * 才是正确的那个数）。
       */
      nextRefreshAtMs?: number
    }
  | { status: 'already-claimed', nextRefreshAtMs?: number }
  | { status: 'unavailable', message: string }

const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
/**
 * 轮次闭合端点。官方客户端在一轮用户提示结束时**必发**一次（实测：每轮恰好
 * 1 次，与补全次数无关 —— 一轮 2 次补全仍是 1 次闭合）。
 *
 * 客户端源码里的位置是 `business/finish`（`Qd.finish()`），body 形状见
 * {@link QoderUpstreamClient.finishTurn} 的使用处。
 *
 * 不发它，服务端只能等 TTL 释放租约：那一轮在记账上永远是「进行中」，控制台
 * 里也就不产生逐条消费行 —— 这正是本插件长期缺的那一环。
 */
const FINISH_PATH = '/algo/api/v2/service/business/finish?Encode=1'
/**
 * 每日签到走 `sash` 的**活动**接口。路径里没有「签到」二字（叫 campaigns），
 * 所以照着 checkin / signin / reward 猜永远猜不到——实测猜了 13 个全 404。
 * 注意是 **v1**（用量那套是 v2）。
 */
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
/**
 * sash 面专用的令牌交换端点（CLI / 网页那一族）。
 *
 * 与 {@link JOB_TOKEN_PATH}（桌面客户端那一族）**并存**，不是替代 —— 实测国际版
 * 的 chat 面只认前者换来的 `securityOauthToken`，而 sash / 额度面只认这里换来的
 * `token`；国内版两族等价。见 `QoderSessionHolder.sashToken`。
 */
const SASH_TOKEN_PATH = '/api/v1/jobToken/exchange'
const CAMPAIGNS_QUERY = '?forceRefresh=true'
/** sash 接口要求的客户端标识（参考实现如此，缺了会被拒）。 */
const SASH_CLIENT_TYPE = '10'
const SASH_USER_AGENT = 'Qoder'
/**
 * **cosy 面**（chat + models）的客户端身份：`cosy-clienttype` 与 `cosy-version`。
 *
 * 上游按这两个头决定下发哪一套模型目录。旧值 `5` / `0.1.43` 是 2026-10-11 写下
 * 时正确的身份，那时上游还没有 Sonus/Cantus/Fast；上游后来把新模型只发给新
 * 协议，于是旧身份拿到的是**静默的旧目录**——目录照常返回、对话照常能跑，只是
 * 少几个模型，没有任何报错指向这里（issue #21）。
 *
 * 实测（2026-10-29，两个区域各一枚真实 PAT，只读目录 + 一次对话）：
 *
 * | 区域   | `5` / `0.1.43` | `10` / `1.1.69`        |
 * | ------ | -------------- | ---------------------- |
 * | cn     | 9 条           | 10 条（+`fast`）       |
 * | global | 11 条          | 14 条（+`smodel`/`cmodel`/`fast`） |
 *
 * 两个值必须**成对**改：国内版只把 clienttype 提到 `10`、version 留在 `0.1.43`
 * 时，目录仍只有 9 条（拿不到 `fast`），而 chat 直接报
 * `HTTP 403 code 112`（「协议半改」的坏状态）。成对改之后 chat 两个区域都正常
 * 吐字，`qfmodel` / `dfmodel` 与新增的 `fast` / `smodel` 都实测通过。
 *
 * ## `clienttype` 为什么是 `5` 不是 `10`（2026-11-21 抓包纠正）
 *
 * 上面那次是**只读探测**得出的「能拿到更多模型」的组合，不是「真实客户端发什么」。
 * 对官方 CN CLI（qoderclicn 1.1.94）实测抓包 105 个请求，`cosy-clienttype`
 * **全部是 `5`**，一次 `10` 都没有；同时它的目录里 13 个模型一个不少
 * （`auto`/`fast`/`qmodel_latest`/`qmodel_38max`/`qfmodel`/`dmodel`/`dfmodel`/
 * `gmodel`/`gfmodel`/`kmodel_latest`/`kmodel`/`jmodel`/`mmodel`）。
 *
 * 所以 `10` 是「桌面 App 通道」的值（magpie 至今用它，并配套 `product: app`、
 * `Cosy-Version: 1.1.69`）。我们用 `cli` 产品线、走 PAT，就该是 `5` —— 与真实
 * CLI 逐字一致，同时并不损失目录。**`10` 曾解决的是旧 `0.1.43` 版本号的目录
 * 缩水问题，那个问题的真解是把版本号提上去，不是把 clienttype 换成桌面通道。**
 *
 * `cosy-version` 不再在这里写死：它必须与 bearer 载荷里的 `cosyVersion` 同值，
 * 由 {@link QoderUpstreamClient.clientVersion} 统一提供（见 `client-version.ts`）。
 *
 * 与 sash 面**无关**：`sashRequest` / `fetchUsageDirect` / `jobTokenGet` 是逐条
 * 手写请求头，没有展开 {@link DEFAULT_HEADERS}，所以这条改动碰不到签到与用量
 * （实测改完两个区域的用量与活动列表照常 200）。
 */
const COSY_CLIENT_TYPE = '5'
const MODELS_PATH = '/algo/api/v2/model/list?Encode=1'
const JOB_TOKEN_PATH = '/algo/api/v3/user/jobToken?Encode=1'

/**
 * 目录响应里我们读哪几个桶，顺序即优先级（issue #3）。
 *
 * 上游的 `/model/list` 返回的是**按场景分的对象**，不是模型数组：
 *
 * ```text
 * chat(14) developer(12) assistant(14) inline(10) quest(12) qwork(10)
 * experts(6) qwake(14) app(14) qcode(3) byok_teams(0) byok_enterprise(0)
 * ```
 *
 * 此前只读 `chat`。实测（ct=10）：`chat ⊆ assistant`、`chat ⊆ app`，两者都只多
 * 一个 `hmodel`（HungerG）；`qwake` 与 `chat` 完全相同，其余桶都是 `chat` 的
 * **子集**。所以并这三个桶恰好等于"`chat` + 活动模型"，不会把 IDE / 团队场景的
 * 残缺列表（`qcode` 只有 3 条）混进来。
 */
const CATALOG_BUCKETS = ['chat', 'assistant', 'app'] as const

/**
 * `business.product` 的默认值：`cli`。
 *
 * 官方客户端有两条产品线，**默认值不同**：
 *
 * | 通道 | `product` | 证据 |
 * | --- | --- | --- |
 * | CLI / PAT | `cli` | `MKA = "cli"`，`Cs()` → `product: rtA() ?? process.env[...] ?? MKA` |
 * | 桌面 App | `app` | `electronMain.js`：`Od = {clientType:10, businessProduct:"app"}` |
 *
 * 我们这条路径是「PAT → `/algo/api/v3/user/jobToken` → 聊天」，形态上是 CLI
 * 通道，所以默认 `cli`。**这是实测结论，不是推断**：2026-11-21 抓 CN CLI
 * 1.1.94 全程，`cosy-business-product` 出现 6 次，值全是 `cli`。
 *
 * 一条曾经的错误说法（本注释上一版写着、并在 CHANGELOG 里复述过）必须纠正：
 * 它说「`Cosy-Business-Product` 这个头出现 **0 次**，`ide` 是从网页版抄来的
 * 假设」。**头并不缺席** —— 它每次业务请求都带，只是取值在我们这边一直是错的
 * （`ide`，既不是 `cli` 也不是 `app`）。「头不存在」与「头的值抄错了」是两回事，
 * 前者会让人以为根本不用发这个头。
 */
const DEFAULT_BUSINESS_PRODUCT: QoderBusinessProduct = 'cli'

/**
 * 上报给上游的 `business.version` 的兜底值。
 *
 * **正常情况下这个常量不会被用到**：`business.version` 跟随
 * {@link clientVersion}（真实客户端版本号），因为客户端上报的就是自己的版本。
 * 这里只是「连版本号都解析不出来」时的最后一级兜底。
 *
 * 曾经这里默认取**插件版本**（`QODER_CONNECT_VERSION`），理由是「编造一个
 * 不存在的客户端版本，等于在记账里留一条对不上的记录」。理由本身是对的，
 * 结论却错了：插件版本同样不是客户端版本，它在服务端眼里是一个**从未发布过的
 * Qoder 版本号**，比一个「旧但真实」的版本更显眼。真解是拿到真实版本号，
 * 见 `client-version.ts`。
 */
const BUSINESS_VERSION_FALLBACK = '0.0.0-dev'

/**
 * `max_tokens` 的兜底上限。
 *
 * 与官方客户端的 `defaultTokens: 32e3` 同值 —— 这是客户端的**全局默认**，不是
 * 我们发明的数。它只在两层上游信息都缺失时生效：
 *
 * 1. 调用方传入的 `maxOutputTokens`（来自 `/model/list` 的 `max_output_tokens`）；
 * 2. 兜底 32 768。
 *
 * 客户端那套是三层的（`cYa(A,e) = j6r(e) ?? yTg(A)`，`yTg` 查
 * `model_max_output_tokens` 的逐模型表再退 `default`），但那张表在本机
 * **是空的**：它读环境变量 `QODER_CONFIG_MODEL_MAX_OUTPUT_TOKENS`，而
 * `electronMain.js` 里根本不设置这个键（搜到 0 次）。所以官方客户端在同样
 * 条件下发出的也是 32e3 —— 我们与它一致。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768

/**
 * 从上游 400 的报错文案里学 `max_tokens` 的实际上限。
 *
 * 抄的是 magpie（`packages/qoder/index.mjs` 的 `LEARNED_CAPS`）：上游对越界
 * 值的回话是 `Range of max_tokens should be [1, N]`，把 N 取出来记住，下一次
 * 就夹到 N 以内。这比猜一个上限稳 —— 上限会随模型变，而报错文案是上游自己说的。
 */
const MAX_TOKENS_RANGE_RE = /max_tokens[^0-9]{0,40}\[\s*\d+\s*,\s*(\d+)\s*\]/i

/**
 * 轮次表的容量上限。
 *
 * 表按**轮次**存一条短记录（id / begin_at / stage / end_at），512 轮也就几十 KB
 * —— 这个数不是性能调优，是给「表不该无限长」一个明确上界。超出时淘汰**最早**
 * 进来的那一轮（Map 插入序）。被淘汰的轮次不能再闭合（`closeTurn` 返回
 * undefined），代价是那一轮在服务端靠 TTL 收口，而不是被记成别的阶段。
 */
const STAGE_MAP_LIMIT = 512

/**
 * 结束原因 → `business.stage` 终态。逐字照抄客户端 `kVe()`：
 *
 * ```js
 * function kVe(e){switch(e){case"abort":case"repeated_tool_call_denied":return hpe;
 *   case"error":case"max_turns":return gpe;case"end_turn":default:return fpe}}
 * ```
 *
 * 即 `abort` / `repeated_tool_call_denied` → `abort`，`error` / `max_turns` →
 * `error`，其余（含 `end_turn`）→ `complete`。**没有 `default` 之外的兜底值** ——
 * 认不出的原因一律记为 `complete`，与客户端一致。
 */
function endStageOf(reason: QoderTurnEndReason): QoderBusinessStage {
  switch (reason) {
    case 'abort':
    case 'repeated_tool_call_denied':
      return 'abort'
    case 'error':
    case 'max_turns':
      return 'error'
    case 'end_turn':
    default:
      return 'complete'
  }
}

export const QODER_REGIONS: Readonly<Record<QoderRegion, QoderRegionConfig>> = {
  cn: {
    // 主机名只有一处事实（`status-paths.ts` 的 `QODER_UPSTREAM_DOMAIN`），卡片
    // 的「诊断」栏读的也是它——这样「面板上写的域名」与「请求真正打到的域名」
    // 不可能各说一套。
    gateway: `https://${QODER_UPSTREAM_DOMAIN.cn}`,
    openapi: 'https://openapi.qoder.com.cn',
    chatPath: CHAT_PATH,
    modelsPath: MODELS_PATH,
    jobTokenPath: JOB_TOKEN_PATH,
    campaignsPath: CAMPAIGNS_PATH,
    requiresDeviceRisk: false,
  },
  global: {
    gateway: `https://${QODER_UPSTREAM_DOMAIN.global}`,
    openapi: 'https://openapi.qoder.sh',
    chatPath: CHAT_PATH,
    modelsPath: '/algo/api/v2/model/list?Encode=1',
    jobTokenPath: '/algo/api/v3/user/jobToken?Encode=1',
    campaignsPath: CAMPAIGNS_PATH,
    requiresDeviceRisk: true,
  },
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 上游错误分类，供 shim 映射为 DSH 可判定的 code。 */
export type UpstreamErrorKind =
  | 'network'           // 传输层（TLS/EOF/reset/超时）
  | 'auth'              // 401/403：凭证被拒 / 会话过期
  | 'rate-limited'      // 429：限流
  | 'invalid-request'   // 400：请求不合法（重试无意义）
  | 'content-policy'    // 内容审核拒绝
  | 'quota-exhausted'   // 业务 code 表示额度耗尽
  | 'transient'         // 418/5xx/provider_error：瞬时
  | 'unknown'

export class QoderUpstreamError extends Error {
  readonly kind: UpstreamErrorKind
  readonly status: number
  readonly code?: string | undefined
  /**
   * 上游**自己申报**的「请等这么久再试」，毫秒（issue #24）。
   *
   * 来自 `10605 / RESOURCE_LIMIT` 信封里的 `retryAfterSeconds`（实测形状：
   * `{"isQueued":false,"queueCount":0,"retryAfterSeconds":5,"serviceAvailable":true}`），
   * 或 HTTP `Retry-After` 头。取不到就是 `undefined` —— 「上游没说」与「上游说
   * 等 0 秒」是两件事，抽取层不替它下结论。
   *
   * 这个值的去向有两处，都必须有：①写进给宿主的失败文案（否则用户只看到
   * 「上游报了个 4xx」，看不到「上游只要求等 5 秒」）；②非流式失败响应上的
   * `Retry-After` 头。宿主在 pi-ai 那条路由上**只从文案分类**，不读头，所以
   * ①是唯一能让「申报值」影响等待的一条。
   */
  readonly retryAfterMs?: number | undefined
  /**
   * 上游说「我在排队」的证据（issue #26）。
   *
   * 与 {@link retryAfterMs} 分开是因为它们是**两件事**：`retryAfterMs` 说
   * 「等多久再来」，`queue` 说「你现在排在第几位、服务本身是好的」。前者决定
   * 冷却多长，后者决定**怎么跟用户说** —— 把排队说成「连不上上游」是错的
   * （用户实拍：账号完全正常，六个模型同时可用）。
   */
  readonly queue?: QoderQueueState | undefined
  constructor(kind: UpstreamErrorKind, message: string, status = 0, code?: string, retryAfterMs?: number, queue?: QoderQueueState) {
    super(message)
    this.name = 'QoderUpstreamError'
    this.kind = kind
    this.status = status
    this.code = code
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.retryAfterMs = retryAfterMs
    }
    if (queue !== undefined) {
      this.queue = queue
    }
  }
}

/**
 * 上游的排队状态（issue #26 的实测信封）。
 *
 * 实测形状（HTTP 403 + `code 10605`）：
 *
 * ```json
 * {"code":"10605","message":{"isQueued":true,"modelKey":"dfmodel",
 *   "queueCount":1027,"queueType":"p3","retryAfterSeconds":30,
 *   "serviceAvailable":true,"subCode":"CALL_COUNT_LIMIT","waitTime":119}}
 * ```
 *
 * `isQueued:true` + `serviceAvailable:true` 的意思是「**服务是好的**，你排在
 * 队列第 1027 位，30 秒后再来」。上游说得很清楚，插件此前把它读成了「连不上
 * 上游」。
 */
export interface QoderQueueState {
  /** 上游明确说了「在排队」。 */
  isQueued: boolean
  /** 队列里的人头数（上游给的，不是本地估的）。 */
  queueCount?: number
  /** 队列类型（上游的 p1/p2/p3 之类）。 */
  queueType?: string
  /** 上游申报的等待秒数；与 `retryAfterMs` 同源，但保留原始单位。 */
  retryAfterSeconds?: number
  /**
   * 上游自己说「服务本身可用吗」（issue #29）。
   *
   * 这个字段把两种形态分开，而它们此前被压成同一个 `queued`：
   *
   * - `isQueued:true` + `serviceAvailable:true` —— 服务是好的，你排在队里
   *   （`queueCount` 通常 > 0）。等等就好，换号也有意义。
   * - `isQueued:true` + `serviceAvailable:false` —— 上游**整体**在拒服务，
   *   现场实测 `queueCount:0`（队列里一个人都没有）。这时换号、换 PAT 都没用
   *   （issue #29 实测 global 区 14 个模型全 queued），把它写进账号级冷却会让
   *   用户以为自己的凭据坏了。
   *
   * 缺席 = 上游没提这个字段；此时沿用旧行为（只按 `isQueued` 判排队），不推断。
   */
  serviceAvailable?: boolean
}

export function isQoderUpstreamError(error: unknown): error is QoderUpstreamError {
  return error instanceof QoderUpstreamError
}

/** jobToken 交换结果。 */
export interface QoderJobToken {
  id: string
  name: string
  expireTime: number
  securityOauthToken: string
  refreshToken: string
  userType: string
}

/** 模型目录条目（服务端 snake_case 原样透传 + 常用字段解析）。 */
export interface QoderUpstreamModel {
  key: string
  display_name: string
  enable: boolean
  is_default: boolean
  is_vl: boolean
  is_reasoning: boolean
  is_free: boolean
  price_factor: number | undefined
  max_input_tokens: number | undefined
  max_output_tokens: number | undefined
  thinking_config: Record<string, unknown> | undefined
  context_config: Record<string, { token_count: number; is_default?: boolean }> | undefined
  /**
   * 该模型**只出现在渠道桶里**（`assistant` / `app`），`chat` 桶没有它（issue #3）。
   *
   * 不设这个字段 = 它来自 `chat` 桶（或同名条目在 `chat` 里也有）。
   */
  channelOnly?: boolean
  /** 其余字段原样保留。 */
  raw: Record<string, unknown>
}

/**
 * 一笔**专属积分包**（issue #38）—— 上游 `qoderUsage.dedicatedResourcePackages[]`。
 *
 * 国际版实测（`GET /sash/api/v2/me/usage`）：
 *
 * ```json
 * [{ "id": "pkg-example", "name": "act-example", "total": 888, "used": 0,
 *    "remaining": 888, "percentage": 0, "unit": "credits",
 *    "expiresAt": 1798732800000, "available": true,
 *    "status": "QUOTA_DETAIL_STATUS_ACTIVE",
 *    "displayLabels": [
 *      { "dimension": "title", "value": "sota model series",
 *        "valueI18n": { "en-US": "SOTA Exclusive Credits", "zh-CN": "SOTA 专属积分" } },
 *      { "dimension": "description", "value": "…",
 *        "valueI18n": { "en-US": "…", "zh-CN": "…" } } ] }]
 * ```
 *
 * 三条「不用自己编」的性质，正是这个类型只透传、不解释的理由：
 *
 *  - **名字上游自己就给了**（`displayLabels` 的 `valueI18n` 带 zh-CN / en-US），
 *    所以 DTO 里存的是**两种语言的原文**，由界面按当前语言挑一条 —— 插件翻译
 *    一个营销词只会在上游改词时落后；
 *  - 它有 `remaining` / `total`，能直接填读数；
 *  - 它有 `status`，`QUOTA_DETAIL_STATUS_ACTIVE` 以外的不该算。
 *
 * ⚠️ 国内版实测 `qoderUsage` 里**没有**这个键，所以这一整块天然只在国际版出现。
 */
export interface QoderDedicatedPackage {
  /** 上游的包 id（同一次报文内唯一；界面用它做 React key）。 */
  id: string
  /** 上游给的**两种语言**标题；两边都没有时才缺席（那时界面不外显这一个包）。 */
  title?: { zh?: string | undefined, en?: string | undefined } | undefined
  /** 上游给的双语说明（「在模型选择器中选择 Sonus 时优先抵扣」）。 */
  description?: { zh?: string | undefined, en?: string | undefined } | undefined
  /**
   * 剩余额度；`undefined` = 上游这一行没报（不是 0）。
   *
   * 与 `creditsOf` 里的积分包同一条规矩：0 是关于账号的一个断言，缺席只是
   * 「这次没读到」。
   */
  remaining?: number | undefined
  total?: number | undefined
  /** 这一包的到期时刻（ms）。有它就能放进悬停，不必另编一个倒计时。 */
  expiresAtMs?: number | undefined
  /** 上游的原始 `status`（`QUOTA_DETAIL_STATUS_ACTIVE` 等），原样保留。 */
  status?: string | undefined
}

/** 用量信息（sash/api/v2/me/usage 的 qoderUsage 形状，官方 SDK UsageInfo 核对）。 */
export interface QoderUsage {
  userType?: string | undefined
  expiresAt?: number | undefined
  upgradeUrl?: string | undefined
  userQuota?: { total?: number | undefined; used?: number | undefined; remaining?: number | undefined; percentage?: number | undefined } | undefined
  addOnQuota?: { total?: number | undefined; used?: number | undefined; remaining?: number | undefined; percentage?: number | undefined; detailUrl?: string | undefined } | undefined
  orgResourcePackage?: { used?: number | undefined; cap?: number | undefined; remaining?: number | undefined; percentage?: number | undefined; available?: boolean | undefined } | undefined
  /**
   * 专属积分包（issue #38）。**只有国际版下发**；国内版实测没有这个键。
   *
   * 缺席 = 这个账号没有（或上游这次没给），不是「读失败」——两者的处理不同：
   * 前者界面不画那一列，后者与「积分读不出来」同路。
   */
  dedicatedResourcePackages?: readonly QoderDedicatedPackage[] | undefined
  isQuotaExceeded?: boolean
}

/** 聊天流增量。 */
export interface QoderChatDelta {
  role: string
  content: string
  reasoningContent: string
  toolCalls: unknown[] | undefined
  inputTokens: number
  outputTokens: number
  /**
   * 命中的缓存 token 数（issue #4）：上游 `prompt_tokens_details.cached_tokens`。
   *
   * **它是 `inputTokens` 的子集，不是额外增量。** 实测（2026-10-22，cn，
   * `qfmodel`）两轮真实请求的原始 usage 块：
   *
   * ```
   * prompt_tokens: 2038, prompt_tokens_details: { cacheable_tokens: 0, cached_tokens: 2032 }
   * prompt_tokens: 2057, prompt_tokens_details: { cacheable_tokens: 0, cached_tokens: 2051 }
   * ```
   *
   * 所以**绝不能**写 `inputTokens = prompt_tokens + cached_tokens`——那是把命中
   * 的前缀算两遍。宿主 `parseChunkUsage` 正是按「子集」理解它的：
   * `input = max(0, prompt_tokens - cacheRead - cacheWrite)`，它要的就是原始的
   * `prompt_tokens` 与 `cached_tokens` 两个数，各自原样交过去即可。
   *
   * `undefined` = 上游这一帧没报（或没给这个字段）。它与「命中 0」是两件事，
   * 别在抽取层把前者写成后者。
   */
  cachedTokens?: number
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface QoderUpstreamOptions {
  logger?: (message: string) => void
  /** 本机指纹盐（可选，混入派生种子）。 */
  installSalt?: string
  fetch?: typeof fetch
  /**
   * `business.product` 的取值（默认 {@link DEFAULT_BUSINESS_PRODUCT}）。
   *
   * 可配置是为了留一条**实测换值的口子**：`cli` 与 `app` 会让服务端把请求归进
   * 不同产品线的记账，而哪一条才是「控制台里能看见消费行」的那条，还没有抓包
   * 定论。写死就没法在不改代码的前提下验证另一条。
   */
  businessProduct?: QoderBusinessProduct
  /** 上报给上游的 `business.version`（默认跟随 {@link clientVersion}）。 */
  businessVersion?: string
  /**
   * 要不要给 system 消息打 `cache_control: ephemeral`（默认**不打**）。
   *
   * 默认关的理由见 {@link applyCacheControl} 的注释：真实客户端只对声明了
   * `capabilities.cacheControl` 的模型才开，而那条路径只服务自定义 provider，
   * Qoder 内建通道的缓存由服务端按 `session_id` 自动做。留这个口子是为了能做
   * A/B 实测，不是因为它该默认开。
   */
  cacheControl?: { type: 'ephemeral'; ttl?: '1h' }
  /**
   * 向 Qoder 声明的**客户端版本**。给了就完全取代 {@link clientVersion} 的
   * 自动发现（releases 接口 + 内置兜底）。
   *
   * 它会同时进 `cosy-version` 头、bearer 载荷的 `cosyVersion`、以及
   * `business.version` —— 三处必须同值，所以只留一个入口。
   */
  clientVersion?: string
  /**
   * 设备身份来源模式（默认 `real`）。见 {@link QoderDeviceIdentityMode}。
   *
   * `real`：本机 `machine_id` 文件 + UMID 组件（取不到则逐字段退回派生）。
   * `derived`：全部从凭据派生（1.27.x 及以前的旧行为）。
   * `manual`：用 {@link identityOverride} 里填的值。
   */
  deviceIdentity?: QoderDeviceIdentityMode
  /**
   * 人工填写的设备身份字段。只在 `deviceIdentity: 'manual'` 时生效，
   * 缺席的字段各自退回默认来源。
   *
   * **这是把双刃剑，默认不提供 UI 入口**：填别人的真实指纹等于伪造设备身份，
   * 填不存在的值比填旧值更容易被筛出来。它的正当用途只有一个 —— 当本机
   * identity 读取器在某个平台上失效时，让人工值顶上做对照实验。
   */
  identityOverride?: QoderIdentityOverride
}

/** 一次轮次闭合需要的全部信息（由 `chatStream` 记下，`finishTurn` 取用）。 */
export interface QoderTurnContext {
  sessionId: string | undefined
  /** 轮次表的键（空串 = 无法归组，不闭合）。 */
  key: string
  businessId: string
  beginAt: number
  name: string
  modelKey: string
  product: QoderBusinessProduct
  version: string
}

/** 一轮结束时报告的终态原因，映射到客户端的 `kVe()`。 */
export type QoderTurnEndReason = 'end_turn' | 'abort' | 'error' | 'max_turns' | 'repeated_tool_call_denied'

/** cosy 会话 + 指纹的持有者（每次 jobToken 交换后重建）。 */export interface QoderSessionHolder {
  session: CosySessionContext
  fingerprint: CosyFingerprint
  /**
   * 本次会话实际采用的设备身份（含逐字段来源），见 `device-identity.ts`。
   *
   * 与 `fingerprint` 并存：`fingerprint` 仍然是「从凭据派生」的那一份（有调用方
   * 依赖它做稳定的旧身份），`identity` 是**真正发出去**的那一份。两者可能不同，
   * 差异由 `identity.source` 说明。
   */
  identity?: QoderDeviceIdentity
  jobToken: QoderJobToken
  /** 会话过期毫秒时间戳；0 表示未知。 */
  expireAtMs: number
  /**
   * 另一族令牌：`POST /api/v1/jobToken/exchange` 换来的 `token`，sash 面专用。
   *
   * 国际版需要**两族并存**，实测（本机两个真实 PAT，只读）：
   *
   * | 面 | 认哪一族 |
   * | --- | --- |
   * | chat / cosy（模型对话） | 旧的 `securityOauthToken`（本字段缺席） |
   * | sash / 额度（积分、签到） | 新的 `token`（本字段） |
   *
   * 换成新的会让国际版对话 403（code 105 登录态失效），继续用旧的会让国际版积分
   * 401（TOKEN_EXPIRE）—— 而令牌 `expireTime` 还有 24 小时，所以不是过期问题。
   * 国内版两族等价，这个差异**只在国际版显形**。
   *
   * 缺席 = 还没换过（或者换失败）。sash 那一支宁可回落到旧令牌（国内版足够）
   * 也不整体失败。
   *
   * 参考：Liki4/qodercli2api、shuishuipingan/qoder2api-hub、
   * eghrhegpe/dsh-connect-qoder 都走这个 exchange 端点。
   */
  sashToken?: string
  /** 上面那枚令牌的过期毫秒时间戳；0 表示未知。 */
  sashExpireAtMs?: number
}

/**
 * cosy 面（chat + models）的公共请求头。
 *
 * 协议版本见 {@link COSY_CLIENT_TYPE}：它决定上游下发哪套模型目录，改之前先读
 * 那段注释（issue #21 的实测表 + 2026-11-21 抓包对 clienttype 的纠正）。
 *
 * `user-agent` 与 `cosy-business-product` 都是**抓包实测**的值：官方 CN CLI
 * 1.1.94 发的是 `Bun/1.4.4`（它是 Bun 编译的单文件可执行程序）与 `cli`。
 * 这里此前是 `Go-http-client/2.0` 与 `ide` —— 两个都不对：前者是早期照着
 * 别人的 Go 实现抄的，后者是从网页版猜的（头名是真的，值不是）。
 *
 * ## `user-agent` 为什么是写死的常量，而不是像 `cosy-version` 那样动态解析
 *
 * 两者的性质不同，别把它们混成一条规则：
 *
 * | 头 | 含义 | 该不该动态 |
 * | --- | --- | --- |
 * | `cosy-version` | **Qoder CLI 自己的版本号** | 该 —— 它随 CLI 发布变化，且要在头、bearer 载荷、`business.version` 三处同值 |
 * | `user-agent` | **编译出那个 CLI 的 Bun 运行时的版本** | 不该 —— 它与 CLI 的版本号没有对应关系，`1.4.4` 是 Bun 的版本，不是 Qoder 的 |
 *
 * 具体说：如果把它改成「跟随 `clientVersion`」，就会发出 `Bun/1.1.94` —— 那是
 * 一个**从未存在过的 Bun 版本**。这恰恰是本仓库反复强调要避免的那类编造：
 * 一个不存在的版本号比一个「旧但真实」的版本号更显眼。
 *
 * 它也不是「我们自己的 UA」：我们跑在 Node 上，但这条链路在协议上**扮演 CLI**，
 * 所以它必须报 CLI 报的那个值。这与 `cosy-clienttype: 5` 是同一性质 ——
 * 协议常量，不是运行时事实。Bun 真升级到 1.5 时这个值会变旧，那是可接受的
 * 陈旧（旧值是合法历史）；编一个假值才是筛得出来的异常。
 */
const DEFAULT_HEADERS: Record<string, string> = {
  'cosy-data-policy': 'agree',
  'content-type': 'application/json',
  'cosy-clienttype': COSY_CLIENT_TYPE,
  'login-version': 'v2',
  'user-agent': 'Bun/1.4.4',
  'cosy-scene': 'assistant',
  'cosy-business-product': DEFAULT_BUSINESS_PRODUCT,
  'cosy-business-type': 'agent',
}

/**
 * Qoder 上游客户端。每个区域一个实例；会话按需惰性交换与续期。
 */
export class QoderUpstreamClient {
  readonly region: QoderRegionConfig
  /** 本实例所属区域（`region` 是它的配置表；这里保留区域名本身）。 */
  private readonly regionKey: QoderRegion
  private readonly logger: (message: string) => void
  private readonly installSalt: string | undefined
  private readonly fetchImpl: typeof fetch
  /**
   * 按凭证键控的会话缓存。
   *
   * 一个区域实例会同时服务多个账号（账号池批量探测、按账号查额度），
   * 不同 PAT 的 cosy 会话互不相通，所以会话必须按凭证分开缓存——用单个
   * 字段会互相覆盖（上一个账号的会话被下一个冲掉）。键是 PAT 本身：
   * 会话不可再交换，必须绑定到它交换来的那份凭证。
   */
  private readonly holders = new Map<string, QoderSessionHolder>()
  /** 最近使用的主会话（默认解析路径复用它）。 */
  private currentKey: string | undefined

  /**
   * 每条**用户轮次**的 `business` 生命周期：`id`、`begin_at`、`stage`、`endAt`。
   *
   * ## 粒度是「轮次」，不是「会话」，也不是「请求」（这条被实测纠正过两次）
   *
   * 官方客户端的 `AgentLifecycle`（`Mh` 类）在**每条用户提示**上 `create` 一次，
   * `business.id` / `begin_at` 在这一轮的全部工具循环里不变，轮次结束时 `finalize`
   * 写终态并 `POST /algo/api/v2/service/business/finish` 闭合。
   *
   * 实测抓包（qoderclicn 1.1.94，`business/finish` 次数恒为 1）：
   *
   * | 场景 | `agent_chat_generation` | `business/finish` |
   * | --- | --- | --- |
   * | 单轮、无工具 | 1 | 1 |
   * | 单轮、1 次工具调用 | **3** | **1** |
   * | 恢复会话后第二轮 | 1 | 1 |
   *
   * 即一次用户输入 → 一个 id → N 次补全（N 随工具调用增加）→ 结束时 1 次闭合。
   *
   * ## 走过的两条弯路（都别再走回去）
   *
   * 1. **每轮 `randomId()`**：最初这个字段和 `request_id` 一样每轮换新，注释还
   *    写着「它们是单次请求标识」。那让一场会话在服务端被记成 N 条互不相干、
   *    且从来没被结束过的记录 —— 控制台里一条消费行都不显示。
   * 2. **整场会话固定**：随后的修法把 `id` 钉在 `session_id` 上。这同样不对：
   *    会话里第 2、3 轮会复用第 1 轮的 id，服务端把整场会话记成**一条**永远
   *    不闭合的记录，同样出不了逐轮消费行。
   *
   * 正确的键是「会话 + 该轮的用户输入」：同一轮的多次补全命中同一条，跨轮必然
   * 不同；连用户连说两遍「继续」也是两条 —— 因为上一轮闭合时**这条记录已经从
   * 表里删掉了**，第二轮必然新建。
   *
   * 表只在轮内存在，所以通常只有「正在跑的那几轮」几条记录；LRU 截断
   * （{@link STAGE_MAP_LIMIT}）防的是「发出去了但轮末从未到来」的那些异常轮次
   * 无限堆积。
   */
  private readonly turns = new Map<string, {
    id: string
    beginAt: number
    stage: QoderBusinessStage
  }>()

  /**
   * 已经闭合过的 `business.id`。重复闭合同一轮是**绝不**该发生的事：客户端
   * 每轮只 `finalize()` 一次，多发一条 `BUSINESS_FINISH` 会让服务端对同一轮
   * 记两次收口。
   *
   * 容量上限与轮次表同值（{@link STAGE_MAP_LIMIT}）。它只是幂等闸，不是账本：
   * 被淘汰之后重复闭合才有可能漏过，而那时那条记录本来也已不在表里了。
   */
  private readonly endTurnClosed = new Set<string>()

  /**
   * 从上游报错里学到的 `max_tokens` 上限，按模型 key 缓存。
   *
   * 上游对越界值的回话是 `Range of max_tokens should be [1, N]`；学到 N 之后
   * 后续请求直接夹到 N 以内，不再撞同一堵墙（magpie 的 `LEARNED_CAPS` 同法）。
   */
  private readonly maxTokensCaps = new Map<string, number>()

  /** `business.product`（见 {@link DEFAULT_BUSINESS_PRODUCT}）。 */
  private readonly businessProduct: QoderBusinessProduct
  /** 显式配置的 `business.version`；缺席时跟随 {@link clientVersion}。 */
  private readonly businessVersionOverride: string | undefined
  /** 设备身份来源模式（见 {@link QoderUpstreamOptions.deviceIdentity}）。 */
  private readonly deviceIdentity: QoderDeviceIdentityMode
  /** 人工身份覆盖值（只在 `manual` 模式生效）。 */
  private readonly identityOverride: QoderIdentityOverride | undefined
  /** 客户端版本解析器：头、bearer 载荷、`business.version` 三处同源。 */
  private readonly clientVersionResolver: ClientVersionResolver
  /** prompt-cache 标记（默认 undefined = 不标记）。 */
  private readonly cacheControl: { type: 'ephemeral'; ttl?: '1h' } | undefined

  /**
   * 这次请求该声明的客户端版本。
   *
   * 三处必须同值：`cosy-version` 头、bearer 载荷的 `cosyVersion`、
   * `business.version`。取一次、用三处，避免它们各自漂移。
   */
  private get clientVersion(): string {
    return this.clientVersionResolver.current()
  }

  /** `business.version`：显式配置优先，否则与客户端版本同值。 */
  private get businessVersion(): string {
    return this.businessVersionOverride ?? this.clientVersion
  }

  /**
   * 某会话要发的设备身份头。
   *
   * 取值优先用会话里记下的那份 `identity`（`exchangeJobToken` 时解析出来的，
   * 含逐字段来源）；没有就退回会话自己的三个字段 + 本机环境 —— 这条兜底是给
   * 手工构造 holder 的测试用的。
   *
   * 环境头（`machineos` / `machinehostname`）**每次现取**，不缓存进 identity：
   * 它们是「这台机器现在是什么」，不是身份的一部分。
   */
  private machineHeaders(holder: QoderSessionHolder): Record<string, string> {
    const env = localMachineEnv()
    const identity = holder.identity
    if (identity !== undefined) return identityHeaders(identity, env)
    return {
      'cosy-machineid': holder.session.machineId,
      'cosy-machinetoken': holder.session.machineToken,
      'cosy-machinetype': holder.session.machineType,
      'cosy-machineos': env.os,
      'cosy-machinehostname': env.hostname,
    }
  }

  /**
   * 节点表缓存（按客户端 5 分钟 TTL）。
   *
   * 一个实例一份缓存：节点表是**按账号**下发的，跨账号复用会拿错表。
   */
  private readonly endpoints = new QoderEndpointCache()

  /**
   * 上次成功聊天的 inference 节点（用于「上次优先」，见 `orderWithLastFirst`）。
   *
   * 记住它不只是提速：节点之间不共享 KV cache，每轮跳节点等于每轮重算整段
   * 历史。只有它失败时才换下一个。
   */
  private lastInferenceNode: string | undefined

  /**
   * 当前轮次的 business 上下文，供 {@link finishTurn} 闭合时取用。
   *
   * 一次 `chatStream` 只覆盖一次补全，而一轮用户提示可能包含 N 次补全（工具
   * 循环），所以这里记的是**最近一次**补全所属的那一轮；`shim` 在这一轮的最后
   * 一次补全（`finish_reason === 'stop'`）之后才调 {@link finishTurn}。
   */
  private currentTurn: QoderTurnContext | undefined

  /**
   * 取（或新建）本轮用户输入的 `business` 记录，并按客户端 `changeBusinessState()`
   * 推进阶段。
   *
   * ## 键为什么是「会话 + 用户提示」
   *
   * 客户端里 `business.id` 就是**这条用户消息的 `requestSetId`**
   * （`Mh.create(sessionId, …, userMessage.requestSetId, …)` → `Fz` 的
   * `id: o || randomUUID()`）。所以粒度是**一条用户输入一条记录**，
   * 一条输出了 prompt 之后那一串工具循环里的 N 次补全共用同一个 id。
   *
   * 我们这边没有宿主的 `requestSetId`，可用且等价的锚点是「会话 + 最近一条用户
   * 提示」：一轮工具循环里最后一条 user 消息**不变**，下一轮用户输入一定会变。
   * 键里带上提示文本，就是为了让「同一个会话里问了两遍一样的话」也得到两条
   * 记录 —— 靠会话内序号做不到这一点（序号要等闭合才知道，而闭合只在轮末）。
   *
   * ## 阶段推进
   *
   * 规则照抄客户端 `Mh`：`init`/首次 → `start`，之后 → `processing`，再之后保持
   * `processing`（客户端的第三个分支只 warn、不再推进）。**终态不在这里推进** ——
   * 客户端由 `finalize()` 在轮次结束时一次写定，对应到我们这边是
   * {@link finishTurn}。
   *
   * 会话标识或缺席提示时无法归组 —— 每次都是一条新的 `start` 记录，至少不会
   * 声称一个错的阶段（宁可少聚合，不可错聚合）。
   */
  private sessionOf(
    sessionId: string | undefined,
    prompt: string,
  ): { key: string; id: string; beginAt: number; stage: QoderBusinessStage } {
    if (sessionId === undefined || sessionId === '') {
      return { key: '', id: randomId(), beginAt: Date.now(), stage: 'start' }
    }
    const key = `${sessionId}\u0000${prompt}`
    const existing = this.turns.get(key)
    if (existing === undefined) {
      // 新建时照客户端 `Fz` 写 `init`，但**首个请求发出的是 `start`** ——
      // `AgentLoop` 在发请求前先调一次 `changeBusinessState()`，那一下就把
      // `init` 推进成了 `start`。少走这一步会让每个轮次的开头多出一条
      // 永远不会被发出去的 `init` 状态。
      const fresh = { id: randomId(), beginAt: Date.now(), stage: 'start' as QoderBusinessStage }
      this.rememberTurn(key, fresh)
      return { key, ...fresh }
    }
    // `init` 与 `start` 都要走到 `processing`；已经是后续阶段就保持原样。
    const advanced: typeof existing = existing.stage === 'init' || existing.stage === 'start'
      ? { ...existing, stage: 'processing' }
      : existing
    this.rememberTurn(key, advanced)
    return { key, id: advanced.id, beginAt: advanced.beginAt, stage: advanced.stage }
  }

  /**
   * 结束当前轮次：写终态与 `end_at`，并**把这条记录从表里删掉**。
   *
   * 删除（而不是留在表里加个「已闭合」标记）是「一条用户输入 = 一条消费记录」
   * 能成立的关键：留着的话，下一轮若用户问了同样的话，会命中同一个键、并进
   * 上一条已闭合的记录里 —— 那正是「整场会话固定 id」那种错法的变体，只是
   * 晚一轮才发作。删掉之后下一次必然新建，`id` 与 `begin_at` 都是新的。
   *
   * 返回 `undefined` = 这一轮已经闭合过（或被 LRU 淘汰），调用方据此跳过上报。
   * 这个判据落在 `business.id` 上而不是轮次表上：`finishTurn` 也允许调用方直接
   * 递一个轮次上下文过来（测试与外部调用就是这条路），那时表里根本没有记录，
   * 拿「表里有没有」当闸会把合法的闭合挡掉。
   *
   * 终态取值照客户端 `kVe()`：`abort`/`repeated_tool_call_denied` → `abort`，
   * `error`/`max_turns` → `error`，其余（含 `end_turn`）→ `complete`。
   */
  private closeTurn(
    sessionId: string | undefined,
    key: string,
    businessId: string,
    fallbackBeginAt: number,
    stage: QoderBusinessStage,
  ): { id: string; beginAt: number; stage: QoderBusinessStage; endAt: number } | undefined {
    if (businessId === '') return undefined
    // 幂等闸：同一个 id 只闭合一次。`endTurnClosed` 是有界的（见其注释），
    // 重复闭合同一轮既不会重发也不会无限占内存。
    if (this.endTurnClosed.has(businessId)) return undefined
    this.endTurnClosed.add(businessId)
    while (this.endTurnClosed.size > STAGE_MAP_LIMIT) {
      const oldest = this.endTurnClosed.values().next()
      if (oldest.done === true) break
      this.endTurnClosed.delete(oldest.value)
    }
    // 表里有就取它的 `begin_at`（那才是这一轮真正开始的时间）；没有就用调用方
    // 递过来的那一份 —— 后者可能是从 chatStream 之外构造的上下文。
    const entry = sessionId === undefined || key === '' ? undefined : this.turns.get(key)
    if (sessionId !== undefined && key !== '') this.turns.delete(key)
    return {
      id: businessId,
      beginAt: entry?.beginAt ?? fallbackBeginAt,
      stage,
      endAt: Date.now(),
    }
  }

  /** 写轮次记录并按 LRU 截断（Map 的插入序即访问序，重插一次即可上浮）。 */
  private rememberTurn(
    key: string,
    entry: { id: string; beginAt: number; stage: QoderBusinessStage; endAt?: number },
  ): void {
    this.turns.delete(key)
    this.turns.set(key, entry)
    while (this.turns.size > STAGE_MAP_LIMIT) {
      const oldest = this.turns.keys().next()
      if (oldest.done === true) break
      this.turns.delete(oldest.value)
    }
  }

  /**
   * 决定本次请求的 `max_tokens`：调用方给的 → 学到的上限夹一下。
   *
   * 三层里的第三层（客户端的逐模型 override 表）在本机是空的，所以这里只有
   * 「调用方值（来自 `/model/list` 的 `max_output_tokens`）」与兜底常量两层。
   */
  private maxTokensFor(modelKey: string, requested: number | undefined): number {
    const base = requested !== undefined && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : DEFAULT_MAX_OUTPUT_TOKENS
    const learned = this.maxTokensCaps.get(modelKey)
    return learned === undefined ? base : Math.min(base, learned)
  }

  /**
   * 从上游报错文案里学 `max_tokens` 的实际上限。
   *
   * 只在确实认出了 `[1, N]` 形状时记 —— 认不出就不动，绝不猜一个更小的值
   * （猜小了会让回答被提前截断，而截断是静默的）。
   */
  private learnMaxTokens(modelKey: string, errorText: string): void {
    const match = MAX_TOKENS_RANGE_RE.exec(errorText)
    if (match?.[1] === undefined) return
    const cap = Number(match[1])
    if (!Number.isSafeInteger(cap) || cap <= 0) return
    if (this.maxTokensCaps.get(modelKey) === cap) return
    this.maxTokensCaps.set(modelKey, cap)
    this.log(`上游申报 max_tokens 上限 ${cap}（模型 ${modelKey}），后续请求夹到该值以内`)
  }

  constructor(region: QoderRegion, options: QoderUpstreamOptions = {}) {
    this.region = QODER_REGIONS[region]!
    this.regionKey = region
    this.logger = options.logger ?? (() => {})
    this.installSalt = options.installSalt
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.businessProduct = options.businessProduct ?? DEFAULT_BUSINESS_PRODUCT
    this.businessVersionOverride = options.businessVersion !== undefined && options.businessVersion !== ''
      ? options.businessVersion
      : undefined
    this.deviceIdentity = options.deviceIdentity ?? 'real'
    this.identityOverride = options.identityOverride
    this.clientVersionResolver = new ClientVersionResolver(
      options.clientVersion !== undefined && options.clientVersion !== ''
        ? { override: options.clientVersion, ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }) }
        : (options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
    )
    this.cacheControl = options.cacheControl
  }

  private log(message: string): void {
    this.logger(`dsh-connect-qoder: ${message}`)
  }

  /** 某一凭证的会话是否已过期（或即将过期）。 */
  isSessionValid(credential: string, nowMs = Date.now()): boolean {
    const holder = this.holders.get(credential)
    if (holder === undefined) return false
    const remaining = holder.expireAtMs - nowMs
    // 提前 5 分钟视为过期，给续期留时间。
    return remaining > 5 * 60_000
  }

  /** 最近使用的凭证，沿用直觉意义上「当前账号」的引用。 */
  currentCredential(): string | undefined {
    return this.holders.has(this.currentKey ?? '') ? this.currentKey : undefined
  }

  /**
   * 用 PAT（`pt-...` 或任意凭证）或 refresh token（`drt-...`）交换 jobToken。
   *
   * 设备身份不再是「整份从凭据派生」：见 {@link resolveDeviceIdentity}。默认
   * 模式下 `machineId` 读本机 `machine_id` 文件、`machineToken/Type/Code` 读
   * UMID 组件，任何一路取不到才退回派生值并记录原因。
   */
  async exchangeJobToken(credential: string): Promise<QoderJobToken> {
    const fingerprint = deriveFingerprint('', credential, this.installSalt)
    const device = await resolveDeviceIdentity({
      region: this.regionKey,
      credential,
      mode: this.deviceIdentity,
      ...(this.identityOverride === undefined ? {} : { override: this.identityOverride }),
      ...(this.installSalt === undefined ? {} : { installSalt: this.installSalt }),
      log: message => this.log(message),
    })
    const body = jobTokenBody(credential)
    const date = currentRfc1123Date()
    const sig = signLegacy(date)

    const headers: Record<string, string> = {
      ...identityHeaders(device),
      'login-version': 'v2',
      appcode: 'cosy',
      accept: 'application/json',
      'accept-encoding': 'identity',
      'cosy-version': this.clientVersion,
      'cosy-clienttype': COSY_CLIENT_TYPE,
      date,
      signature: sig,
      'content-type': 'application/json',
      'user-agent': DEFAULT_HEADERS['user-agent'] ?? 'Bun/1.4.4',
    }

    const url = `${this.region.gateway}${this.region.jobTokenPath}`
    const resp = await this.fetchImpl(url, { method: 'POST', headers, body })
    const text = await resp.text()
    if (resp.status !== 200) {
      throw new QoderUpstreamError(classifyFailure(resp.status, text), `jobToken 交换失败: HTTP ${resp.status} ${truncate(text, 200)}`, resp.status, deepestBusinessCode(text))
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new QoderUpstreamError('unknown', `jobToken 响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
    const jobToken: QoderJobToken = {
      id: String(data.id ?? ''),
      name: String(data.name ?? ''),
      expireTime: Number(data.expireTime ?? 0),
      securityOauthToken: String(data.securityOauthToken ?? ''),
      refreshToken: String(data.refreshToken ?? ''),
      userType: String(data.userType ?? 'personal_standard'),
    }
    if (!jobToken.id && !jobToken.securityOauthToken) {
      throw new QoderUpstreamError('auth', `jobToken 交换响应缺少身份字段: ${truncate(text, 200)}`, resp.status)
    }
    const identity = { name: jobToken.name, aid: jobToken.id, uid: jobToken.id, yx_uid: '', organization_id: '', organization_name: '', user_type: jobToken.userType, security_oauth_token: jobToken.securityOauthToken, refresh_token: jobToken.refreshToken }
    const session = newCosySession(identity, device.machineId, device.machineToken, device.machineType)
    const holder: QoderSessionHolder = {
      session,
      fingerprint,
      identity: device,
      jobToken,
      expireAtMs: jobToken.expireTime > 0 ? jobToken.expireTime : 0,
    }
    // sash 那一族令牌顺手换一枚。**必须在这里 await**：它是 sash 面的唯一凭据，
    // 不等它落地就返回，会让紧接着的第一次积分 / 签到读到空令牌而 401 —— 而那个
    // 401 与「真被拒」长得一模一样（实测正是如此：第一次 401、第二次 200），
    // 排查起来极贵。第二次交换多花一次上游往返，换「第一次读积分就是对的」。
    await this.refreshSashToken(credential, holder)
    this.holders.set(credential, holder)
    this.currentKey = credential
    this.log(`jobToken 已交换: ${jobToken.name} (${jobToken.id})`)
    return jobToken
  }

  /**
   * 换一枚 sash 面专用的令牌（`POST /api/v1/jobToken/exchange`）。
   *
   * **不抛**：这一族换不到时 sash 那一支会回落到旧令牌（国内版本来就够用），
   * 而整条交换失败只该让「积分读不到」，不该让 chat / 对话跟着挂 —— 那是完全
   * 不同的两条链路。
   *
   * body 键是 `personal_token`：实测 `personal_access_token`（eghrhegpe 那个 fork
   * 用的拼写）在当前上游回 **400 BadRequest**，两个区域都是。
   */
  private async refreshSashToken(credential: string, holder: QoderSessionHolder): Promise<void> {
    const url = `${this.region.openapi}${SASH_TOKEN_PATH}`
    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ personal_token: credential }),
      })
      const text = await resp.text()
      if (resp.status !== 200) {
        this.log(`sash 令牌交换失败（HTTP ${resp.status}），sash 面将回落到旧令牌: ${truncate(text, 120)}`)
        return
      }
      const data = parseJson(text)
      // 上游在这一点上有过多种拼写（token / job_token / jobToken），全试。
      const raw = data === undefined ? {} : data as Record<string, unknown>
      const token = typeof raw['token'] === 'string' && raw['token'] !== ''
        ? raw['token']
        : typeof raw['job_token'] === 'string' && raw['job_token'] !== ''
          ? raw['job_token']
          : typeof raw['jobToken'] === 'string' && raw['jobToken'] !== '' ? raw['jobToken'] : ''
      if (token === '') {
        this.log(`sash 令牌交换响应里没有 token 字段: ${truncate(text, 120)}`)
        return
      }
      holder.sashToken = token
      // expires_at 是 ISO 字符串（实测 "2026-10-13T17:36:02Z"），不是 epoch 毫秒。
      const expiry = typeof raw['expires_at'] === 'string' ? Date.parse(raw['expires_at']) : Number.NaN
      holder.sashExpireAtMs = Number.isFinite(expiry) ? expiry : 0
      this.log(`sash 令牌已交换（有效期至 ${holder.sashExpireAtMs > 0 ? new Date(holder.sashExpireAtMs).toISOString() : '未知'}）`)
    } catch (error: unknown) {
      this.log(`sash 令牌交换异常，sash 面将回落到旧令牌: ${String((error as Error)?.message ?? error).slice(0, 120)}`)
    }
  }

  /**
   * 取该会话用于 **sash 面** 的 Authorization 值。
   *
   * 新令牌优先（国际版必需）；没有就回落到旧的 `securityOauthToken`（国内版
   * 两个面都认它，而且它是 chat 在用的那一个 —— 回落不会破坏任何东西）。
   *
   * 返回 `''` 表示两族都没有：那一支必须报「读不到」，绝不能带上一个空 bearer
   * 去换一个 401 回来（那样分不清是没令牌还是令牌被拒）。
   */
  private sashBearerOf(holder: QoderSessionHolder): string {
    if (typeof holder.sashToken === 'string' && holder.sashToken !== '') return holder.sashToken
    return holder.jobToken.securityOauthToken
  }

  /**
   * 确保存在未过期会话。credential 提供 PAT 或 refreshToken（`drt-` 前缀）。
   * 已有有效会话时直接复用（不重复交换）。
   */
  async ensureSession(credential: string): Promise<QoderSessionHolder> {
    if (this.isSessionValid(credential)) {
      return this.holders.get(credential)!
    }
    await this.exchangeJobToken(credential)
    return this.holders.get(credential)!
  }

  /**
   * 取一份可用的节点表，失败时静默返回 undefined。
   *
   * **绝不因为发现失败就挡住聊天**：客户端对选举只给 1 秒（`NCn=2e3` / `1e3`），
   * 超时就退回环境默认端点继续跑。这里同法 —— 发现是优化，不是前置条件。
   *
   * 请求本身走 center 主机（即本区域的 `openapi` 主机：客户端的 `ste()` 返回
   * `Rp("center")`，`Gde` 里 center 与 openapi 指向同一台 `$9`）；鉴权与
   * `fetchModels` 一样用 bearer。失败原因只记 debug 级别 —— 它是常态，不是故障。
   */
  private async discoverNodes(holder: QoderSessionHolder, signal?: AbortSignal): Promise<void> {
    // 失败冷却也要跳过（issue #3）：`isFresh()` 只在成功时为真，于是
    // `/region/endpoints` 对某个账号 404 时，每个聊天请求都会再打一次发现。
    if (this.endpoints.isFresh() || this.endpoints.isCoolingDown()) return
    const url = `${this.region.openapi}${REGION_ENDPOINTS_PATH}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('endpoint election timed out')), ENDPOINTS_TIMEOUT_MS)
    // 调用方的取消也要生效：否则一场被取消的对话还要多挂 1 秒的发现请求。
    const onAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const data = await this.bearerGet(holder, url, controller.signal)
      const parsed = parseRegionEndpoints(data)
      if (parsed === undefined) {
        this.log(`节点表为空或形状不识别（${REGION_ENDPOINTS_PATH}），继续用默认网关`)
        return
      }
      this.endpoints.write(parsed)
    } catch (error) {
      // 发现是优化项：任何失败都退回默认网关，不向调用方冒泡。
      // 同时记一次失败，让接下来一分钟内别再重试（issue #3）。
      this.endpoints.recordFailure()
      this.log(`节点发现失败，继续用默认网关：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 本次聊天该用的 base URL（**不带尾斜杠**）。
   *
   * 顺序：上次成功的 inference 节点 → 节点表里的第一个 → 区域默认网关。前两个都
   * 来自节点发现，最后一个保证**永远有一个能用的**。
   *
   * 统一去掉尾斜杠：节点表里的 URL 被规范成带尾斜杠（`normalizeNodeUrl`），而
   * `region.gateway` 不带。不归一的话拼 `chatPath`（以 `/` 开头）就会出现
   * `//api/...` 双斜杠 —— 它能不能被容忍取决于网关，不该赌。
   */
  private chatBaseUrl(): string {
    const nodes = this.endpoints.read()?.inference ?? []
    const ordered = orderWithLastFirst(nodes, this.lastInferenceNode)
    return (ordered[0] ?? this.region.gateway).replace(/\/+$/, '')
  }

  /**
   * 拉取模型目录。响应形状（服务端 snake_case）：
   * `{"chat":[{key, display_name, enable, is_vl, is_default, ...}], ...}`
   */
  async fetchModels(
    credential: string,
    signal?: AbortSignal,
    options: {
      /**
       * 这一条目录请求用哪个 `cosy-clienttype`（默认 {@link COSY_CLIENT_TYPE}）。
       *
       * issue #3：上游按通道决定"给不给活动模型"。实测同一套头、只把该值从 `5`
       * 改成 `10`，`assistant` 与 `app` 各多一条 `hmodel`，其余十个桶分毫不变。
       * **只给目录请求换** —— 聊天请求实测在 ct=10 下会走另一套推理与截断路径
       * （同一请求 4 token / 0 reasoning → 71 / 67），那不是我们要的对话行为。
       */
      clientType?: string
    } = {},
  ): Promise<QoderUpstreamModel[]> {
    const holder = await this.ensureSession(credential)
    // 目录同样可能按节点分区下发；先尝试发现，失败就用默认网关（见 discoverNodes）。
    await this.discoverNodes(holder, signal)
    const modelsBase = this.endpoints.read()?.openapi[0] ?? `${this.region.gateway}/`
    const url = `${modelsBase.replace(/\/$/, '')}${this.region.modelsPath}`
    const data = await this.bearerGet(
      holder,
      url,
      signal,
      options.clientType === undefined ? {} : { 'cosy-clienttype': options.clientType },
    )
    // 见 {@link CATALOG_BUCKETS}：目录是分桶对象，只读 `chat` 会静默丢掉活动
    // 模型。同 key 以**先出现者**为准（`chat` 在第一个），因为实测同一个 key 在
    // 不同桶里内容不同 —— 让后出现的桶覆盖会让价格与上下文档位随桶序漂移。
    const collected: Array<{ entry: unknown, channelOnly: boolean }> = []
    const seen = new Set<string>()
    for (const [index, bucket] of CATALOG_BUCKETS.entries()) {
      const list = Array.isArray(data[bucket]) ? data[bucket] as unknown[] : []
      for (const entry of list) {
        const key = (entry as { key?: unknown } | null)?.key
        if (typeof key !== 'string' || key === '' || seen.has(key)) continue
        seen.add(key)
        collected.push({ entry, channelOnly: index > 0 })
      }
    }
    return collected
      .map(({ entry, channelOnly }): QoderUpstreamModel | undefined => {
        if (!entry || typeof entry !== 'object') return undefined
        const raw = entry as Record<string, unknown>
        const key = typeof raw.key === 'string' ? raw.key : ''
        const displayName = typeof raw.display_name === 'string' ? raw.display_name : ''
        if (!key || !displayName) return undefined
        return {
          key,
          display_name: displayName,
          enable: raw.enable !== false,
          is_default: raw.is_default === true,
          is_vl: raw.is_vl === true,
          is_reasoning: raw.is_reasoning === true,
          is_free: raw.is_free === true,
          price_factor: typeof raw.price_factor === 'number' ? raw.price_factor : undefined,
          max_input_tokens: typeof raw.max_input_tokens === 'number' ? raw.max_input_tokens : undefined,
          max_output_tokens: typeof raw.max_output_tokens === 'number' ? raw.max_output_tokens : undefined,
          thinking_config: typeof raw.thinking_config === 'object' ? raw.thinking_config as Record<string, unknown> : undefined,
          context_config: typeof raw.context_config === 'object'
            ? raw.context_config as Record<string, { token_count: number; is_default?: boolean }>
            : undefined,
          ...channelOnly ? { channelOnly: true } : {},
          raw,
        }
      })
      .filter((m): m is QoderUpstreamModel => m !== undefined)
      // **上游的 `auto` 路由器不是模型，不进名册。**
      //
      // 它是该区的默认路由：网关在请求时才决定把它解析成哪一个模型，所以价格、
      // 上下文与行为都由别人临时决定，插件无法如实描述。真实目录里它正是唯一
      // 没声明思考档位、却带着 `is_default: true` 的那一行。
      //
      // 过滤放在这里（解析层，唯一的写点）而不是各个读点：`discoverModels`、
      // `refreshRegionCatalog`、CLI 的 `status` 全都经过这一个函数，漏一处就会
      // 出现「刷新后没了、重启后又回来」这种最难查的不一致。旧存档里的那一行
      // 另由 `catalog.ts` 的 `withoutRouters` 在读点兜住。
      .filter(model => !isRouterModelId(model.key))
  }

  /**
   * 聊天 SSE 流。onDelta 逐行回调；返回 null 表示正常结束。
   * 令牌：`credential` 只在会话续期时使用。
   */
  async chatStream(
    credential: string,
    modelKey: string,
    messages: Array<Record<string, unknown>>,
    options: {
      tools?: unknown[]
      isReasoning?: boolean
      /**
       * 思考强度档位名（`low` / `medium` / `xhigh` …），来自插件设置里为该
       * 模型保存的值。
       *
       * 实测自 Qoder 官方客户端（app.asar.unpacked 的 SDK）：档位**不走**
       * `model_config`，而是请求体顶层的 `reasoningEffort` 加
       * `parameters.reasoning_effort`——官方客户端两者同时写
       * （`{..., reasoningEffort:"none", parameters:{...A.parameters,
       *   reasoning_effort:"none"}}`），只写一个有可能被网关忽略。
       * 缺席时不下发任何档位字段，由上游用模型自己的默认档。
       */
      reasoningEffort?: string
      isVl?: boolean
      /**
       * 该模型的输出上限（token），来自上游 `/model/list` 的 `max_output_tokens`。
       *
       * **必须下发。** 官方客户端的每个请求都带 `parameters.max_tokens`
       * （`lYa(A)` 里无条件写），而此前这里从不发 —— 等于让上游自己随便挑一个
       * 默认值，用户设置的输出预算完全不生效。
       *
       * 缺席时退回 {@link DEFAULT_MAX_OUTPUT_TOKENS}（与客户端 `defaultTokens`
       * 同值），不是「不发这个字段」。
       */
      maxOutputTokens?: number
      signal?: AbortSignal
      onDelta: (delta: QoderChatDelta) => void
      userType?: string
      /**
       * 会话标识（issue #42）—— Qoder 网关的 prompt cache 按请求体 `session_id`
       * 分桶，所以每会话必须稳定。DSH 每轮把 `session.id` 盖在 LLM 请求上，
       * shim 从 `session_id` 头读出后传到这里。缺席（老宿主 / 直连调用）时退回
       * 随机值，保持旧调用方行为不变。
       */
      sessionId?: string
    },
  ): Promise<void> {
    const holder = await this.ensureSession(credential)
    const template = deepClone(createChatBodyTemplate())
    applyModelKey(template, modelKey, options.userType ?? holder.jobToken.userType, options.isVl ?? false)
    // 会话类型按区域取：国内版是 `qoderclicn`，国际版是 `qodercli`。
    template.session_type = sessionTypeOf(this.regionKey)
    if (options.isReasoning) {
      template.model_config.is_reasoning = true
      template.chat_context.extra.modelConfig.is_reasoning = true
    }
    // 参数袋一次成型：reasoning_effort 与 max_tokens 都写在这里。
    //
    // 两者以前是分开写的（reasoning_effort 独自 `{...params, ...}`），所以先算
    // 出完整的一份再赋值，避免后写的覆盖先写的。
    const maxTokens = this.maxTokensFor(modelKey, options.maxOutputTokens)
    const params = (template.parameters ?? {}) as Record<string, unknown>
    template.parameters = { ...params, max_tokens: maxTokens }
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== '') {
      // 两个位置都写：官方客户端如此，照抄以避免网关只认其中一个。
      template.reasoningEffort = options.reasoningEffort
      template.parameters = { ...(template.parameters as Record<string, unknown>), reasoning_effort: options.reasoningEffort }
    }
    const prompt = extractLatestUserPrompt(messages)
    const built = buildQoderMessages(messages, prompt, Array.isArray(options.tools) && options.tools.length > 0)
    template.messages = applyCacheControl(built, this.cacheControl) as unknown as unknown[]
    if (options.tools !== undefined) {
      template.tools = options.tools
    }
    template.request_id = randomId()
    template.chat_record_id = template.request_id
    template.request_set_id = randomId()
    // issue #42：`session_id` 是「会话」标识，不是单次请求标识 —— 它在同一场
    // 会话内必须稳定，否则 Qoder 的 prompt cache 每轮换桶、100% 失效，长对话
    // 每轮都为整段历史重复付全价。request_id / request_set_id 每轮换新仍然
    // 正确（它们是单次请求标识）。
    //
    // ⚠️ `business.id` 是**轮次**记录而不是单次请求标识，也不该钉在整场会话上。
    // 它此前每轮换新（一场会话被记成 N 条互不相干的记录），中间一版改成按
    // `session_id` 固定（整场会话被记成 1 条永不闭合的记录）—— 两种都出不了
    // 逐轮消费行。正确粒度见 `sessionOf` 上方那张实测表。
    template.session_id = options.sessionId !== undefined && options.sessionId !== ''
      ? options.sessionId
      : randomId()
    const turn = this.sessionOf(template.session_id, prompt)
    applyBusinessIdentity(template, {
      product: this.businessProduct,
      version: this.businessVersion,
      stage: turn.stage,
      modelKey,
    })
    template.business.id = turn.id
    template.business.begin_at = turn.beginAt
    template.business.name = prompt.slice(0, 30) || 'hi'
    this.currentTurn = {
      sessionId: options.sessionId,
      key: turn.key,
      businessId: turn.id,
      beginAt: turn.beginAt,
      name: template.business.name,
      modelKey,
      product: this.businessProduct,
      version: this.businessVersion,
    }

    const body = JSON.stringify(template)
    // 先发现节点（失败静默退回默认网关），再决定这次打哪个 inference 节点。
    await this.discoverNodes(holder, options.signal)
    const chatBase = this.chatBaseUrl()

    /**
     * 按某个 base 发出一次聊天请求。
     *
     * `pathSig` 与 `cosy-date` 都**依赖最终 URL**（签名覆盖路径），所以每换一个
     * base 就必须重新签一次 —— 不能复用上一份 header 换个 host 发出去，那样网关
     * 会判签名不匹配。这也正是把它写成闭包而不是循环的原因。
     */
    const send = async (base: string): Promise<Response> => {
      const url = `${base}${this.region.chatPath}`
      const pathSig = pathSigFrom(url)
      const encoded = cosyEncode(new TextEncoder().encode(body))
      const date = String(Math.floor(Date.now() / 1000))
      const payloadB64 = buildPayloadB64(holder.session.info, this.clientVersion)
      const sig = signRequest(payloadB64, holder.session.cosyKey, date, encoded, pathSig)
      const bearer = composeBearer(payloadB64, sig)

      const headers: Record<string, string> = {
        ...DEFAULT_HEADERS,
        'cosy-machinetype': holder.session.machineType,
        'cosy-date': date,
        'cosy-user': holder.session.identity.uid,
        'cosy-key': holder.session.cosyKey,
        'cache-control': 'no-cache',
        accept: 'text/event-stream',
        authorization: bearer,
        'cosy-version': this.clientVersion,
        'x-model-key': modelKey,
        'x-model-source': 'system',
        // 四件套 + `machineos` + `machinehostname`：官方 CLI 每次聊天都带这六个，
        // 此前只发了前三个（且取值不对）。见 `identityHeaders` 的注释。
        ...this.machineHeaders(holder),
      }

      return this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: encoded,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    }

    // 选举来的节点**没有**「用户网络一定能通」这个保证（默认网关有：用户就是
    // 靠它配上 PAT 的）。国内访问国际版、或企业网络只放行网关域名时，连接会
    // 直接抛在网络层。纯优化功能不能把「一直能用」变成「全挂」，所以这里对
    // **网络层异常**兜回默认网关重发一次。
    //
    // 只兜「抛异常」这一种：HTTP 4xx/5xx 是节点自己给的答复，说明连通性没问题，
    // 那属于业务失败（配额、凭据、限流），换节点重发只会把同一个错误再问一遍，
    // 还可能把一次配额错误放大成两次计费。
    let resp: Response
    /** 实际发出这次请求的 base（用于记录「这个节点可用」）。 */
    let usedBase = chatBase
    try {
      resp = await send(chatBase)
    } catch (error) {
      const fallback = this.region.gateway
      if (chatBase === fallback || isAbortError(error)) throw error
      this.log(`节点 ${chatBase} 不可达（${error instanceof Error ? error.message : String(error)}），改用默认网关`)
      // 记下坏节点，下一轮别又选它 —— 否则每轮都要白等一次超时。
      this.lastInferenceNode = undefined
      this.endpoints.clear()
      resp = await send(fallback)
      usedBase = fallback
    }
    if (resp.status !== 200) {
      const errText = await resp.text()
      // 400 可能是 `max_tokens` 越界（`Range of max_tokens should be [1, N]`）。
      // 认出形状就把 N 记住，后续请求夹到它以内 —— 重试之前先学会，一次撞墙
      // 换后面的顺。这不是猜：N 是上游自己在报错里写的。
      this.learnMaxTokens(modelKey, errText)
      // 用 classifyFailure 而不是 classifyHttpStatus：chat 面的「当日用量用尽」
      // 就是从这里进来的（实测 HTTP 403 + body `{"code":"110",…}`），只看状态会
      // 把它判成凭据被拒，进而把好的账号永久踢出池。
      throw new QoderUpstreamError(
        classifyFailure(resp.status, errText),
        `聊天请求失败: HTTP ${resp.status} ${truncate(errText, 300)}`,
        resp.status,
        deepestBusinessCode(errText),
        // 上游申报的重试间隔（issue #24）：`10605 / RESOURCE_LIMIT` 就走这条
        // 路径进来，以前读到即丢，用户只看到「上游报了个 4xx」。
        retryAfterMsOf(errText) ?? retryAfterMsOfHeader(resp.headers.get('retry-after')),
        // issue #26：排队证据（`isQueued`）与重试间隔在同一个信封里，一并带出。
        queueOf(errText),
      )
    }
    if (!resp.body) {
      throw new QoderUpstreamError('transient', '聊天响应没有 body')
    }
    // 首包已经回来，说明这个节点可用 —— 记下它，下一轮继续用它。
    //
    // 这一步放在 `!resp.body` 之后而不是 fetch 之后：一个 200 但空 body 的响应
    // 不能算「这个节点好」，否则会把后续轮次钉在一个坏节点上。走回退分支时这里
    // 记的是默认网关（`usedBase`），不是那个不可达的节点。
    if (this.endpoints.read() !== undefined) {
      this.lastInferenceNode = usedBase
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === '' || !trimmed.startsWith('data:')) continue
          const payload = trimmed.slice('data:'.length).trim()
          if (payload === '[DONE]') continue
          const delta = parseStreamDelta(payload)
          if (delta !== undefined) options.onDelta(delta)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * 查询用量（只读）。`GET {openapi}/sash/api/v2/me/usage`。
   *
   * **认证用的是 jobToken 里的 `securityOauthToken`（`jt-…`），不是 PAT，
   * 也不是 COSY 签名 bearer。** 三者实测（2026-10，CN）：
   *
   * | 凭据 | 结果 |
   * | --- | --- |
   * | 裸 PAT `pt-…` | 401 `TOKEN_EXPIRE / token is not active` |
   * | COSY 签名 bearer（chat/models 用的那套） | 401 `TOKEN_INVALID / invalid token` |
   * | `jt-…`（jobToken 交换产出） | **200，返回完整 qoderUsage** |
   *
   * 前两种之所以失败，是因为 `sash` 是**浏览器会话面**的接口：它既不收 PAT，
   * 也不认 cosy 协议头（缺 Authorization 时它回
   * `UNAUTHORIZED / missing cookie header`，可见它本来是给 cookie 会话用的）。
   * 这解释了「令牌明明是好的、聊天也正常，积分却永远拿不到」——以前用错凭据。
   */
  async fetchUsage(credential: string, signal?: AbortSignal): Promise<QoderUsage | undefined> {
    const url = `${this.region.openapi}/sash/api/v2/me/usage`
    try {
      const holder = await this.ensureSession(credential)
      const data = await this.jobTokenGet(holder, url, signal)
      return parseUsage(data)
    } catch (error) {
      // 凭据被上游拒（401/403，实测 Qoder 回 `TOKEN_EXPIRE / token is not
      // active`）必须**抛出去**，不能和「网络抖了一下」一起降级成 undefined：
      //  - 卡片需要它来说「积分为什么是空的」，否则用户只看到一片空白；
      //  - credential-recovery 的 `try { await fetchUsage } catch { usable =
      //    false }` 靠这个异常判定凭据是否可用——原实现静默返回 undefined，
      //    await 正常结束，于是**过期凭据被判为可用**。
      // 其他错误（超时、5xx、网关抖动）仍旧返回 undefined：那是「这次没读到」，
      // 不是「凭据坏了」，报成凭据被拒会把用户引去换一个没问题的 PAT。
      if (error instanceof QoderUpstreamError && (error.status === 401 || error.status === 403)) {
        // 兜底：万一某个区域只认 PAT 直连，再试一次。两条都失败才报凭据被拒。
        const direct = await this.fetchUsageDirect(url, credential, signal)
        if (direct !== undefined) return direct
        throw error
      }
      return undefined
    }
  }

  /**
   * `sash` 系列接口的取数：带 `Authorization: Bearer <jobToken.securityOauthToken>`。
   *
   * 与 {@link bearerGet} 的区别只有一个——**认证凭据不同**：`sash` 要的是
   * jobToken 交换产出的 `jt-…`，不是 COSY 签名 bearer（实测后者回
   * `TOKEN_INVALID / invalid token`），也不是裸 PAT（回 `TOKEN_EXPIRE`）。
   * 也正因为如此，这里**不**带那套 cosy-* 协议头：它们属于 cosy 协议面。
   * 但**设备风控三件套属于 sash 面**，按 `requiresDeviceRisk` 附加 —— 见下。
   */
  private async jobTokenGet(
    holder: QoderSessionHolder,
    url: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    // sash 面用**专用那族**令牌（国际版必需，见 QoderSessionHolder.sashToken）。
    const oauthToken = this.sashBearerOf(holder)
    if (oauthToken === '') {
      throw new QoderUpstreamError('auth', '两次令牌交换都没有拿到可用令牌，无法查询用量', 401)
    }
    // 设备风控头按区域附加：`requiresDeviceRisk` 的语义是「该区域的 sash 请求
    // 都要带这三件套」，用量查询同属 sash 面，**不能只给签到带**。此前这里只发
    // accept + authorization，国际版的积分查询因此少了 machine 三件套。
    const resp = await this.fetchImpl(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${oauthToken}`,
        ...(await this.deviceRiskHeaders()),
      },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await resp.text()
    if (resp.status !== 200) {
      throw new QoderUpstreamError(classifyFailure(resp.status, text), `请求失败: HTTP ${resp.status} ${truncate(text, 200)}`, resp.status, deepestBusinessCode(text))
    }
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new QoderUpstreamError('unknown', `响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
  }

  /**
   * 闭合**最近一次** `chatStream` 所属的轮次。供 `shim` 在轮次真正结束时调用。
   *
   * 与 {@link finishTurn} 的分工：那个是「给我一个轮次上下文，我来闭合」，这个
   * 是「把刚才那次请求所属的轮次闭合掉」，省得把 `QoderTurnContext` 泄漏到
   * 调用方去。
   *
   * 并发的两个会话会互相覆盖 `currentTurn` —— 但 `closeTurn` 按轮次键去重，且
   * 每个键只闭合一次，所以最坏情况是**漏闭合**（该轮靠 TTL 收口），不会把
   * A 会话的 id 配到 B 会话的终态上：`turn.sessionId` 与 `turn.key` 是同一次
   * 请求里一起记下的，不存在错配的可能。
   */
  async finishCurrentTurn(credential: string, reason: QoderTurnEndReason = 'end_turn'): Promise<void> {
    const turn = this.currentTurn
    if (turn === undefined) return
    await this.finishTurn(credential, turn, reason)
  }

  /**
   * 闭合当前轮次：把终态与 `end_at` 写进请求体，`POST business/finish`。
   *
   * ## 为什么必须有这一步
   *
   * 官方客户端在一轮用户提示结束时**必发一次**闭合（实测：一轮 2 次补全仍是
   * 1 次闭合）。不发它，服务端只能等 TTL 释放租约 —— 那一轮在记账上永远是
   * 「进行中」，控制台也就不产生逐条消费行。这是本插件长期缺失的一环。
   *
   * ## 三道闸（照抄客户端 `Qd.finish()`）
   *
   * 1. 没有 `business.id` → 不发（客户端 `if (!businessInfo.id) return`）；
   * 2. 子 agent 的轮次 → 不发（客户端 `if (this._isSubagent) return`；我们这里
   *    没有子 agent 概念，由调用方保证只对主轮次调用）；
   * 3. 同一轮已被闭合过 → 不发（客户端每轮 `finalize` 一次）。
   *
   * ## 为什么少了 `sub_task` / `orphan` / `feature_switches`
   *
   * 客户端 `Qd.finish()` 的模板里有这三个键，但**实测抓包里它们不出现**。
   * 不是我们漏了 —— 它们在客户端那边本来就是 `undefined`：
   *
   * - `sub_task`：只有子 agent / `title_generation` 这类任务才由 `$o()` 填值，
   *   主对话永远是 `undefined`；
   * - `orphan`：只在 `createForSubagent` 找不到父 business 时置 `true`，
   *   主轮次不带；
   * - `feature_switches`：来自 `envInfo` 的账号级开关，我们这条 PAT 链路拿不到，
   *   也不该编。
   *
   * `JSON.stringify` 会把 `undefined` 值整个省掉，所以官方 CLI 的明文里根本没
   * 这三项。解密 `captures/20261121-050020` 的 `0039-req.bin` 可以逐字核对：
   * 它的 `business` 只有九个键（product / version / type / id / model_key /
   * begin_at / end_at / stage / name），与本函数发出的完全一致。
   *
   * 所以这里**刻意不写**这三个键：手写一个 `feature_switches: {}` 或
   * `orphan: false` 反而会造出一项官方客户端不发的内容，那才是偏差。
   *
   * ## **不抛**
   *
   * 闭合失败只影响「记账何时收口」，不该让已经把答案交给用户的请求变成失败。
   * 失败按 warn 记一条日志 —— 它必须是**可见的**，否则「消费行还是不出现」
   * 会退化成又一个查不出来的问题。
   */
  async finishTurn(
    credential: string,
    turn: QoderTurnContext,
    reason: QoderTurnEndReason = 'end_turn',
  ): Promise<void> {
    // 闸 1：没有 id 或无法归组，不发。
    if (turn.businessId === '' || turn.key === '') return
    const stage = endStageOf(reason)
    const closed = this.closeTurn(turn.sessionId, turn.key, turn.businessId, turn.beginAt, stage)
    // 闸 3：这一轮已经被闭合过（或已被 LRU 淘汰）。
    if (closed === undefined) return

    let holder: QoderSessionHolder
    try {
      holder = await this.ensureSession(credential)
    } catch (error: unknown) {
      this.log(`轮次闭合跳过（会话不可用）：${String((error as Error)?.message ?? error)}`)
      return
    }

    const body = JSON.stringify({
      // **双层信封**：明文是 `{payload, encodeVersion}`，`payload` 才是那个 JSON
      // **字符串**（不是对象）。这一层单靠读客户端源码很容易看漏 ——
      // `Qd.finish()` 里先 `.json({payload: JSON.stringify(w), encodeVersion:"1"})`，
      // 再交给 `withWasmSigning()`，中间的变换不在同一处。
      //
      // 实测证据：解出的官方 CLI 闭合明文（captures/20261121-050020 的
      // `0039-req.bin`，解密后 522 B）逐字就是
      // `{"payload":"{\"event_time\":…}","encodeVersion":"1"}`。
      //
      // 发错这一层的后果不是「字段被忽略」，而是**整个请求 500**
      // （`msgCode:500, Internal Server Error`）—— 服务端拿不到它认识的信封。
      payload: JSON.stringify({
        event_time: Date.now(),
        event_type: 'BUSINESS_FINISH',
        aid: '',
        rid: randomId(),
        oid: '',
        yid: '',
        uid: '',
        event_data: {
          session_id: turn.sessionId,
          business: {
            product: turn.product,
            version: turn.version,
            type: 'agent',
            id: closed.id,
            model_key: turn.modelKey,
            begin_at: closed.beginAt,
            end_at: closed.endAt,
            stage: closed.stage,
            name: turn.name,
          },
        },
      }),
      encodeVersion: '1',
    })

    try {
      const base = this.chatBaseUrl()
      const url = `${base}${FINISH_PATH}`
      const pathSig = pathSigFrom(url)
      const encoded = cosyEncode(new TextEncoder().encode(body))
      const date = String(Math.floor(Date.now() / 1000))
      const payloadB64 = buildPayloadB64(holder.session.info, this.clientVersion)
      const sig = signRequest(payloadB64, holder.session.cosyKey, date, encoded, pathSig)
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          'cosy-date': date,
          'cosy-user': holder.session.identity.uid,
          'cosy-key': holder.session.cosyKey,
          accept: '*/*',
          authorization: composeBearer(payloadB64, sig),
          'cosy-version': this.clientVersion,
          ...this.machineHeaders(holder),
        },
        body: encoded,
      })
      if (resp.status !== 200) {
        const text = await resp.text().catch(() => '')
        this.log(`轮次闭合失败: HTTP ${resp.status} ${truncate(text, 200)}`)
      }
    } catch (error: unknown) {
      this.log(`轮次闭合失败: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /**
   * 活动列表（`GET /sash/api/v1/me/campaigns?forceRefresh=true`）。
   * 协议来自社区参考实现（L0NE-6/Qoder-Daily），已在本机 CN 账号实测通过：
   * `GET {openapi}/sash/api/v1/me/campaigns?forceRefresh=true`，认证用与用量
   * 查询同一套 `jt-` 令牌（`jobToken.securityOauthToken`）。
   *
   * 注意路径里**没有**「签到」二字——它叫 campaigns（活动/权益）。这也是我早期
   * 把 `checkinSupported` 写死成 false 的原因：照着 checkin / signin / reward
   * 猜路径一律 404（实测猜了 13 个），于是误判成「Qoder 没有签到」。
   *
   * 旧语义（签到挑用的那一小片）保留在这里：它就是 `fetchCampaignFeed` 的
   * `campaigns` 投影，免得签到路径与卡片展示路径各写一份解析、日后漂移。
   */
  async fetchCampaigns(credential: string, signal?: AbortSignal): Promise<QoderCampaign[]> {
    return (await this.fetchCampaignFeed(credential, signal)).campaigns
  }

  /**
   * 完整活动面（含 `VIEW_DETAILS` banner 与顶层字段），给卡片「活动」区用。
   *
   * 实测（CN，2026-10-25）返回的整份形状：
   * `{ uid, showCampaign, claimable, campaignUrl, campaigns:[{ campaignId, campaignKey,
   *   actionType, startAt, endAt, claimStatus, benefit:{...},
   *   placements:[{ type, campaignUrl, content:{ zh:{title,description,detailUrl},
   *   en:{...} } }] }] }`。标题 / 描述 / 「查看详情」链接都在 `placements[*].content`
   * 里，按语言各一份；上游只下发它有的语言，所以这里原样收拢，不做翻译。
   *
   * 解析对字段缺席是**宽容**的：活动形状常按节日变（1024 集结、首月翻倍这类只在
   * 当期下发），缺字段就少渲染一点，绝不替上游编标题或链接。
   */
  async fetchCampaignFeed(credential: string, signal?: AbortSignal): Promise<QoderCampaignFeed> {
    const holder = await this.ensureSession(credential)
    const url = `${this.region.openapi}${this.region.campaignsPath}${CAMPAIGNS_QUERY}`
    const data = await this.sashRequest('GET', holder, url, undefined, signal)
    const rows = Array.isArray(data.campaigns)
      ? data.campaigns
      : Array.isArray((data.data as Record<string, unknown> | undefined)?.campaigns)
        ? ((data.data as Record<string, unknown>).campaigns as unknown[])
        : []
    return {
      campaigns: rows
        .map((entry): QoderCampaign | undefined => projectCampaignEntry(entry))
        .filter((c): c is QoderCampaign => c !== undefined),
      ...(typeof data.campaignUrl === 'string' && data.campaignUrl !== ''
        ? { campaignUrl: data.campaignUrl }
        : {}),
      ...(typeof data.showCampaign === 'boolean' ? { showCampaign: data.showCampaign } : {}),
      ...(typeof data.claimable === 'boolean' ? { claimable: data.claimable } : {}),
    }
  }

  /**
   * 签到：领取今天那一份每日 Credits。
   *
   * 一次调用自足——先拉活动列表找出可领的那条，再领取。三种结果分得很清：
   *   - `claimed`：领到了（带回数额与有效期）；
   *   - `already-claimed`：今天已经领过（`CLAIMED` / 409 / `ALREADY_CLAIMED` /
   *     `replayed`），**不是错误**——重复调用是幂等的；
   *   - `unavailable`：今天上游没下发活动（未开窗 / 已领到活动行消失 / 企业号
   *     不支持该活动），带上说明。
   */
  async claimDailyCredits(credential: string, signal?: AbortSignal): Promise<QoderCheckinOutcome> {
    const campaigns = await this.fetchCampaigns(credential, signal)
    const daily = campaigns.find(c => c.actionType === 'CLAIM_BENEFIT')
    const claimable = campaigns.find(c => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE')
    // 「下一次刷新」来自**这一窗的 `endAt`**（秒），无论这次是领到还是已领过。
    // 关键：已领过时也带着它 —— 「已领取」这个答案离开「还有多久刷新」是不完整的，
    // 用户看到「已领取」会以为要等到明天零点，而上游说的是次日 10:00。
    const nextRefreshAtMs = daily?.endAt === undefined ? undefined : daily.endAt * 1000
    if (claimable === undefined) {
      const claimed = daily?.claimStatus === 'CLAIMED'
      return claimed
        ? { status: 'already-claimed', ...(nextRefreshAtMs === undefined ? {} : { nextRefreshAtMs }) }
        : { status: 'unavailable', message: '上游今日没有下发可领取的签到活动' }
    }
    const holder = await this.ensureSession(credential)
    const url = `${this.region.openapi}${this.region.campaignsPath}/${encodeURIComponent(claimable.campaignId)}/claim`
    try {
      const data = await this.sashRequest('POST', holder, url, {}, signal)
      // 上游用 `status` 回报领取结果；`CLAIMED` 才算成功。
      if (String(data.status ?? '') === 'CLAIMED') {
        return {
          status: 'claimed',
          ...(claimable.amount === undefined ? {} : { amount: claimable.amount }),
          ...(claimable.validityDays === undefined ? {} : { validityDays: claimable.validityDays }),
          ...(nextRefreshAtMs === undefined ? {} : { nextRefreshAtMs }),
        }
      }
      return { status: 'unavailable', message: `签到未完成（上游状态 ${String(data.status ?? '未知')}）` }
    } catch (error) {
      // 重复领取是幂等的：409 / ALREADY_CLAIMED / replayed 一律当「今天已领」。
      if (error instanceof QoderUpstreamError && error.status === 409) {
        return { status: 'already-claimed', ...(nextRefreshAtMs === undefined ? {} : { nextRefreshAtMs }) }
      }
      throw error
    }
  }

  /**
   * `sash` 接口的通用请求（活动列表 / 领取共用）。
   *
   * 认证与用量查询同一套：`Authorization: Bearer <jobToken.securityOauthToken>`。
   * 但那两个接口需要 `cosy-clienttype: 10` 与 `user-agent: Qoder`——参考实现
   * 如此，缺了会被拒；而夹带 cosy 协议头（chat/models 那套）反而不认。
   *
   * 这里的 `10` 与 cosy 面的 {@link COSY_CLIENT_TYPE} **恰好同值但不同源**：
   * 这条是 sash 面自己的客户端标识（`SASH_CLIENT_TYPE`，逐条手写请求头），
   * 改 cosy 面的协议版本不该顺手动它，反之亦然。两个数字各自独立被测。sash 面
   * 也**不**发 `cosy-version`：它本来就不带那套协议头。
   *
   * **国际版额外需要设备风控头**（`Cosy-MachineToken/Code/Type`，见 device-risk.ts）：
   * 签到活动只下发给带这些头的请求，缺了就拿不到活动列表。国内版不需要，所以按
   * region 条件附加 —— 不要无条件发，多余的头在另一侧是噪音。
   */
  private async sashRequest(
    method: 'GET' | 'POST',
    holder: QoderSessionHolder,
    url: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    // 同上：签到也是 sash 面。
    const oauthToken = this.sashBearerOf(holder)
    if (oauthToken === '') {
      throw new QoderUpstreamError('auth', '两次令牌交换都没有拿到可用令牌，无法访问签到接口', 401)
    }
    const resp = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${oauthToken}`,
        'cosy-clienttype': SASH_CLIENT_TYPE,
        accept: 'application/json',
        'accept-language': 'zh-CN',
        'user-agent': SASH_USER_AGENT,
        ...(await this.deviceRiskHeaders()),
        ...(method === 'POST' ? { 'content-type': 'application/json', origin: this.region.openapi } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await resp.text()
    if (resp.status !== 200 && resp.status !== 201) {
      throw new QoderUpstreamError(classifyFailure(resp.status, text), `请求失败: HTTP ${resp.status} ${truncate(text, 200)}`, resp.status, deepestBusinessCode(text))
    }
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new QoderUpstreamError('unknown', `响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
  }

  /**
   * 本区域签到需要的设备风控头。
   *
   * 国内版返回空对象（不需要，发了反而是噪音）；国际版读取本机 UMID 组件的
   * 三件套。读取失败**不**静默降级成「无头请求」——那样只会拿到一个空的活动
   * 列表，用户看到「今天没有活动」而真实原因是取不到设备身份。所以这里让错误
   * 抛出去，由调用方带着原因回报。
   */
  private async deviceRiskHeaders(): Promise<Record<string, string>> {
    if (!this.region.requiresDeviceRisk) return {}
    const risk = await readDeviceRisk(this.regionKey)
    return {
      'cosy-machinetoken': risk.machineToken,
      'cosy-machinecode': risk.machineCode,
      'cosy-machinetype': risk.machineType,
    }
  }

  /**
   * 直连回退：`Bearer <PAT>` 打同一个端点。返回 undefined 表示这条回退路径
   * 也没给出 200（端点不接受直连 PAT，或网络失败）——由调用方决定是否把原始
   * 的凭据被拒错误抛出去。
   */
  private async fetchUsageDirect(
    url: string,
    credential: string,
    signal?: AbortSignal,
  ): Promise<QoderUsage | undefined> {
    try {
      // 与 jobTokenGet 同规：该区域要求设备风控时，回退路径也要带上那三件套，
      // 否则「主路径失败 → 走回退」恰好落在唯一漏发头的那条分支上。
      const resp = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/json',
          'cosy-clienttype': '10',
          'user-agent': 'Qoder',
          ...(await this.deviceRiskHeaders()),
        },
        ...(signal === undefined ? {} : { signal }),
      })
      if (resp.status === 200) {
        const data = await resp.json() as Record<string, unknown>
        return parseUsage(data)
      }
      if (resp.status === 401 || resp.status === 403) {
        // 两条路径都拒绝同一个 PAT：这就是凭据被拒，保留原始错误抛出。
        return undefined
      }
    } catch {
      // 直连路径失败不代表凭据坏了，交给调用方用原始错误判定。
      // 注意：本机取不到 UMID 组件时 deviceRiskHeaders() 会在这里抛错，同样
      // 落进这个分支 —— 结果是「回退没走成」，由 fetchUsage 把原始凭据错误抛给
      // 上层，用户看到的是带原因的那条，而不是一条凭空消失的用量查询。
    }
    return undefined
  }

  /**
   * 带 cosy bearer 的 GET。
   *
   * `extraHeaders` 只用于**单条请求的协议标签覆盖**（issue #3 的目录通道），
   * 排在最后，所以可以盖掉 `DEFAULT_HEADERS` 里的同名键。它不参与签名：
   * 签名材料是 `md5(payloadB64 \n cosyKey \n date \n body \n pathSig)`，里
   * 面没有任何请求头。
   */
  private async bearerGet(
    holder: QoderSessionHolder,
    url: string,
    signal?: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const pathSig = pathSigFrom(url)
    const payloadB64 = buildPayloadB64(holder.session.info, this.clientVersion)
    const date = String(Math.floor(Date.now() / 1000))
    const sig = signRequest(payloadB64, holder.session.cosyKey, date, '', pathSig)
    const bearer = composeBearer(payloadB64, sig)
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'cosy-date': date,
      'cosy-user': holder.session.identity.uid,
      'cosy-key': holder.session.cosyKey,
      accept: 'application/json',
      authorization: bearer,
      'cosy-version': this.clientVersion,
      ...this.machineHeaders(holder),
      ...extraHeaders,
    }
    const resp = await this.fetchImpl(url, {
      headers,
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await resp.text()
    if (resp.status !== 200) {
      throw new QoderUpstreamError(classifyFailure(resp.status, text), `请求失败: HTTP ${resp.status} ${truncate(text, 200)}`, resp.status, deepestBusinessCode(text))
    }
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new QoderUpstreamError('unknown', `响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数（导出供测试）
// ---------------------------------------------------------------------------

/**
 * 把上游的一条 campaign 投影成 `QoderCampaign`（宽容：缺字段就少渲染，不编造）。
 *
 * `placements` 是数组，每个元素带 `content: { zh?: {…}, en?: {…} }`（POPUP / USAGE
 * 各一份）。同一语言的文案取**第一份非空**：同一活动通常多份完全相同，重复渲染
 * 只会让卡片上出现两行一样的东西。
 */
export function projectCampaignEntry(entry: unknown): QoderCampaign | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const raw = entry as Record<string, unknown>
  const campaignId = typeof raw.campaignId === 'string' ? raw.campaignId : ''
  if (campaignId === '') return undefined
  const benefit = (typeof raw.benefit === 'object' && raw.benefit !== null ? raw.benefit : {}) as Record<string, unknown>
  const validity = (typeof benefit.validity === 'object' && benefit.validity !== null ? benefit.validity : {}) as Record<string, unknown>
  const placements = Array.isArray(raw.placements) ? (raw.placements as unknown[]) : []
  let campaignUrl = ''
  const content: Record<string, QoderCampaignContent> = {}
  for (const p of placements) {
    if (!p || typeof p !== 'object') continue
    const slot = p as Record<string, unknown>
    if (campaignUrl === '' && typeof slot.campaignUrl === 'string') campaignUrl = slot.campaignUrl
    const slotContent = slot.content
    if (!slotContent || typeof slotContent !== 'object') continue
    for (const [lang, text] of Object.entries(slotContent as Record<string, unknown>)) {
      if (!text || typeof text !== 'object') continue
      const t = text as Record<string, unknown>
      const row: QoderCampaignContent = {
        ...(typeof t.title === 'string' ? { title: t.title } : {}),
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        ...(typeof t.detailUrl === 'string' ? { detailUrl: t.detailUrl } : {}),
        ...(typeof t.buttonText === 'string' ? { buttonText: t.buttonText } : {}),
      }
      const prior = content[lang]
      if (prior === undefined || (Object.keys(prior).length === 0 && Object.keys(row).length > 0)) {
        content[lang] = row
      }
    }
  }
  return {
    campaignId,
    actionType: typeof raw.actionType === 'string' ? raw.actionType : '',
    claimStatus: typeof raw.claimStatus === 'string' ? raw.claimStatus : '',
    ...(typeof raw.campaignKey === 'string' && raw.campaignKey !== '' ? { campaignKey: raw.campaignKey } : {}),
    ...(campaignUrl !== '' ? { campaignUrl } : {}),
    ...(typeof benefit.amount === 'number' ? { amount: benefit.amount } : {}),
    // `mode` 缺席时按相对天数处理：这是上游至今给过的唯一口径，也是 activity
    // 文案「领取后 30 天有效」的说法。但**显式的**其它 mode 一律不采用天数 ——
    // 见 `QoderCampaign.validityDays` 的注释。
    ...(typeof validity.days === 'number' && (validity.mode === undefined || validity.mode === 'RELATIVE_DAYS')
      ? { validityDays: validity.days }
      : {}),
    // 活动窗：秒 → 毫秒之外的**原值也留着**，倒计时由 UI 按 region 的时区算。
    // 这里保留秒，因为 `endAt` 与 `startAt` 同源同单位，混着传才容易错。
    ...(typeof raw.startAt === 'number' ? { startAt: raw.startAt } : {}),
    ...(typeof raw.endAt === 'number' ? { endAt: raw.endAt } : {}),
    ...(Object.keys(content).length > 0 ? { content } : {}),
  }
}

/** jobToken 交换请求体。PAT 或 `drt-` refreshToken 二选一。 */
export function jobTokenBody(credential: string): string {
  const isRefresh = credential.startsWith('drt-')
  const inner = {
    personalToken: isRefresh ? '' : credential,
    securityOauthToken: '',
    refreshToken: isRefresh ? credential : '',
    needRefresh: isRefresh,
    authInfo: {},
  }
  const outer = { payload: JSON.stringify(inner), encodeVersion: '1' }
  const plain = JSON.stringify(outer)
  return cosyEncode(new TextEncoder().encode(plain))
}

function randomId(): string {
  return crypto.randomUUID()
}

/**
 * 解析一条 SSE 帧：
 * `data: {"headers":{...},"body":"<inner json>","statusCodeValue":200}`
 * 内层：`{"choices":[{"delta":{...}}], "usage":{...}}` 或业务错误 `{"code":"115","message":"..."}`。
 * 返回 undefined 表示本帧无可消费内容（或 [DONE] 之前的空帧）。
 */
export function parseStreamDelta(dataPayload: string): QoderChatDelta | undefined {
  let wrapper: Record<string, unknown>
  try {
    wrapper = JSON.parse(dataPayload) as Record<string, unknown>
  } catch {
    return undefined
  }
  // 信封层错误：HTTP 200 建流后，上游把 provider 故障包在信封里投递。
  const scv = wrapper.statusCodeValue
  if (scv !== undefined && scv !== null && Number(scv) !== 200) {
    const detail = typeof wrapper.body === 'string' ? wrapper.body : dataPayload.slice(0, 400)
    // **这条路径就是本轮 bug 的现场**：用户实拍那句「Qoder 拒绝了这个账号的
    // PAT」，来自这里对 `statusCodeValue: 403` + body `{"code":"110",…}` 的分类。
    // 信封里的业务码比信封状态更具体，所以优先按码分（见 classifyFailure）。
    throw new QoderUpstreamError(
      classifyFailure(Number(scv), detail),
      `上游信封错误: HTTP ${scv} ${truncate(detail, 300)}`,
      Number(scv),
      deepestBusinessCode(detail),
      // issue #24 的现场就是这条：`code 10605 / subCode RESOURCE_LIMIT` 的信封
      // 里带着 `retryAfterSeconds`，此前读到即丢。
      retryAfterMsOf(detail),
      // issue #26：同一个信封里还带着 `isQueued` —— 上游明说「在排队、服务
      // 可用、30 秒后再来」。此前这条被整段丢掉，池子把它报成「连不上上游」。
      queueOf(detail),
    )
  }
  const innerStr = wrapper.body
  if (typeof innerStr !== 'string' || innerStr === '') return undefined
  let inner: Record<string, unknown>
  try {
    inner = JSON.parse(innerStr) as Record<string, unknown>
  } catch {
    return undefined
  }
  // 上游会投递 `body: "null"` 的**空帧**（实测 2026-10-29，cn 的 `mmodel`：
  // 首帧 role-only 之后紧接一帧 `"null"`）。`JSON.parse('null')` 合法返回
  // `null`，于是下一行 `inner.code` 直接 TypeError —— 整个流被这条空帧打断，
  // 用户看到的是「这个模型坏了」，而模型本身完全正常。空帧就是「本帧无可消费
  // 内容」，与解析失败同义：返回 undefined，让调用方跳过它。
  if (inner === null || typeof inner !== 'object') return undefined

  // 业务错误：{"code":"115","message":"..."}
  if (typeof inner.code === 'string' && inner.code !== '' && inner.code !== '0') {
    const detail = typeof inner.message === 'string' ? inner.message : JSON.stringify(inner.message ?? '')
    throw new QoderUpstreamError(
      classifyBusinessCode(inner.code),
      `上游业务错误 code=${inner.code}: ${String(inner.message ?? '')}`,
      0,
      inner.code,
      // issue #26：业务码帧里同样可能带着排队信封（`isQueued` + 等待秒数）。
      retryAfterMsOf(detail),
      queueOf(detail),
    )
  }

  const usageIn = readTokens(inner.usage, 'prompt_tokens')
  const usageOut = readTokens(inner.usage, 'completion_tokens')
  // 缓存命中数（issue #4）。取不到时是 `undefined` 而不是 0：上游这一帧没报
  // 与「命中 0 个」是两件事，抽取层不该替上游下结论。
  const usageCached = readCachedTokens(inner.usage)
  const tokens = usageCached === undefined
    ? { inputTokens: usageIn, outputTokens: usageOut }
    : { inputTokens: usageIn, outputTokens: usageOut, cachedTokens: usageCached }

  const choices = Array.isArray(inner.choices) ? inner.choices : []
  for (const ch of choices as Array<Record<string, unknown>>) {
    const delta = ch.delta as Record<string, unknown> | undefined
    if (!delta) continue
    const role = typeof delta.role === 'string' ? delta.role : ''
    const content = typeof delta.content === 'string' ? delta.content : ''
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
    const toolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0 ? delta.tool_calls : undefined
    if (role !== '' || content !== '' || reasoning !== '' || toolCalls !== undefined) {
      return { role, content, reasoningContent: reasoning, toolCalls, ...tokens }
    }
  }
  if (usageIn > 0 || usageOut > 0) {
    return { role: '', content: '', reasoningContent: '', toolCalls: undefined, ...tokens }
  }
  return undefined
}

function readTokens(usage: unknown, key: string): number {
  if (!usage || typeof usage !== 'object') return 0
  const v = (usage as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : 0
}

/**
 * 读缓存命中的输入 token 数（issue #4）。
 *
 * 为什么这里值得一个专门的函数、而不是顺手写进 `readTokens`：**它有三个可能的
 * 位置**，而各家的写法不统一（宿主 `parseChunkUsage` 里列过同一张表）：
 *
 *   1. `prompt_tokens_details.cached_tokens` —— OpenAI / OpenRouter，也是实测
 *      上 Qoder 网关正在用的那个（见 `QoderChatDelta.cachedTokens` 的真实样本）。
 *   2. `prompt_cache_hit_tokens` —— DeepSeek 系，顶层的另一个拼法。
 *   3. `cached_tokens` —— Kimi 文档里放顶层。
 *
 * 取**第一个存在**的那个，不做相加：它们是同一个量的三种写法，不是三个分量。
 *
 * 返回 `undefined` 表示「上游没报」。**不要**把它折成 0：那会让「这一帧没有
 * usage」与「这次一个都没命中」变成同一个数字，而宿主的百分比正是拿它算的
 * ——issue #4 的整个症状就是「0% 不可信」，用一个默认 0 去修它等于把病保留下来。
 *
 * 另一条**不可踩的坑**：`cached_tokens` 是 `prompt_tokens` 的**子集**（实测
 * 2032 / 2038），所以绝不能加进 `prompt_tokens`。宿主侧自己会做
 * `input = prompt_tokens - cacheRead`，两边各按「子集」理解才对得上。
 */
function readCachedTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const details = record['prompt_tokens_details']
  const fromDetails = details !== null && typeof details === 'object' && !Array.isArray(details)
    ? readCount((details as Record<string, unknown>)['cached_tokens'])
    : undefined
  if (fromDetails !== undefined) return fromDetails
  const fromHit = readCount(record['prompt_cache_hit_tokens'])
  if (fromHit !== undefined) return fromHit
  return readCount(record['cached_tokens'])
}

/** 有限、非负的数字；其它一律 `undefined`（`NaN` / 负数 / 字符串都不算数）。 */
function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 解析用量响应（兼容 qoderUsage 内层与平铺两种形状）。 */
export function parseUsage(data: Record<string, unknown>): QoderUsage | undefined {
  const qoderUsage = data.qoderUsage as Record<string, unknown> | undefined
  const source = qoderUsage ?? data
  const userQuota = readBucket(source.userQuota)
  const addOn = source.addOnQuota as Record<string, unknown> | undefined
  const org = source.orgResourcePackage as Record<string, unknown> | undefined
  const out: QoderUsage = {
    userType: typeof source.userType === 'string' ? source.userType : undefined,
    expiresAt: typeof source.expiresAt === 'number' ? source.expiresAt : undefined,
    upgradeUrl: typeof source.upgradeUrl === 'string' ? source.upgradeUrl : undefined,
    isQuotaExceeded: source.isQuotaExceeded === true,
  }
  if (userQuota) out.userQuota = userQuota
  if (addOn) {
    out.addOnQuota = {
      ...readBucket(addOn),
      detailUrl: typeof addOn.detailUrl === 'string' ? addOn.detailUrl : undefined,
    }
  }
  if (org) {
    out.orgResourcePackage = {
      used: num(org.used), cap: num(org.cap), remaining: num(org.remaining),
      percentage: num(org.percentage), available: org.available === true,
    }
  }
  const dedicated = readDedicatedPackages(source.dedicatedResourcePackages)
  if (dedicated.length > 0) out.dedicatedResourcePackages = dedicated
  return out
}

/**
 * 读 `dedicatedResourcePackages`（issue #38）。
 *
 * 三条取舍，都对应上游这一块真实存在的形态：
 *
 *  1. **整块读不懂就当没有**：不是数组、或者元素不是对象 → `[]`。一个读不懂的
 *     专属包不该让整次用量解析失败（那会把「有积分」变成「积分读不出来」）。
 *  2. **筛掉明确停用的**：`available === false` 直接丢；`status` 有值却不等于
 *     ACTIVE 也丢。两个字段是同一件事的两种写法，只认**明确说不**的那一侧 ——
 *     字段缺席不构成停用证据（老上游可能只发其中一个）。不筛的话，一个已过期 /
 *     已停用的包会顶着一行「剩余 888」出现在读数里，用户会以为那笔钱还在。
 *  3. **`remaining` 缺席不折成 0**（与 `readBucket` 同一条规矩）：0 是「这个包
 *     用完了」的断言，缺席只是「上游这一行没写」。界面把缺席画成「—」。
 */
function readDedicatedPackages(value: unknown): QoderDedicatedPackage[] {
  if (!Array.isArray(value)) return []
  const out: QoderDedicatedPackage[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    if (raw['available'] === false) continue
    const status = typeof raw['status'] === 'string' ? raw['status'] : undefined
    if (status !== undefined && status !== DEDICATED_ACTIVE_STATUS) continue
    const title = readI18nLabel(raw['displayLabels'], 'title')
    const description = readI18nLabel(raw['displayLabels'], 'description')
    out.push({
      // id 缺席时用下标位置兜底会让 React key 在同一次报文内相对稳定；但上游
      // 实测恒有 id，所以这里退化成 name 或空串都只是防御，不额外编造。
      id: typeof raw['id'] === 'string' && raw['id'] !== ''
        ? raw['id']
        : (typeof raw['name'] === 'string' ? raw['name'] : ''),
      ...title === undefined ? {} : { title },
      ...description === undefined ? {} : { description },
      // 负数不是上游可能给出的余额（实测恒 >= 0）；真出现时按 0 读 —— 一个
      // 「剩余 -5」出现在读数里只会让读者以为是插件算错了。非有限数照旧当成
      // 「没报」（`num` 只放行 `typeof number`，NaN 会落进来，这里挡掉）。
      ...!isFiniteNumber(num(raw['remaining'])) ? {} : { remaining: Math.max(num(raw['remaining'])!, 0) },
      ...!isFiniteNumber(num(raw['total'])) ? {} : { total: num(raw['total'])! },
      ...!isFiniteNumber(num(raw['expiresAt'])) ? {} : { expiresAtMs: num(raw['expiresAt'])! },
      ...status === undefined ? {} : { status },
    })
  }
  return out
}

/** 上游声明的「这个专属包还在生效」。 */
const DEDICATED_ACTIVE_STATUS = 'QUOTA_DETAIL_STATUS_ACTIVE'

/** 有限数才算「上游报了」。`NaN` / `Infinity` 与缺席同义（`num` 只筛 typeof）。 */
function isFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value)
}

/**
 * 从 `displayLabels[]` 里取某一条双语文案。
 *
 * 形状是 `[{ dimension: 'title', value: 'zh 原文', valueI18n: { 'zh-CN': …, 'en-US': … } }, …]`。
 * **两种语言都收**，界面按当前语言挑：这一层不知道也不该猜读者用哪种语言
 * （客户端才握着宿主语言，见 `promo-badge.ts` 的 `hostLanguage`）。
 *
 * `valueI18n` 缺席时退回裸 `value`：那至少是上游自己的一句话，比没有强。
 */
function readI18nLabel(
  labels: unknown,
  dimension: 'title' | 'description',
): { zh?: string | undefined, en?: string | undefined } | undefined {
  if (!Array.isArray(labels)) return undefined
  for (const entry of labels) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    if (row['dimension'] !== dimension) continue
    const i18n = row['valueI18n']
    const zh = i18n !== null && typeof i18n === 'object' && !Array.isArray(i18n)
      ? textOf((i18n as Record<string, unknown>)['zh-CN']) ?? textOf((i18n as Record<string, unknown>)['zh'])
      : undefined
    const en = i18n !== null && typeof i18n === 'object' && !Array.isArray(i18n)
      ? textOf((i18n as Record<string, unknown>)['en-US']) ?? textOf((i18n as Record<string, unknown>)['en'])
      : undefined
    const plain = textOf(row['value'])
    if (zh === undefined && en === undefined && plain === undefined) return undefined
    return {
      ...zh === undefined && plain === undefined ? {} : { zh: zh ?? plain! },
      ...en === undefined && plain === undefined ? {} : { en: en ?? plain! },
    }
  }
  return undefined
}

/** 非空、非全空白的字符串。 */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function readBucket(value: unknown): { total?: number | undefined; used?: number | undefined; remaining?: number | undefined; percentage?: number | undefined } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  return {
    total: num(v.total), used: num(v.used), remaining: num(v.remaining), percentage: num(v.percentage),
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

/** HTTP 状态 → 错误分类（内容审核标记优先于状态码，与 Go 版一致）。 */
export function classifyHttpStatus(status: number, detail: string): UpstreamErrorKind {
  // DataInspectionFailed / inappropriate content 等标记即使出现在
  // 5xx/200 流里也按内容策略拒绝处理（Go 版 errors_test 同判）。
  if (isContentPolicy(detail)) return 'content-policy'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limited'
  if (status === 400) return 'invalid-request'
  if (status === 418 || status >= 500) return 'transient'
  return 'unknown'
}

/**
 * 从上游错误体里取**业务码**（`{"code":"110","message":"…"}`）。
 *
 * 上游在这一点上有过两种写法：字符串 `"110"` 与裸数字 `110`，都见过；这里
 * 一律归一成字符串。取不到（不是 JSON、没有 code、code 不是串/数）返回
 * `undefined` —— 调用方据此回落到 HTTP 状态分类，**绝不**把「读不出码」当成
 * 某种结论。
 */
export function businessCodeOf(detail: string): string | undefined {
  const trimmed = detail.trim()
  if (!trimmed.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = (parsed as Record<string, unknown>).code
  if (typeof raw === 'string' && raw !== '') return raw
  // 只接受整数码：`code: 1.5` 之类的东西不是上游的错误码，不该被当成认识的码。
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw)
  return undefined
}

/**
 * 下钻的最大层数：防自嵌套/循环引用把解析变成死循环。
 *
 * 实测最深的两层就够（issue #6 的真实帧是「外层信封 → 内层业务码」），但这里给
 * 一点余量，因为上游换一次包装就会多一层，而多一层只是多一次 JSON.parse。
 */
const MAX_CODE_NESTING = 6

/**
 * 取上游申报的「请等这么久再试」，毫秒（issue #24）。
 *
 * 实测形状（`HTTP 4xx` + `code 10605 / subCode RESOURCE_LIMIT`）：
 *
 * ```json
 * {"code":"10605","message":"{\"isQueued\":false,\"modelKey\":\"…\",
 *   \"queueCount\":0,\"queueType\":\"p2\",\"retryAfterSeconds\":5,
 *   \"serviceAvailable\":true,\"waitTime\":0}","subCode":"RESOURCE_LIMIT"}
 * ```
 *
 * 与 {@link deepestBusinessCode} 走同一条路（只沿 `message` 往里剥、有深度上限），
 * 因为这两个值在同一个信封里，分头解析迟早漂移。
 *
 * **只认 JSON 里的数字秒。** 不解析 HTTP `Retry-After` 头：宿主在 pi-ai 路由上
 * 只从文案分类、不读头（见 `llm-pi-ai/src/stream.ts` 的 `classifyPiAiError`），
 * 所以头带了也没人读；而这里读到的值会进文案，是**真的**能影响等待的那条路。
 * 头仍然照发（`Retry-After`），那是给别的消费者看的，不是本插件的判据。
 *
 * 上限 1 小时：超过就当上游没申报。一个离谱的值会让宿主放弃这次重试
 * （`llm-retry` 在 `> maxDelayMs` 时 `next()`），比不报更糟。
 */
const MAX_RETRY_AFTER_MS = 3_600_000

/**
 * 解析 HTTP `Retry-After` 头（两种合法形式：秒数 / HTTP-date）。
 *
 * 只作**兜底**：上游的申报值在 body 里（`retryAfterSeconds`），头是次要来源。
 * 判据同 {@link retryAfterMsOf}：正数、且不超过 1 小时。
 */
export function retryAfterMsOfHeader(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  if (/^\d+$/u.test(text)) {
    const seconds = Number(text)
    const ms = Math.round(seconds * 1000)
    return ms > 0 && ms <= MAX_RETRY_AFTER_MS ? ms : undefined
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return undefined
  const ms = at - nowMs
  return ms > 0 && ms <= MAX_RETRY_AFTER_MS ? ms : undefined
}

export function retryAfterMsOf(detail: string): number | undefined {
  for (const record of envelopeRecords(detail)) {
    // 字段名只认这一个：上游还有 `waitTime`（排队已等时长）与 `queueCount`，
    // 那些都不是「该等多久」，拿错了会把等待算成 0 或算成别人的排队量。
    const seconds = record.retryAfterSeconds
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      const ms = Math.round(seconds * 1000)
      return ms <= MAX_RETRY_AFTER_MS ? ms : undefined
    }
  }
  return undefined
}

/**
 * 沿一条失败信封往里剥，产出每一层的记录对象。
 *
 * **为什么需要它（issue #26）**：上游的信封有两种「往里包」的方式，两种都在
 * 现场出现过：
 *
 * ```json
 * { "code": "403", "message": "{\"code\":\"10605\",\"message\":\"…\"}" }   // 字符串
 * { "code": "403", "message": "{\"code\":\"10605\",\"message\":{…}}" }   // 对象
 * ```
 *
 * 第二种里，`message` **不是**字符串而是对象，而此前 `retryAfterMsOf` 与
 * `deepestBusinessCode` 都写着「`message` 是字符串才继续往里走」—— 于是
 * 走到第二层就停下，`retryAfterSeconds` 明明就在那层的 `message` 对象里，
 * 却读不出来。现场后果：上游说「等 30 秒」，插件读成「上游没说」，于是按
 * 30 分钟兜底冷却（差 60 倍）。
 *
 * 这里把「剥信封」收成**一处**实现，两个读者共用，避免两处再次漂移。深度
 * 上限沿用 {@link MAX_CODE_NESTING}。
 */
function envelopeRecords(detail: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = []
  let text: unknown = typeof detail === 'string' ? detail.trim() : ''
  for (let depth = 0; depth < MAX_CODE_NESTING; depth += 1) {
    let record: Record<string, unknown>
    if (typeof text === 'string') {
      if (!text.startsWith('{')) break
      const parsed = parseJson(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) break
      record = parsed as Record<string, unknown>
    } else if (typeof text === 'object' && text !== null && !Array.isArray(text)) {
      record = text as Record<string, unknown>
    } else {
      break
    }
    records.push(record)
    const message = record.message
    // 两种形态都继续往里走：字符串（要再解一层 JSON）与对象（直接就是下一层）。
    if (typeof message === 'string') {
      text = message.trim()
    } else if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
      text = message
    } else {
      break
    }
  }
  return records
}

/**
 * 上游的排队状态（issue #26）。
 *
 * 判据是上游**自己说的** `isQueued: true`；`serviceAvailable` 一并带出
 * （issue #29）：`true` 是「服务是好的，只是排在队里」，`false` 是「上游整体
 * 在拒服务」，两者对用户的行动指导完全不同 —— 判断见
 * {@link upstreamUnavailableOf}。返回 undefined 表示上游没提排队 —— 那时
 * 不许把任何失败说成「排队中」。
 *
 * `queueCount` 与 `retryAfterSeconds` 一并带出：前者让用户看到「排在第 1027
 * 位」，后者是「等 30 秒」—— 上游给了就显示，没给就不编。
 */
export function queueOf(detail: string): QoderQueueState | undefined {
  for (const record of envelopeRecords(detail)) {
    const isQueued = record.isQueued
    if (typeof isQueued !== 'boolean') continue
    const count = record.queueCount
    const queueType = record.queueType
    const seconds = record.retryAfterSeconds
    // issue #29：`serviceAvailable` 与 `isQueued` 在同一个信封里，此前读到了
    // 却不带出来，于是「上游整体不可用」被压成「你的账号在排队」。
    const serviceAvailable = record.serviceAvailable
    return {
      isQueued,
      ...typeof count === 'number' && Number.isFinite(count) && count >= 0 ? { queueCount: count } : {},
      ...typeof queueType === 'string' && queueType !== '' ? { queueType } : {},
      ...typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : {},
      ...typeof serviceAvailable === 'boolean' ? { serviceAvailable } : {},
    }
  }
  return undefined
}

/**
 * 上游是不是在说「**整体**拒服务」，而不是「你这个账号在排队」（issue #29）。
 *
 * 判据只认上游自己给的字段，且必须是 `isQueued: true` + 显式的
 * `serviceAvailable: false` 两条同时成立：
 *
 * - 只有 `isQueued` 而没有 `serviceAvailable` ⇒ **不是**这个结论（上游没说，
 *   不推断；退回旧的「排队」语义）。
 * - `serviceAvailable: true` ⇒ 服务是好的，就是排队，正常等即可。
 *
 * 为什么要分开：现场证据（issue #29）里 `queueCount: 0` 与
 * `serviceAvailable: false` 同时出现 —— 队列里一个人都没有，是上游整体在拒。
 * 这种形态下换号、换 PAT 都无效，把它记成账号级冷却会误导用户去重配凭据。
 */
export function upstreamUnavailableOf(queue: QoderQueueState | undefined): boolean {
  if (queue === undefined) return false
  if (queue.isQueued !== true) return false
  return queue.serviceAvailable === false
}

/**
 * 取**最深一层认识的**业务码（`{"code":"10605","message":"…"}`）。
 *
 * 为什么不能只看最外层（issue #6）：上游的失败帧常是外层信封继续往里包，实拍帧：
 *
 * ```json
 * { "code": 403, "message": "{\"code\":\"10605\",\"message\":\"qmodel 排队中，请稍后重试\"}" }
 * ```
 *
 * 外层那个 `403` 是 HTTP 语义的码（`classifyBusinessCode('403')` → `unknown`），
 * 真正的业务码 `10605`（排队）藏在内层 `message` 里。只剥一层 ⇒ 读不到码 ⇒ 回落
 * HTTP 状态 ⇒ `403 → auth → credential-rejected → 永久剔除账号 + 叫用户换 PAT`。
 * 而 `10605`/`10408` 本来就在 `TRANSIENT_CODES` 里 —— 码表没缺，缺的是「读到它」。
 *
 * 三条纪律（都来自现场形态，不是风格偏好）：
 *
 * 1. **只沿 `parsed.message` 往里走。** 改成遍历 `error`/`data`/`result` 之类更宽
 *    的键集合，会把外层信封那个 HTTP 语义的 `code`（或 `code: 0` 之类无关字段）
 *    当成业务码返回 —— 那比现在更糟，因为 `classifyBusinessCode` 一旦命中就可能
 *    盖住真码。
 * 2. **认不出的码要记进 `fallback` 并继续往里找**，不能直接 return。用例
 *    「外层 403 + 内层 10605/402」就靠这条才过：外层认不出、里层才认得出，先
 *    返回外层就还是 `auth`。
 * 3. **认不出就原样回落 `classifyHttpStatus`** —— `TOKEN_EXPIRE` 这类字符串码、
 *    非 JSON body、空 body 的行为与改动前逐字一致（真被拒的那一侧不能被改坏）。
 */
export function deepestBusinessCode(detail: string): string | undefined {
  let fallback: string | undefined
  // 与 `retryAfterMsOf` 共用同一条剥壳路径（`envelopeRecords`）：issue #26 的
  // 现场里 `message` 是**对象**的那种信封此前读不到内层业务码，于是 `10605`
  // 被丢掉、403 回落成 `auth` —— 排队被说成「凭据被拒」。
  for (const record of envelopeRecords(detail)) {
    const raw = record.code
    let code: string | undefined
    if (typeof raw === 'string' && raw !== '') code = raw
    // 只接受整数码：`code: 1.5` 之类的东西不是上游的错误码，不该被当成认识的码。
    else if (typeof raw === 'number' && Number.isInteger(raw)) code = String(raw)
    if (code !== undefined) {
      // 认识的码说了算（纪律 2：认不出的不 return，继续往里找）。
      if (classifyBusinessCode(code) !== 'unknown') return code
      if (fallback === undefined) fallback = code
    }
  }
  return fallback
}

/**
 * 一次失败的分类：**业务码优先于 HTTP 状态**，状态只作兜底。
 *
 * 这是本轮的根因所在（用户实拍：国际版「Qoder 拒绝了这个账号的 PAT」）。实测
 * 上游对**当日用量用尽**回的是
 *
 * ```
 * HTTP 403 {"code":"110","message":"Billing daily count exceeded"}
 * ```
 *
 * 而旧实现只看状态：`403 → auth → credential-rejected → 「请添加新 PAT」`。
 * 那句话不只是文案难听 —— `credential-rejected` 在账号池里是**无条件永久排除**
 * （`exclusionOf` 连冷却期都不看，理由写得很对：令牌被拒，等也没用）。于是
 * 一个只是今天用满、明天自动恢复的账号被踢出池且**不会自愈**，同时被要求去做
 * 一件根本无效的事（换 PAT）。
 *
 * 官方码表（docs.qoder.com/zh/cli/sdk/errors）里 `105` 才是「登录态或 Access
 * Token 已过期」；`110`/`113`/`115`–`119`/`122` 全是**用量与配额**族。也就是说
 * 「403 就是凭据坏了」这个推断在协议层面根本不成立。
 *
 * 认识的码说了算；不认识的（如 `TOKEN_EXPIRE` 这类字符串码）回落状态分类，
 * 行为与改动前一致。
 *
 * 取码用 {@link deepestBusinessCode} 而不是 {@link businessCodeOf}：业务码可能
 * 藏在第二/三层包装里（issue #6 的实拍帧），只剥一层就会把「排队」当成
 * 「凭据被拒」，进而永久剔除一个其实几分钟就自愈的账号。
 */
export function classifyFailure(status: number, detail: string): UpstreamErrorKind {
  const code = deepestBusinessCode(detail)
  if (code !== undefined) {
    const byCode = classifyBusinessCode(code)
    if (byCode !== 'unknown') return byCode
  }
  return classifyHttpStatus(status, detail)
}

/** 业务 code → 错误分类（官方码表，见 {@link classifyFailure}）。 */
export function classifyBusinessCode(code: string): UpstreamErrorKind {
  if (code === '105') return 'auth' // 登录态或 Access Token 已过期
  // 用量与配额族：等周期重置或补额度，**不是**凭据问题。
  // 402 / 6004 是 Go 参考实现与本项目早期实测带回来的，保留。
  if (QUOTA_CODES.has(code)) return 'quota-exhausted'
  if (code === '406') return 'content-policy' // 敏感内容或模型拒绝
  // 请求本身无法满足：改输入或改配置，原地重试无意义。
  if (REQUEST_CODES.has(code)) return 'invalid-request'
  // 500 请求或网络失败 / 10408 超时 / 10500 模型服务内部错误 / 10605 排队。
  if (TRANSIENT_CODES.has(code)) return 'transient'
  return 'unknown'
}

const QUOTA_CODES: ReadonlySet<string> = new Set([
  '110', // 达到当日用量限制（本轮实测到的那一个）
  '112', // 额度不足，message 带 pricingUrl 指向充值页（issue #44）——模型级额度
  // 112 与 110/144 同族：额度不足、会恢复、换 PAT 无效。此前不在码表里 →
  // 403 回落 auth → credentialOutcomeOf 降级 unavailable → 文案「连不上上游」
  // + 整号冷却（issue #44 现场 6 个号同时如此）。维护者定性「模型额度用完，
  // 换模型即可」，归配额族后走 out-of-credit 冷却、到期自愈。
  '113', // 用量配额耗尽
  '115', // 达到免费用户配额
  '116', // 团队管理员 Credits 耗尽
  '117', // 团队成员 Credits 耗尽
  '118', // 个人 Credits 耗尽
  '119', // 所选模型的免费额度已用完
  '122', // Billing Group 的 Credits 达到上限
  '144', // 专属积分包余额不足（issue #45）—— message 带 modelKey，是按模型的额度
  // 144 与 110 同族（都是「额度不足」），只是粒度不同：110 是账号级当日次数，
  // 144 是某个专属包用完。此前 144 不在码表里 → 403 回落 auth → 宿主侧
  // 401 invalid_api_key + 账号被 credential-rejected 永久排除（充值也不自愈）。
  // 归到配额族后：shim 映射 429 quota_exceeded，池记录 out-of-credit 走冷却期、
  // 到期自动回池。探针记录了 modelId 时，exclusionOf 还会只排除那一个模型。
  '147', // 付费资源包余额不足（issue #48）—— 与 144 message 一字不差，只差
  // modelKey（qfmodel）与 subCode（MODEL_PAID_CONFIRM_REQUIRED）。官方码表
  // （docs.qoder.com/zh/cli/sdk/errors）当天抓文本 147 仍是 0 命中，又一个没写进
  // 文档的新码。漏码 → 403 回落 auth → 宿主 401 invalid_api_key「API 密钥无效」，
  // 用户被叫去换 PAT，而真正该做的是充值/换模型 —— 处置方式完全相反。
  // 与 144 同型：归配额族后走 out-of-credit 冷却、到期自愈，按 modelId 粒度排除。
  '402',
  '6004',
])

/** 416 范围/结构无法满足 · 430 能力不支持 · 80411 输入过长 · 80412 媒体过多。 */
const REQUEST_CODES: ReadonlySet<string> = new Set(['416', '430', '80411', '80412'])

const TRANSIENT_CODES: ReadonlySet<string> = new Set(['500', '10408', '10500', '10605'])

const CONTENT_POLICY_MARKERS = [
  'DataInspectionFailed',
  'inappropriate content',
  'input text data may contain',
  'ContentFilter',
  'SensitiveContent',
]

export function isContentPolicy(detail: string): boolean {
  return CONTENT_POLICY_MARKERS.some(marker => detail.includes(marker))
}

/** Parse JSON, or undefined when the body is not JSON at all. Never throws. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 这次失败是不是「用户/宿主主动取消」。
 *
 * 取消必须**原样抛出**：它不是一个可以换节点重试的失败，退回默认网关再发一遍
 * 只会让一场已经结束的对话多打一次上游（还可能计一次费）。`signal.reason` 在
 * 不同运行时里是 `DOMException` 或普通 `Error`，所以按 `name` 判而不按类型。
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
