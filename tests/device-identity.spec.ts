/**
 * 设备身份三档来源的测试。
 *
 * 钉三件事：
 * 1. `real` 真的把 `machineId`（本机文件）与 `machineToken`（UMID 组件）**分开**
 *    取 —— 这是本次修正的核心，此前两者都是凭据派生值；
 * 2. 任何一路失败都**降级而不是抛**，且降级原因必须能被日志看见；
 * 3. `manual` 只在显式选择时生效，且空字段各自退回默认来源。
 */
import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import {
  identityHeaders,
  readLocalMachineId,
  resolveDeviceIdentity,
} from '../src/device-identity.ts'

const CRED = 'pat-0123456789abcdef'

/**
 * 「本机 home 目录」的测试替身。
 *
 * 不写成常见的示例路径字面量：`tests/privacy.spec.ts` 有一条规则禁止仓库里出现
 * 本机绝对路径（那条规则的理由是防真实用户名外泄，而一个假的绝对路径同样会把
 * 它的形状教给后来者）。这里直接取真实 `homedir()`，再在下面拼子目录 ——
 * 既不引入字面量，也让被测代码走它真实的路径拼接逻辑。
 */
const FAKE_HOME = homedir()

/** 造一个「读 machine_id 文件」的注入：只有给定后缀有值。 */
function fileReader(contents: Record<string, string>) {
  return async (path: string): Promise<string | undefined> => {
    for (const [suffix, value] of Object.entries(contents)) {
      if (path.replace(/\\/g, '/').endsWith(suffix)) return value
    }
    return undefined
  }
}

describe('readLocalMachineId', () => {
  it('按区域的候选顺序找到第一个可用文件', async () => {
    const found = await readLocalMachineId('cn', {
      home: FAKE_HOME,
      readFileImpl: fileReader({ '.qoder-cn/.auth/machine_id': 'machine-id-cn' }),
    })
    expect(found).toBe('machine-id-cn')
  })

  it('文件内容不成形（空/超短/带空白）读作没找到', async () => {
    for (const bad of ['', '   ', 'abc', 'has space here']) {
      const found = await readLocalMachineId('cn', {
        home: FAKE_HOME,
        readFileImpl: fileReader({ '.qoder-cn/.auth/machine_id': bad }),
      })
      expect(found).toBeUndefined()
    }
  })

  it('一个都读不到时返回 undefined（不抛）', async () => {
    await expect(readLocalMachineId('cn', { home: FAKE_HOME, readFileImpl: fileReader({}) }))
      .resolves.toBeUndefined()
  })

  it('注入的读取器抛错也不影响整体（换下一个候选）', async () => {
    let calls = 0
    const found = await readLocalMachineId('cn', {
      home: FAKE_HOME,
      readFileImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error('EACCES')
        return undefined
      },
    })
    expect(found).toBeUndefined()
    // 第一个候选抛错之后仍要继续试第二个。
    expect(calls).toBe(2)
  })
})

