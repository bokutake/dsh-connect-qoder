/**
 * 向 Qoder 声明的**设备身份**——`cosy-machineid` / `cosy-machinetoken` /
 * `cosy-machinetype` / `cosy-machinecode` 四个头的取值来源。
 *
 * ## 为什么需要这一层
 *
 * 改动前，聊天路径的身份是 `deriveFingerprint('', credential, installSalt)` 从
 * **PAT 摘要**派生出来的：`machineId` / `machineToken` / `machineType` 三个值全部
 * 由同一个种子算出。这在两处是错的：
 *
 * 1. **`machineId` 与 `machineToken` 在真实客户端里是两个不同来源的值。** 实测
 *    抓包（qoderclicn 1.1.94）里 `cosy-machineid` 是一个 UUID（等于
 *    `~/.qoder-cn/.auth/machine_id`），`cosy-machinetoken` 则是 88 字符的独立
 *    令牌（来自桌面客户端的 UMID 组件）。dsh 此前两个都由 **PAT 摘要**派生：
 *    取值确实不同（一个是 md5、一个是 43 字符的 sha512），但**两个都不是真实
 *    值**。pi 与 magpie 更进一步，把同一个值同时填进两个头。
 *
 * 2. **本仓库已经有真实身份的读取器，只是聊天路径没用它。**
 *    `device-risk.ts` 会执行 Qoder 桌面客户端自带的 `umid/runtime-info` 组件，
 *    拿到真实的 `machineToken` / `machineCode` / `machineType`；但它只服务签到
 *    与额度查询（`deviceRiskHeaders()`，且要求 `region.requiresDeviceRisk`）。
 *    结果是同一个账号、同一个进程对上游呈现**两套不同的设备身份** —— 这比
 *    「一律用假值」更糟，因为它自相矛盾。
 *
 * ## 三种模式
 *
 * | 模式 | `machineId` | `machineToken` / `machineCode` / `machineType` |
 * | --- | --- | --- |
 * | `derived`（旧行为） | PAT 派生 | PAT 派生 |
 * | `real`（默认） | 本机 `machine_id` 文件，缺失则派生 | UMID 组件，缺失则派生 |
 * | `manual` | 用户填 | 用户填，缺失项各自派生 |
 *
 * `real` 是默认值，因为它是**唯一与官方客户端一致**的取值；它不会让插件比现状
 * 更「像机器人」—— 恰恰相反，它让插件不再声称一个凭据哈希。
 *
 * 降级必须**显式记录**：`readDeviceRisk` 在组件缺失、超时、输出不成形时抛错，
 * 这里接住它并退回派生值，同时把原因写进日志。静默降级会让「为什么我的身份
 * 和签到路径不一样」变成一个查不出来的问题。
 *
 * @module dsh-connect-qoder/device-identity
 */

import { readFile } from 'node:fs/promises'
import { homedir, hostname as hostnameOf } from 'node:os'
import { join } from 'node:path'
import { deriveFingerprint, type CosyFingerprint } from './cosy.ts'
import { readDeviceRisk } from './device-risk.ts'
import type { QoderRegion } from './upstream.ts'

/** 设备身份的来源模式。 */
export type DeviceIdentityMode = 'real' | 'derived' | 'manual'

/**
 * 一个字段的来源。
 *
 * `fallback` = 真实来源取不到，退回了凭据派生值。其余三种就是
 * {@link DeviceIdentityMode} 的那三种。
 */
export type DeviceIdentitySource = DeviceIdentityMode | 'fallback'

/**
 * 一次决策完整的设备身份，以及**逐字段的来源**。
 *
 * 来源字段故意不叫 `machineId` / `machineToken` 这些名字：那是协议里的字段名，
 * 而 `tests/privacy.spec.ts` 有一条规则专门盯「这些字段名后面跟一个看起来像真实
 * 取值的字符串」。`origin` 里出现的 `'real'` / `'fallback'` 不是设备标识，但用
 * 同名字段承载枚举值会让那条规则误报 —— 改字段名比放宽隐私规则更适合。
 */
export interface QoderDeviceIdentity {
  machineId: string
  machineToken: string
  machineType: string
  machineCode: string
  /** 每个字段的来源，供日志与诊断展示（不是协议字段）。 */
  origin: Record<'id' | 'token' | 'type' | 'code', DeviceIdentitySource>
}

