/**
 * OpenAI ↔ Qoder 消息转换与聊天请求体构建。
 *
 * Qoder 网关（agent_chat_generation）说 OpenAI 形状的消息：
 * - 入站（发给网关）消息用 `contents` 数组承载文本/图像 parts；
 * - 出站（网关返回）SSE 的 delta 直接是 OpenAI 形状
 *   （choices[].delta.{role,content,reasoning_content,tool_calls}）。
 *
 * 模板取自 fengyinxia/qoder2api baseprompt.json（MINIMAL 变体，已实测
 * 可用；不带系统提示词，messages 完全由调用方替换）。
 *
 * @module dsh-connect-qoder/messages
 */

// ---------------------------------------------------------------------------
// 聊天请求体模板（与 qoder2api baseprompt.json 逐字段一致）
// ---------------------------------------------------------------------------

export interface QoderChatTemplate {
  request_id: string
  request_set_id: string
  chat_record_id: string
  stream: boolean
  chat_task: string
  chat_context: {
    extra: {
      modelConfig: { is_reasoning: boolean; key: string }
      originalContent: { type: string; text: string }
    }
    text: { type: string; text: string }
  }
  session_id: string
  source: number
  version: string
  aliyun_user_type: string
  session_type: string
  agent_id: string
  task_id: string
  model_config: {
    key: string
    is_vl: boolean
    is_reasoning: boolean
    source: string
  }
  /**
   * 思考强度档位（`low` / `medium` / `xhigh` …）。
   *
   * 实测自 Qoder 官方客户端：档位在这个**顶层**字段上，不在 `model_config`
   * 里；同时还会写一份到 `parameters.reasoning_effort`。缺席即用模型默认档。
   */
  reasoningEffort?: string
  /** 上游透传参数袋（含 `reasoning_effort`）。 */
  parameters?: Record<string, unknown>
  messages: unknown[]
  /**
   * 会话/任务记录。字段集合照抄官方客户端的 `business`（见 {@link QoderBusiness}）。
   *
   * 以前这里只有 `{id, name, begin_at}` —— 于是请求体里**没有** `product` /
   * `type` / `version` / `stage`，平台那条「会话记录」路径认不出这是什么产品
   * 发来的什么阶段的任务。缺字段不会报错（对话照常跑），只在**服务端记账**
   * 这一侧静默地什么都不落下。
   */
  business: QoderBusiness
  [key: string]: unknown
}

/**
 * 请求体 `business` 的完整形状。
 *
 * 全部字段取自反编译的真实客户端（`qoder-worker-runtime.obf.mjs`）：
 *
 * | 字段 | 来源 |
 * | --- | --- |
 * | `product` | `rk()` → `product: rjA() ?? process.env[...] ?? "cli"`；桌面端常量是 `"app"` |
 * | `type` | `rk()` → `type: process.env[...] ?? "agent"` |
 * | `version` | `upn(A,...)` 的第一个参数，客户端传自己的版本号（如 `1.1.86-hotfix.16`） |
 * | `id` / `begin_at` | `upn()` → `nXA()` / `Date.now()` |
 * | `stage` | `upn()` 里初始化成 `"init"`，之后由 `changeBusinessState()` 推进 |
 * | `model_key` | `O3()` → `{...upn(...), ...n ? {model_key: n} : {}}` |
 * | `end_at` | 只在 `finalize()` 里写（生命周期结束时） |
 *
 * `stage` 的推进规则（客户端 `pye` 类）：`init → start → processing`，
 * 结束由 `finalize` 写 `complete` / `abort` / `error`，并且**只在有 `id` 时**推进。
 */
export interface QoderBusiness {
  id: string
  name: string
  begin_at: number
  /** 产品线：`cli`（PAT/CLI 通道）或 `app`（桌面客户端通道）。 */
  product?: string
  /** 任务类型，客户端默认 `agent`。 */
  type?: string
  /** 发起请求的客户端版本号。 */
  version?: string
  /** 生命周期阶段。 */
  stage?: QoderBusinessStage
  /** 本任务用的模型 key。 */
  model_key?: string
  /** 生命周期结束时刻（`finalize` 才写）。 */
  end_at?: number
}