describe('resolveDeviceIdentity', () => {
  it('real 模式下 machineId 与 machineToken 来自**不同**来源', async () => {
    const identity = await resolveDeviceIdentity({
      region: 'cn',
      credential: CRED,
      mode: 'real',
      home: FAKE_HOME,
      readMachineIdFile: fileReader({ '.qoder-cn/.auth/machine_id': 'machine-id-from-file' }),
      readRisk: async () => ({
        machineToken: 'TOKEN-FROM-UMID',
        machineCode: 'CODE1234',
        machineType: 'TYPE5678',
      }),
    })
    expect(identity.machineId).toBe('machine-id-from-file')
    expect(identity.machineToken).toBe('TOKEN-FROM-UMID')
    // 这一条是本次修正的核心：两个头不再是同一个种子派生的产物。
    expect(identity.machineToken).not.toBe(identity.machineId)
    expect(identity.machineCode).toBe('CODE1234')
    expect(identity.machineType).toBe('TYPE5678')
    expect(identity.origin).toEqual({ id: 'real', token: 'real', type: 'real', code: 'real' })
  })

  it('UMID 组件缺失时逐字段退回派生值，并把原因写进日志', async () => {
    const messages: string[] = []
    const identity = await resolveDeviceIdentity({
      region: 'cn',
      credential: CRED,
      mode: 'real',
      home: FAKE_HOME,
      readMachineIdFile: fileReader({ '.qoder-cn/.auth/machine_id': 'machine-id-from-file' }),
      readRisk: async () => {
        throw new Error('未找到 Qoder 设备风控组件')
      },
      log: message => messages.push(message),
    })
    // machineId 仍然来自文件（那一路没失败）。
    expect(identity.machineId).toBe('machine-id-from-file')
    expect(identity.origin.id).toBe('real')
    // 三件套退回派生值。
    expect(identity.origin.token).toBe('fallback')
    expect(identity.origin.type).toBe('fallback')
    expect(identity.machineToken.length).toBeGreaterThan(0)
    // 降级必须可见 —— 静默降级会让「为什么身份和签到路径不一样」查不出来。
    expect(messages.join('\n')).toContain('未找到 Qoder 设备风控组件')
  })

  it('连 machine_id 文件也没有时，machineId 也退回派生值', async () => {
    const messages: string[] = []
    const identity = await resolveDeviceIdentity({
      region: 'cn',
      credential: CRED,
      mode: 'real',
      home: FAKE_HOME,
      readMachineIdFile: fileReader({}),
      readRisk: async () => {
        throw new Error('nope')
      },
      log: message => messages.push(message),
    })
    expect(identity.origin.id).toBe('fallback')
    expect(identity.machineId.length).toBeGreaterThan(0)
    expect(messages.join('\n')).toContain('machine_id')
  })

  it('derived 模式完全不碰 UMID，且 machineId/machineToken 都是派生值', async () => {
    let riskCalled = false
    const identity = await resolveDeviceIdentity({
      region: 'cn',
      credential: CRED,
      mode: 'derived',
      readRisk: async () => {
        riskCalled = true
        return { machineToken: 'X', machineCode: 'Y', machineType: 'Z' }
      },
    })
    expect(riskCalled).toBe(false)
    // 1.27.x 的旧行为：两个头都由同一个种子派生（但**取值不同** ——
    // machineId 是 md5，machineToken 是 43 字符的 sha512 base64url 截断）。
    // 「同一个值填两个头」的是 pi 与 magpie 的实现，不是本仓库的旧行为；
    // 本仓库的错处在于两个值都**不是真的**，而不在于它们相同。
    expect(identity.machineId).toMatch(/^[0-9a-f]{32}$/)
    expect(identity.machineToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(identity.machineToken).not.toBe(identity.machineId)
    expect(identity.origin).toEqual({ id: 'fallback', token: 'fallback', type: 'fallback', code: 'fallback' })
    // machineCode 没有派生来源，只能是空串。
    expect(identity.machineCode).toBe('')
  })

  it('manual 模式用填进来的值，空字段各自退回默认来源', async () => {
    const identity = await resolveDeviceIdentity({
      region: 'cn',
      credential: CRED,
      mode: 'manual',
      home: FAKE_HOME,
      readMachineIdFile: fileReader({ '.qoder-cn/.auth/machine_id': 'file-id' }),
      readRisk: async () => ({
        machineToken: 'IGNORED',
        machineCode: 'IGNORED',
        machineType: 'IGNORED',
      }),
      override: { machineId: 'manual-id', machineToken: 'manual-token' },
    })
    expect(identity.machineId).toBe('manual-id')
    expect(identity.machineToken).toBe('manual-token')
    // 没填的字段：manual 模式**不**去读 UMID（那是 real 的事），退回派生值。
    expect(identity.machineType).not.toBe('IGNORED')
    expect(identity.origin.type).toBe('fallback')
    expect(identity.machineCode).toBe('')
  })

  it('manual 模式下明显不成形的覆盖值被忽略', async () => {
    const identity = await resolveDeviceIdentity({
      region: 'cn',
      credential: CRED,
      mode: 'manual',
      override: { machineId: 'ab', machineToken: 'has space' },
    })
    // 太短 / 含空白 → 都不接受，各自退回派生值。
    expect(identity.origin.id).toBe('fallback')
    expect(identity.origin.token).toBe('fallback')
  })
})

describe('identityHeaders', () => {
  it('machineCode 为空时整个头都不发（空串与缺席是两件事）', () => {
    const headers = identityHeaders({
      machineId: 'mid',
      machineToken: 'mtok',
      machineType: 'mtype',
      machineCode: '',
      origin: { id: 'real', token: 'real', type: 'real', code: 'fallback' },
    })
    expect(headers['cosy-machineid']).toBe('mid')
    expect(headers['cosy-machinetoken']).toBe('mtok')
    expect(headers['cosy-machinetype']).toBe('mtype')
    expect('cosy-machinecode' in headers).toBe(false)
  })
})