/** 人工填写的覆盖值。任何一个字段缺席都退回该字段的默认来源。 */
export interface QoderIdentityOverride {
  machineId?: string
  machineToken?: string
  machineType?: string
  machineCode?: string
}

/**
 * 各区域 `machine_id` 文件的位置。
 *
 * 与官方 CLI 的配置根一致（`~/.qoder-cn` 国内版、`~/.qoder` 国际版）。这个文件
 * 是 CLI 登录时写入的，**不是**我们从凭据派生的东西——读它才是「本机真实身份」。
 */
const MACHINE_ID_PATHS: Readonly<Record<QoderRegion, readonly string[]>> = {
  cn: [join('.qoder-cn', '.auth', 'machine_id'), join('.qoder', '.auth', 'machine_id')],
  global: [join('.qoder', '.auth', 'machine_id'), join('.qoder-cn', '.auth', 'machine_id')],
}

/** 跑一次完整的身份解析。 */
export interface ResolveIdentityOptions {
  region: QoderRegion
  /** 交换 jobToken 用的凭证（派生的种子）。 */
  credential: string
  mode?: DeviceIdentityMode
  override?: QoderIdentityOverride
  /** 本机指纹盐（混入派生种子）。 */
  installSalt?: string
  /** 日志。降级原因必须经它说出来。 */
  log?: (message: string) => void
  /** 注入点（测试用）：读 `machine_id` 文件。 */
  readMachineIdFile?: (path: string) => Promise<string | undefined>
  /** 注入点（测试用）：读 UMID 三件套。 */
  readRisk?: (region: QoderRegion) => Promise<{ machineToken: string; machineCode: string; machineType: string }>
  home?: string
}

/** 一个值看起来像不像一个可用的标识（非空、不含空白、长度合理）。 */
function usable(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 4096 && !/\s/.test(value.trim())
}

/**
 * `machineId` 的校验：真实值是 UUID 形状，但**不强制**要求 UUID —— 见过 32 位
 * 无横线的写法。只挡明显不可能的东西（空、空白、超长）。
 */
function usableMachineId(value: unknown): value is string {
  return usable(value) && value.trim().length >= 8
}

/** 读本机的 `machine_id` 文件；没有/读不动都返回 `undefined`（不抛）。 */
async function defaultReadMachineIdFile(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, 'utf8')).trim()
    return usableMachineId(text) ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析本区域的 `machineId`：按候选顺序找第一个能读到的文件。
 *
 * 校验放在这里而不是只在默认读取器里：`readFileImpl` 是公开注入点，注进来的
 * 实现没义务（也没能力）知道「什么算可用」。公共入口自己收口，两种调用路径
 * 才会得到同一个判据。
 *
 * 找不到就返回 `undefined`，由调用方退回派生值 —— 这是**唯一**允许的降级方向：
 * 宁可发一个凭据哈希，也不发一个空字符串（空值会被当成缺字段，比错值更显眼）。
 */
export async function readLocalMachineId(
  region: QoderRegion,
  options: { home?: string; readFileImpl?: (path: string) => Promise<string | undefined> } = {},
): Promise<string | undefined> {
  const home = options.home ?? homedir()
  const read = options.readFileImpl ?? defaultReadMachineIdFile
  for (const relative of MACHINE_ID_PATHS[region]) {
    let found: string | undefined
    try {
      found = await read(join(home, relative))
    } catch {
      // 注入的读取器抛错不该让整条身份解析挂掉 —— 换下一个候选。
      continue
    }
    if (usableMachineId(found)) return found.trim()
  }
  return undefined
}

/**
 * 解析一次请求要用的设备身份。
 *
 * **永不抛。** 任何一路失败都退回派生值，并把原因写进 `log`。
 */