/** `business.stage` 的取值域（客户端 `sR` 模块里的常量）。 */
export type QoderBusinessStage = 'init' | 'start' | 'processing' | 'complete' | 'abort' | 'error'

/**
 * `business.product` 的取值。`cli` 是 CLI 产品线的默认值（`MKA = "cli"`），
 * `app` 是桌面客户端的常量（`Od.businessProduct = "app"`）。
 */
export type QoderBusinessProduct = 'cli' | 'app'

/**
 * `session_type` 按区域取值的两个已知值。
 *
 * 客户端：`SPr = ti ? "qoderclicn" : "qodercli"`（`ti` 即国内版判定）。以前这里
 * 写死成 `'qodercli'`，于是**国内版**请求带着国际版的会话类型出去。
 */
export type QoderSessionType = 'qodercli' | 'qoderclicn'

/**
 * 按区域取 `session_type`（客户端 `SPr = ti ? "qoderclicn" : "qodercli"`）。
 *
 * 国内外是**两套**会话类型，不是同一套换个名字：写死国际版的值，
 * 国内版请求就带着一个不属于它的会话类型出去。
 */
export function sessionTypeOf(region: 'cn' | 'global'): QoderSessionType {
  return region === 'cn' ? 'qoderclicn' : 'qodercli'
}

/**
 * 给模板挂上 `business` 的**身份**字段（product / type / version / stage）。
 *
 * 拆成独立函数是因为它只负责「这台机器 / 这条产品线是谁」，而 `id` / `begin_at`
 * 这类「这场会话是哪一场」由调用方的会话表管（见 `upstream.ts` 的 `sessionOf`）。
 * 两者都是**整场会话内恒定**的：`id` 每轮换新会让服务端把一场会话记成 N 条
 * 互不相干的记录，见 `QoderBusiness` 的说明。`stage` 由调用方按生命周期推进。
 */
export function applyBusinessIdentity(
  body: QoderChatTemplate,
  identity: {
    product: QoderBusinessProduct
    version: string
    stage?: QoderBusinessStage
    modelKey?: string
  },
): void {
  body.business.product = identity.product
  // `type` 客户端恒为该值（`rk()` 的 `type: ... ?? "agent"`），不是可变项。
  body.business.type = 'agent'
  body.business.version = identity.version
  if (identity.stage !== undefined) body.business.stage = identity.stage
  if (identity.modelKey !== undefined) body.business.model_key = identity.modelKey
}

/** 构建一份全新的聊天请求体（每个请求必须换 ID）。 */
export function createChatBodyTemplate(): QoderChatTemplate {
  return {
    request_id: '',
    request_set_id: '',
    chat_record_id: '',
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      extra: {
        modelConfig: { is_reasoning: false, key: 'lite' },
        originalContent: { type: 'text', text: '' },
      },
      text: { type: 'text', text: '' },
    },
    session_id: '',
    source: 1,
    version: '3',
    aliyun_user_type: 'personal_standard',
    // 真正的值由调用方按区域覆盖（见 sessionTypeOf）；这里保留国际版默认，
    // 因为「没有区域信息」的老调用方此前拿到的就是它。
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: {
      key: 'lite',
      is_vl: false,
      is_reasoning: false,
      source: 'system',
    },
    messages: [],
    business: {
      id: '',
      name: 'hi',
      begin_at: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// OpenAI 消息 → Qoder 消息
// ---------------------------------------------------------------------------

/** 消息内容的一个 part（文本 / 图片），可带 prompt-cache 标记。 */
export interface QoderContentPart {
  type?: string
  text?: string
  image_url?: { url?: string }
  /** `cache_control: {type:'ephemeral'}`，见 {@link applyCacheControl}。 */
  cache_control?: { type: 'ephemeral'; ttl?: '1h' }
}

export interface QoderIncomingMessage {
  role: string
  /**
   * 纯文本内容；或 parts 数组。
   *
   * 两种形状上游都接受（客户端的 system 投影里 `1===t.length &&
   * "string"==typeof t[0]` 就直出字符串）。只有 {@link applyCacheControl}
   * 真要标记时才会把字符串转成数组。
   */
  content?: string | QoderContentPart[]
  contents?: QoderContentPart[]
  tool_calls?: unknown[]
  name?: string
  tool_call_id?: string
  reasoning_content_signature?: string
  response_meta?: Record<string, unknown>
}

function blankResponseMeta(): Record<string, unknown> {
  return {
    id: '',
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  }
}

function structuredMessage(role: string, text: string): QoderIncomingMessage {
  return {
    role,
    content: text,
    response_meta: blankResponseMeta(),
    reasoning_content_signature: '',
  }
}

function userMessage(text: string, images: string[] = []): QoderIncomingMessage {
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const url of images) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  if (text.trim()) {
    parts.push({ type: 'text', text })
  }
  if (parts.length === 0) {
    parts.push({ type: 'text', text: '' })
  }
  return {
    role: 'user',
    content: '',
    contents: parts,
    response_meta: blankResponseMeta(),
    reasoning_content_signature: '',
  }
}

function toolMessage(message: Record<string, unknown>, text: string): QoderIncomingMessage {
  const out = structuredMessage('tool', text)
  if (typeof message.name === 'string') out.name = message.name
  if (typeof message.tool_call_id === 'string') out.tool_call_id = message.tool_call_id
  return out
}

function assistantToolCallMessage(text: string, toolCalls: unknown[]): QoderIncomingMessage {
  const out = structuredMessage('assistant', text)
  out.tool_calls = toolCalls
  return out
}

/** 从 OpenAI 消息提取纯文本（content 字符串、contents parts、named 等）。 */
export function normalizeMessageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content as Array<Record<string, unknown>>) {
      if (typeof part === 'string') {
        parts.push(part)
      } else if (part && typeof part === 'object') {
        const t = part.text
        if (typeof t === 'string') parts.push(t)
        else if (typeof part.value === 'string') parts.push(part.value)
      }
    }
    return parts.join('')
  }
  return ''
}

/** 提取消息里的图片 URL（user 消息的 image_url parts）。 */
export function extractMessageImages(message: Record<string, unknown>): string[] {
  if (message.role !== 'user') return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const urls: string[] = []
  for (const part of content as Array<Record<string, unknown>>) {
    const iu = part.image_url as Record<string, unknown> | undefined
    if (iu && typeof iu.url === 'string') urls.push(iu.url)
  }
  return urls
}

const TOOL_CALLS_TEXT_RE = /Tool calls:\s*(\[[\s\S]*?\])/

/** 尝试从文本解析 "Tool calls: [...]" 形状的 tool_calls（兜底）。 */
export function parseToolCallsText(text: string | null | undefined): unknown[] | undefined {
  if (!text) return undefined
  const m = TOOL_CALLS_TEXT_RE.exec(text)
  if (!m?.[1]) return undefined
  try {
    const parsed = JSON.parse(m[1])
    if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object')) {
      return normalizeToolCalls(parsed)
    }
  } catch {
    return undefined
  }
  return undefined
}

function normalizeToolCalls(raw: unknown[]): unknown[] {
  return raw.map((tc) => {
    if (tc && typeof tc === 'object' && !('function' in tc)) {
      const r = tc as Record<string, unknown>
      if (r.id && r.name && r.input) {
        return { id: r.id, type: 'function', function: { name: r.name, arguments: JSON.stringify(r.input) } }
      }
    }
    return tc
  })
}

/** 检测 assistant 消息之后是否有已解析的 tool 响应（决定结构化 tool_calls 传输）。 */
function hasResolvedToolResponse(messages: Array<Record<string, unknown>>, assistantIndex: number): boolean {
  const message = messages[assistantIndex]
  if (message === undefined || message.role !== 'assistant') return false
  const tc = message.tool_calls
  if (!(Array.isArray(tc) && tc.length > 0) && !parseToolCallsText(normalizeMessageText(message))) return false
  for (let i = assistantIndex + 1; i < messages.length; i += 1) {
    const next = messages[i]
    if (next?.role === 'tool') return true
    if (next !== undefined && (next.role === 'assistant' || next.role === 'user' || next.role === 'system')) return false
  }
  return false
}