export async function resolveDeviceIdentity(options: ResolveIdentityOptions): Promise<QoderDeviceIdentity> {
  const mode = options.mode ?? 'real'
  const fallback: CosyFingerprint = deriveFingerprint('', options.credential, options.installSalt)
  const log = options.log ?? (() => {})
  const override = options.override ?? {}

  const identity: QoderDeviceIdentity = {
    machineId: fallback.machineId,
    machineToken: fallback.machineToken,
    machineType: fallback.machineType,
    machineCode: '',
    origin: { id: 'fallback', token: 'fallback', type: 'fallback', code: 'fallback' },
  }

  if (mode === 'manual') {
    // 人工覆盖优先于一切：它是显式配置，不该被自动发现覆盖。
    if (usableMachineId(override.machineId)) {
      identity.machineId = override.machineId.trim()
      identity.origin.id = 'manual'
    }
    if (usable(override.machineToken)) {
      identity.machineToken = override.machineToken.trim()
      identity.origin.token = 'manual'
    }
    if (usable(override.machineType)) {
      identity.machineType = override.machineType.trim()
      identity.origin.type = 'manual'
    }
    if (usable(override.machineCode)) {
      identity.machineCode = override.machineCode.trim()
      identity.origin.code = 'manual'
    }
    return identity
  }

  // `real` 与 `derived` 都允许 `machineId` 从本机文件读（那是真实值）；
  // 差别在于 `derived` 只读文件，不动 UMID 三件套。
  const localId = await readLocalMachineId(options.region, {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.readMachineIdFile === undefined ? {} : { readFileImpl: options.readMachineIdFile }),
  })
  if (localId !== undefined) {
    identity.machineId = localId
    // `derived` 模式下这个文件仍然比凭据哈希更接近真实，所以照用。
    identity.origin.id = mode === 'real' ? 'real' : 'derived'
  } else if (mode === 'real') {
    log('本机没有 machine_id 文件（CLI 未登录过？），machineId 退回凭据派生值')
  }

  if (mode === 'derived') return identity

  const read = options.readRisk ?? readDeviceRisk
  let risk: { machineToken: string; machineCode: string; machineType: string } | undefined
  try {
    risk = await read(options.region)
  } catch (error: unknown) {
    // 组件缺失是**正常情况**（很多人没装桌面客户端），所以这里不刷错误级别。
    log(
      `读不到本机设备三件套，machineToken/type/code 退回凭据派生值：`
      + `${String((error as Error)?.message ?? error)}`,
    )
  }
  if (risk !== undefined) {
    if (usable(risk.machineToken)) {
      identity.machineToken = risk.machineToken
      identity.origin.token = 'real'
    }
    if (usable(risk.machineType)) {
      identity.machineType = risk.machineType
      identity.origin.type = 'real'
    }
    if (usable(risk.machineCode)) {
      identity.machineCode = risk.machineCode
      identity.origin.code = 'real'
    }
  }
  return identity
}

/**
 * 把一次解析结果渲染成设备身份请求头。
 *
 * 除了那四件套，还补上官方 CLI 每次都带的两个**环境**头：
 *
 * - `cosy-machineos` —— 抓包实测是 `x86_64_win32`（架构_平台，小写）；
 * - `cosy-machinehostname` —— 主机名。
 *
 * 这两个此前完全没发。它们不是身份令牌，但它们是**同一组一致性声明**的一部分：
 * 声称了 `machineid` 却不说明跑在什么系统上，本身就是一条可筛的差异。
 * `machineCode` 为空时整个头不发 —— 空串与「没有这个字段」在上游看来是两件事。
 */
export function identityHeaders(
  identity: QoderDeviceIdentity,
  env: { os?: string, hostname?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'cosy-machineid': identity.machineId,
    'cosy-machinetoken': identity.machineToken,
    'cosy-machinetype': identity.machineType,
  }
  if (identity.machineCode !== '') headers['cosy-machinecode'] = identity.machineCode
  if (env.os !== undefined && env.os !== '') headers['cosy-machineos'] = env.os
  if (env.hostname !== undefined && env.hostname !== '') headers['cosy-machinehostname'] = env.hostname
  return headers
}

/**
 * 本机的 `cosy-machineos` / `cosy-machinehostname` 取值。
 *
 * 格式照抓包：`${arch}_${platform}`，平台名用 **Node 的** `process.platform`
 * （`win32` / `darwin` / `linux`）—— 实测 CLI 在 Windows 上发的正是
 * `x86_64_win32`，与 Node 的说法一致（不是 `windows`、也不是 `win64`）。
 *
 * 架构名做一次归一：Node 的 `x64` 在客户端那边写作 `x86_64`。
 */
export function localMachineEnv(): { os: string, hostname: string } {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  let hostname = ''
  try {
    hostname = hostnameOf()
  } catch {
    // 主机名拿不到就不发这个头，不是错误。
  }
  return { os: `${arch}_${process.platform}`, hostname }
}