function renderToolCalls(toolCalls: unknown[]): string {
  return `Tool calls:\n${JSON.stringify(toolCalls)}`
}

function renderToolResult(message: Record<string, unknown>, text: string): string {
  const name = typeof message.name === 'string' ? message.name : ''
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
  let out = 'Tool result'
  if (name) out += ` (${name})`
  if (toolCallId) out += ` [${toolCallId}]`
  if (text.trim()) out += `:\n${text}`
  return out
}

/**
 * 把一条 OpenAI 消息转换为 Qoder 消息形状；返回 null 表示该条无法表示（跳过）。
 */
export function convertIncomingMessage(
  message: Record<string, unknown>,
  toolsEnabled: boolean,
  allowStructuredToolCalls: boolean,
): QoderIncomingMessage | null {
  const role = typeof message.role === 'string' ? message.role : 'user'
  const text = normalizeMessageText(message)

  let structuredToolCalls: unknown[] | undefined
  if (toolsEnabled && allowStructuredToolCalls) {
    const tc = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls
      : parseToolCallsText(text)
    if (tc) structuredToolCalls = tc
  }

  if (role === 'assistant' && structuredToolCalls) {
    return assistantToolCallMessage(text, structuredToolCalls)
  }

  // tool 结果：原文为 tool 角色时按 name/tool_call_id 传；否则渲染成文本。
  if (role === 'tool') {
    if (toolsEnabled) return toolMessage(message, text)
    return structuredMessage('user', renderToolResult(message, text))
  }

  // 非 tool 场景下，assistant 携带的 tool_calls 渲染进文本（不结构化）。
  let finalText = text
  if (role === 'assistant' && !toolsEnabled && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    finalText = [text, renderToolCalls(message.tool_calls)].filter(Boolean).join('\n\n')
  }

  const images = role === 'user' ? extractMessageImages(message) : []

  if (!finalText.trim() && images.length === 0) return null

  if (role === 'user') {
    // 图片作为真实 parts 传输时，去掉文本里的 "[image] <url>" 兜底占位。
    const cleaned = images.length > 0
      ? finalText.split('\n\n').filter(s => !s.trim().startsWith('[image] ')).join('\n\n')
      : finalText
    return userMessage(cleaned, images)
  }

  return structuredMessage(role, finalText)
}

/**
 * 构建发往 Qoder 网关的 messages 数组。OpenAI 形状入参 → Qoder 形状。
 */
export function buildQoderMessages(
  incoming: Array<Record<string, unknown>>,
  prompt: string,
  toolsEnabled: boolean,
): QoderIncomingMessage[] {
  const rebuilt: QoderIncomingMessage[] = []
  if (incoming.length > 0) {
    for (let i = 0; i < incoming.length; i += 1) {
      const allowStructured = toolsEnabled && hasResolvedToolResponse(incoming, i)
      const converted = convertIncomingMessage(incoming[i]!, toolsEnabled, allowStructured)
      if (converted !== null) rebuilt.push(converted)
    }
  }
  if (rebuilt.length === 0 && prompt.trim()) {
    rebuilt.push(userMessage(prompt))
  }
  return rebuilt
}

/** 取最后一条 user 消息的纯文本（供 chat_context / business.name 使用）。 */
export function extractLatestUserPrompt(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'user') {
      const text = normalizeMessageText(m)
      if (text.trim()) return text
    }
  }
  return ''
}

/** 任意 JSON 深拷贝（模板必须逐请求独立）。 */
export function deepClone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * 给「最后一条 system 消息的最后一个非空文本块」打 `cache_control: ephemeral`。
 *
 * ## 标记点为什么是 system 消息，而不是 magpie 说的「最后一个 user turn」
 *
 * magpie（`packages/qoder/index.mjs` 的 `cacheMarked`）标的是最后一个 user turn
 * 的最后一个非 thinking/tool 块。真实客户端（app.asar.unpacked 里
 * `qoder-worker-runtime.obf.mjs`）的 `BHc(A,e)` 恰好相反：
 *
 * ```js
 * function BHc(A,e){
 *   let t=A.findIndex(A=>"system"!==A.role), i=(t<0?A.length:t)-1, n=A[i];
 *   if("system"!==n?.role) return;                        // 只标 system
 *   let r=n.content.findLastIndex(A=>A.text.length>0);    // 最后一个非空文本块
 *   return r<0?void 0:{index:i, message:{role:"system",
 *     content:n.content.map((A,t)=>t===r?{...A,cacheControl:e}:A)}}
 * }
 * ```
 *
 * 即：从数组头起第一条非 system 的位置往前推一格，**只标那条 system 消息**，
 * 标它内部最后一个非空文本块；其余消息一概不动。`IHc` 负责把已有的 tool 块
 * 标记按当前开关值重写或剥掉（我们不发 tool 块级别的标记，故无需对应逻辑）。
 *
 * ## 为什么默认关闭（这是取舍，不是遗漏）
 *
 * 客户端里这个开关的值来自 `Pjc(A)`：只有**模型自己声明了**
 * `capabilities.cacheControl`（或 anthropic-compatible 适配器 + `cache.mode ===
 * "auto"`）才进 `promptCache` 表；而 `promptCache` 只有 `cde`（自定义 provider）
 * 去读，调用点是 `ZPi`，`ZPi` 的唯一调用方是自定义 provider 的 `inference`。
 *
 * 换句话说：**Qoder 内建通道根本不吃这个字段**。它的缓存是服务端按
 * `session_id` 分桶自动做的（issue #42 的实测：固定 session_id 后命中率
 * 99.8%）。对一个没声明该能力的模型硬发 `cache_control`，是在递一个它没要的
 * 字段 —— 轻则被忽略，重则被当成不认识的块类型拒掉。
 *
 * 所以这里做成显式开关：`undefined` 即原样返回，调用方按实测结论决定开不开。
 * 想验证它有没有用，用 `QoderUpstreamOptions.cacheControl` 打开做 A/B。
 *
 * ## 形状：`content` 从字符串变成 parts 数组
 *
 * 客户端标记后 `content` 就是 parts 数组（`n.content.map(...)`），未标记时字节
 * 串与数组都接受（它的 system 投影里 `1===t.length && "string"==typeof t[0]`
 * 就直出字符串）。所以我们只在**真要标记**时才把 `content` 转成数组，与客户端
 * 标记后的形状一致；不标记时一个字都不改。
 */
export function applyCacheControl(
  messages: QoderIncomingMessage[],
  cacheControl: { type: 'ephemeral'; ttl?: '1h' } | undefined,
): QoderIncomingMessage[] {
  if (cacheControl === undefined) return messages
  const firstNonSystem = messages.findIndex(m => m.role !== 'system')
  const at = (firstNonSystem < 0 ? messages.length : firstNonSystem) - 1
  const target = messages[at]
  if (target === undefined || target.role !== 'system') return messages

  // 统一成 parts 再看：字符串 content 视为单个 text part。
  const parts: QoderContentPart[] = Array.isArray(target.content)
    ? target.content
    : typeof target.content === 'string' && target.content.length > 0
      ? [{ type: 'text', text: target.content }]
      : []
  let blockAt = -1
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const text = parts[i]?.text
    if (typeof text === 'string' && text.length > 0) { blockAt = i; break }
  }
  if (blockAt < 0) return messages

  const marked = parts.map((part, i) => (i === blockAt ? { ...part, cache_control: cacheControl } : part))
  const out = messages.slice()
  out[at] = { ...target, content: marked }
  return out
}


/** 模型名 → 是否需要图像输入（is_vl）。两个入口都改：model_config 与 chat_context.extra.modelConfig。 */
export function applyModelKey(body: QoderChatTemplate, key: string, userType: string, isVl: boolean): void {
  body.model_config.key = key
  body.model_config.is_vl = isVl
  body.chat_context.extra.modelConfig.key = key
  body.aliyun_user_type = userType
}