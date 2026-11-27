<p align="center">
  <img src="docs/assets/dsh-connect-qoder-usage-card.png" width="640" alt="dsh-connect-qoder 设置页：国内版 / 国际版两个 tab，账号池、积分、一键签到与自动换号" />

  <img src="docs/assets/dsh-connect-qoder-settings-page.png" width="640" alt="设置 → Qoder 页：标题、三条核心用途、活动瓦片，以及账号池（每账号一行身份 + 一行原因）" />
</p>

<h1 align="center">dsh-connect-qoder</h1>

<p align="center"><b>把 Qoder（通义灵码国内版 / 国际版）的模型接入 DeepSeek Harness，并提供账号池、每日签到、积分读数与模型管理。</b></p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#安装">安装</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="#配置">配置</a> ·
  <a href="#账号池">账号池</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="https://github.com/bokutake/dsh-connect-qoder/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/%40bokutake%2Fdsh-connect-qoder"><img src="https://img.shields.io/npm/v/%40bokutake%2Fdsh-connect-qoder?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/%40bokutake%2Fdsh-connect-qoder"><img src="https://img.shields.io/npm/d18m/%40bokutake%2Fdsh-connect-qoder?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/bokutake/dsh-connect-qoder/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/bokutake/dsh-connect-qoder/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/bokutake/dsh-connect-qoder?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/bokutake/dsh-connect-qoder/stargazers"><img src="https://img.shields.io/github/stars/bokutake/dsh-connect-qoder?style=flat-square" alt="GitHub stars"></a>
</p>

一个独立的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle 插件。它把 Qoder 账号的模型接到 DSH 的模型选择器，同时提供模型管理与只读的用量概览。**国内版与国际版是两个并行的供应商（`qoder` / `qoder-global`），可同时使用**；插件的设置页以 tab 区分两者，方便统一管理。

## 关于本仓库（独立维护的分叉）

本仓库是 [`dingminhua/dsh-connect-qoder`](https://github.com/dingminhua/dsh-connect-qoder) 的**独立分叉**。上游已在 [issue #49](https://github.com/dingminhua/dsh-connect-qoder/issues/49) 公告停止维护，理由是 Qoder 官方取消了免费用户的每日签到积分。

继续维护的起因是另一个与本插件核心用途无关的问题：上游在**计费记账**（`business` 记录的粒度与轮次闭合）和**设备身份**（`machineId` / `machineToken` 的取值来源）两侧有缺陷，导致 Qoder 计费控制台里一条逐模型消费行都没有。详见 [`CHANGELOG.md`](CHANGELOG.md) 的 `1.28.0` 一节；修改授权与范围见 [`LICENSE-MODIFICATIONS.md`](LICENSE-MODIFICATIONS.md)。

**维护方式**：按 best-effort 进行，主要用于支持作者自己的日常使用。**欢迎** issue 与 PR，但**不承诺**维护 SLA、响应时限或功能路线图。若你在找有明确排期的方案，这里可能不是最优选择。

> Qoder 官方不提供 OpenAI 兼容端点（其官方 SDK 只是 agent 启动器），因此本插件直连 Qoder 的 cosy 网关、实现了协议的最小客户端。**不需要在 Qoder 桌面端登录**，只需一个 PAT（Personal Access Token）。

## 功能特性

- **双供应商并行接入（国内版 + 国际版）** —— 国内版注册为 `qoder`（`gateway.qoder.com.cn`），国际版为 `qoder-global`（`api1.qoder.sh`）。**配了 PAT 的区域才出现在模型选择器里**；两个区域都配好就能同时使用、不同会话各选一边。没有 PAT 的区域不列出任何模型（列出来只会点到就失败）。模型名内嵌上游倍率，如 `Qwen3.8-Flash · x0.00`。

  <img src="docs/assets/dsh-connect-qoder-model-picker.png" width="360" alt="DSH 模型选择器：Qoder 与 Qoder Global 两个分组，模型名带积分倍率" />
- **独立的设置页（设置 → Qoder）** —— 与「账号与余额 / 通用设置 / 模型 / 插件」并列的一页。顶部「国内版 / 国际版」两个 tab，各含独立的 PAT、模型与用量；正文按「账号 / 模型 / 诊断」分栏，**切栏不重新拉取、不丢未保存的草稿**。诊断栏是只读事实表（上游域名、服务账号、凭据来源、目录模型数、最近一次上游错误原文），存在的唯一理由是被整段贴进问题反馈。
- **可单独关闭任一版本** —— 取消勾选会把该供应商从模型选择器里**彻底撤掉**（路由与目录条目一并摘除），PAT、用量与勾选全部保留，重新勾选即完整恢复。注意：此前选中的会话再调用会报 `NO_ADAPTER`。
- **模型管理** —— 从上游刷新完整目录、逐项勾选；每行显示倍率、上下文/输出上限、思考档位与免费标记，带「图片」「可关闭思考」开关、「测试」按钮与上下文档位选择器。**目录里有几个模型就排几行**（列表自己不设高度上限）。上游的 `auto` 是路由不是模型，不列出；`Fast` / `Ultimate` / `Efficient` 同理（只有抽象形容词）；`Sonus` / `Cantus` 照常列出（产品名，也是全目录最贵两条，issue #37）；只在国际版下发的两条**不会**出现在国内版面前。逐项取证见 [`docs/DESIGN.md`](docs/DESIGN.md)。

  <img src="docs/assets/dsh-connect-qoder-model-management.png" width="640" alt="模型管理区：逐模型显示倍率、最大上下文/输出、思考强度档位，以及图片/可关闭思考/上下文档位与测试按钮" />
- **活动优惠徽标** —— 上游在目录里自带活动规则（文案、时段、时区），模型行按**渲染时刻**画一枚胶囊（如「错峰 4 折」）；文案原样来自上游，不翻译也不改写。同一枚徽标也出现在宿主的选择器里（走 `LlmModelInfo.badge`，上限 16 grapheme，超了整枚不画）。判定规则见 [`docs/PROMO_BADGE.md`](docs/PROMO_BADGE.md)。

<img src="docs/assets/dsh-connect-qoder-promo-badge.png" width="640" alt="模型管理区：两行模型在倍率之后各有一枚蓝色胶囊，文案分别是上游自己写的「错峰 4 折」与「错峰4折」" />
- **每日签到（手动 / 自动）** —— 官方每日签到：个人用户每天可领 100 Credits，30 天有效。账号池提供「一键签到所有账号」，逐账号领取、已领过的按幂等处理。可选的「每天自动签到」由 `regions.<region>.pool.autoCheckin` 控制、**默认关闭**：判据与手动按钮逐字相同 —— **先读活动状态，已领过的只标「已领」而不发领取请求**，所以重启、重试、重复定时器都不可能领两次；按上游给的窗口时刻翻页，也就是官方那个 **10:00**（UTC+8），不是本地零点。失败按 30 秒 → 1 → 2 → 5 → 15 分钟逐级退避，之后每 30 分钟慢试一次。
- **积分与到期（只读）** —— 逐账号显示剩余积分、**积分何时作废**与**套餐何时到期**（`sash/api/v2/me/usage`，凭 `jt-` jobToken 查询，**不消耗积分**）；3 天内到期的积分高亮。**两个到期日是两件事**（issue #31）：上游的 `expiresAt` 是**账号级套餐 / 14 天试用**到期，不是任何**积分包**的到期，所以单独显示、不参与临期高亮与池排序；积分到期来自**签到批次**（`validity.days` 30 天），领到那一刻记下 `claimAtMs` 与数额并落盘到 `$DSH_HOME/.qoder-pool.<region>.json` 的 `credits`，按 FIFO 记账、**按悲观上界显示**。
- **composer 积分读数（位置可选）** —— 输入区显示 `QD CN` / `QD AI` 与**当前计费账号**的余额，点开是逐账号余额表、点一行即切换账号；受每区域「在对话框显示积分」开关控制（默认开）。位置二选一：**输入框工具栏**或**输入框下方**——前者是共享插槽，别的插件可能把读数挤到看不见，此时切到下方即可。

  <img src="docs/assets/dsh-connect-qoder-composer-credits.png" width="360" alt="对话输入框的积分面板：QD CN 逐账号余额表、设置按钮与最近刷新时间" />
- **多账号池（PAT）** —— 每区域一个本地 vault `$DSH_HOME/.qoder-accounts.<region>.json`（0600），把设置 PAT、环境变量与 vault 三源去重合并。**移出池**（在池表格取消勾选，凭据留着、随时勾回）与**删除**（抹掉 vault 里的 PAT，不可恢复）是两件事。
- **按实测排序与自动换号** —— 「一键测试所有账号」对池内每个成员发真实请求，结果落 `$DSH_HOME/.qoder-pool.<region>.json`；开启池后聊天流在首字节前按可用性 → 快过期的积分 → 积分到期最近 → 积分高 → id 选账号，失败依次换下一个。**上游报额度耗尽必显示**（与池开关无关）：命中配额族时该区域卡片出现「上游报额度耗尽」（时刻 + 业务码，悬停是脱敏原文），池关着时这是那次失败唯一可见的出口。限流（HTTP 429 短窗）**不算**耗尽。
- **思考强度与上下文预算** —— 只列上游**真实声明**的档位（Qwen 系 `low/medium/xhigh`、DeepSeek/GLM 系 `low/high/max`），选定即保存、每个请求自动带上；上下文档位同样只来自 `context_config`，未声明就不渲染控件、不编造选项。**上游声明的默认档就是选择器的默认档**。
- **诚实的模型能力** —— 上游的 `is_vl` 是**平台**的图片输入声明而非模型原生能力（几乎每条都是 `true`），所以只认一张按精确 model id 键控的核对表：核对过的才预勾选，没核实的一律不勾，并在 tooltip 里说明「为什么没勾」。2026-10-29 用「发一张画着数字 `7` 的图、问是哪个数字」实测了两个区域目录并集的**全部 14 个模型，全部读图成功**。
- **缓存命中如实上报** —— 上游 `usage` 的 `cached_tokens` 一路透传到宿主，GUI 里的缓存命中是真实比例（它是 `prompt_tokens` 的**子集**，不加进总数）；上游没报就不写，不用 0 顶替「不知道」。**同一会话的 `session_id` 保持稳定**（issue #42）：Qoder 的 prompt cache 按它分桶，此前每轮换随机值让缓存 100% 失效。
- **安全 loopback shim** —— 每区域一个随机端口 + 进程内随机 secret，**PAT 不交给 pi-ai**：pi-ai 只与本地 shim 对话，shim 用 cosy 会话（jobToken）做上游请求。
- **账号转移 / 活动瓦片 / 命令行诊断** —— 账号可导出为传输文件并按区域导入；卡片在额度读数之下是一组只读**活动瓦片**（可按区域关掉，`regions.<region>.showCampaigns`）；CLI 见[命令行诊断](#命令行诊断)。实现细节见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 工作原理

```text
DSH PiAiAdapter（每个 provider 一套）
  -> 安全 loopback shim（每区域一个随机端口 + 进程内随机 secret）
  -> QoderUpstreamClient（cosy 协议最小客户端）
  -> 国内版 https://gateway.qoder.com.cn/algo/api/v2/...
  -> 国际版 https://api1.qoder.sh/algo/api/v2/...
  -> Qoder SSE（OpenAI 形状增量）
  -> DSH 本地执行工具并回传结果
```

国内版与国际版各持一套完整的运行时栈——上游客户端、模型 catalog、回环 shim、adapter——按区域配置（网关 / openapi / 目录路径）隔离，所以**两个区域的模型可以同时可选、被不同会话使用**。

凭据是 PAT（设置页 `regions.<region>.pat` 或环境变量，见[配置](#配置)），设置项优先。每次会话按需惰性交换 **jobToken**：PAT 只在这个交换请求里使用一次，之后的对外请求全部携带 cosy bearer（自定义 Base64 载荷 + MD5 签名）与「机器指纹」会话头。**PAT 从不进入 pi-ai，也从不外发到网关之外；本插件不读不写 Qoder 桌面端的本地登录文件。**

模型的 cosy 编码与签名细节（自定义字母表、`n/3` 重排、`cosy&<SECRET>&<date>` 签名、RSA/AES 会话封装）见 `src/cosy.ts` 的头部注释；错误分类（内容审核 / 限流 / 额度耗尽 / 瞬时故障）与 DSH 重试语义的对应见 `src/upstream.ts`。

## 安装

### 从发布包安装（推荐）

```bash
dsh plugin --profile desktop add @bokutake/dsh-connect-qoder   # Desktop
dsh plugin --profile web add @bokutake/dsh-connect-qoder       # Web
```

> **从上游换装**：包名已从 `@dmh2002/dsh-connect-qoder` 改为 `@bokutake/dsh-connect-qoder`。
> 先 `dsh plugin remove @dmh2002/dsh-connect-qoder` 再装新的 —— 两个包名不同，可以并存，
> 但同时启用会让同一个 provider 注册两次。**配置不会丢**：插件在 DSH 内的标识不带作用域
> （见下面那条说明），账号池与模型勾选照旧生效。

装完**重启该 profile 的 DSH 进程**（bundle 的 host 半边在启动时加载）。也可以在 DSH 的「插件市场 / Bundles」里搜 `dsh-connect-qoder` 一键安装。

> **`dsh` 命令报 `Cannot find module .../DSH NEXT.app/...`？** 那是宿主换代留下的旧 shim：宿主 app 目录名已从 `DSH NEXT.app` 变为 `DeepSeek Harness.app`，而 `~/.local/bin/dsh` 仍指向被移除的旧路径。把 shim 改指新宿主自带的 CLI 入口即可：
>
> ```bash
> exec "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" "$@"
> ```
>
> 新入口内部以 `ELECTRON_RUN_AS_NODE` 运行 `app.asar` 里的 `dsh/lib/bin.js`，profile 仍由 `--profile` 决定。

> npm 包名带 `@bokutake/` 作用域（本仓库是独立分叉，已从上游的 `@dmh2002/` 换过来）。插件在 DSH 内的**配置标识不带作用域**——设置命名空间、`/plugins/dsh-connect-qoder/…` 路由与命令行程序名都仍是 `dsh-connect-qoder`，所以从上游换装或从 0.2.0 之前升级的用户，配置照旧生效，不用重填 PAT。设置页的寻址也不再依赖包名：它是 `settings.section`，键是**不带作用域**的 entry id。但**浏览器 bundle 的模块 id、模型选择器标签与「设置」按钮退回插件市场时用的包名**仍按带作用域的包名建，这几处由构建期从 `package.json` 注入，改包名不会漏下它们。

### 从源码构建（开发）

```bash
git clone https://github.com/bokutake/dsh-connect-qoder.git
cd dsh-connect-qoder
pnpm install
pnpm run check        # typecheck + test + build 全绿后再安装
```

以 `link:` 安装进当前 profile，改码后重启 DSH 即生效（不会重装依赖树）：

```bash
dsh plugin --profile desktop add ~/DshProject/dsh-connect-qoder
```

### 验证安装

- 打开「设置」（侧边栏那颗齿轮，或 `Cmd/Ctrl + ,`）→ 左侧导航最下方的 **Qoder** → 应看到配置页（国内版 / 国际版两个 tab）。
- 在该 profile 目录里 `pnpm exec dsh-connect-qoder doctor` 应输出两个区域的 PAT 状态与指纹派生。
- 配置 PAT 后，「从 Qoder 刷新」应拉出该区域的真实模型清单；模型选择器出现 `Qoder` / `Qoder Global` 两个分组。

## 配置

### PAT（Personal Access Token）

在 Qoder 账户设置里创建 PAT（`pt-…` 开头）。两种提供方式，**设置页优先于环境变量**：

| 区域 | 发证入口 | 设置项 | 环境变量 |
| --- | --- | --- | --- |
| 国内版（qoder.com.cn） | 控制台 → 设置 → API 令牌 | 卡片「国内版」tab → 添加 PAT | `QODERCN_PERSONAL_ACCESS_TOKEN` |
| 国际版（qoder.sh） | 控制台 → Settings → Personal Access Tokens | 卡片「国际版」tab → 添加 PAT | `QODER_PERSONAL_ACCESS_TOKEN` |

- PAT 只保存到本地插件配置（`regions.<region>.pat`），从不上传、不进入任何网络请求。
- 未配置 PAT 的区域不列出任何模型；`doctor` 命令会指出哪个区域缺 PAT。
- **逐步操作说明见 [`docs/PAT.md`](docs/PAT.md)**（含创建流程、验证机制、优先级与常见问题）。

### 区域启停

卡片每个 tab 右侧的勾选框控制该区域是否参与模型选择（opt-out：**显式取消勾选才停用**）。停用只摘除路由与目录条目，配置全部保留。

### 侧边栏面板（可选，默认关闭）

卡片「账号」栏里有一行「在侧边栏显示 Qoder」：勾上之后，DSH 侧边栏会多一个 Qoder 图标行，点开就是**这张卡片的整页版**（同样的账号池、模型目录、诊断栏，只是占满中央那一列），页头带一个「返回会话」。

- **默认关闭，且是一次显式的 opt-in**。这一行占的是 `sidebar.panellist` —— **所有插件共用的全局侧边栏座位**，点开还会接管中央面板，所以打开它是对你整个侧边栏的决定，不是对这张卡片的偏好。「插件」页本来就能看到同一张卡片，所以没主动勾过的人**升级后界面不会有任何变化**。
- **点一下即生效，不用保存**。关掉时如果整页正开着，中央那一列会自动回到对话（宿主会丢掉 `main` key 已不存在的那次选中）。
- 存为顶层配置项 `sidebarPanel`（**没有区域轴**：侧边栏只有一行、一个整页，与国内版/国际版无关）。所以某一区域签出、甚至两个区域都关掉时它仍可打开——面板本身就是你去添加第一个 PAT 的地方之一。
- 判据是 `=== true`：缺席、`false`、以及被手工改成字符串 `"true"` 的垃圾值，一律读作关闭。

### 多账号池与凭据来源

除设置 PAT 与环境变量外，每区域还有一个本地 vault（`$DSH_HOME/.qoder-accounts.<region>.json`，权限 0600）保存多个 PAT 账号。三源按 **settings → env → vault** 的优先级去重合并（同一个 PAT 只在最高优先级的来源里列出一次）。

- 卡片可新增（粘贴 `pt-…`，经 `JobToken` 交换校验并取回显示名，也可自填备注名）/ 改名 vault 账号，也可显式选择某一账号服务（`regions.<region>.accountId`，留空自动）。删除 vault 账号在池表格的行内「删除」按钮（需二次确认）；取消勾选并保存只是把它移出轮换，PAT 仍留在本地。
- 选中的凭据只用于会话的 jobToken 交换与后续 cosy 请求，从不进入 pi-ai 或页面。
- `logout [--region cn|global]` 会清除指定区域的 vault 账号与账号池测量副本（`$DSH_HOME/.qoder-accounts.<region>.json` 与 `.qoder-pool.<region>.json`）。
- 勾选成员、一键签到、一键测试与自动换号的规则见[账号池](#账号池)。

### 目录通道：`catalogChannel`（默认 `cli`）

上游按**客户端通道**决定下发哪一份模型目录。默认 `cli`，与之前完全一致；设成 `desktop` 后，插件只在 `/model/list` 这一个请求上带 `cosy-clienttype: 10`，从而多拿到只在桌面/App 通道下发的活动模型（如 HungerG）。

**聊天请求永远是 CLI 通道。** 实测 ct=10 会让上游换一套推理与截断行为（同一请求从 4 token / 0 reasoning 变成 71 / 67，连输出上限都不遵守），那不是对话该有的行为。

这些「渠道独有」的模型**不会自动勾选**，即使上游标着 `is_free: true` —— 它们在部分套餐上按普通模型计费，而插件无法在请求前判断。要用就在卡片里自己勾一次。

```yaml
regions:
  cn:
    catalogChannel: desktop   # cli（默认）| desktop
```

## 账号池

一台机器上往往有多个 Qoder 账号（多个 PAT）。**账号池**把这些账号收成一次点击：勾进池子，然后「一键签到所有账号」或「一键测试所有账号」；再打开**启用账号池**，插件就会在请求失败时自动换号接着跑。

**每个区域（国内版 / 国际版）各有独立的一池**：成员、目标模型、积分与签到状态互不影响——两边的账号本来就属于不同的供应商。**两个区域都有每日签到**：国际版的签到活动只下发给带设备风控头的请求，插件按区域读取本机 Qoder 客户端自带的设备身份组件；取不到时如实报错，不会把「拿不到设备身份」伪装成「今天没有活动」。

### 自动换号（开启账号池即生效）

- **谁来服务由排序决定**：开启后**每一次请求**都发给池内排序最靠前的可用账号，所以「当前使用」显示的是排序的结果，不一定是你手动选的那个。
- **失败时继续往下试**：某个请求在上游失败时，插件**依次**用池内其他可用账号重试，直到有一个接手、或全部不可用为止才把错误报出来。
- **哪些失败会换号**：429 限流、额度耗尽、401/403 凭据被拒、5xx 网关与网络故障——这些都是**某个账号**的状态，换一个很可能就过了。
- **哪些不会**：请求本身不合法（HTTP 400）——同一个请求体换谁都是同样的 400，重试只是让你多等几轮；**流已开始之后**也不会重放（字节已经发出去了）。
- **已知不可用的账号会被跳过**：处于限流冷却期内、或凭据已被上游拒绝的成员不参与选择。**从没测过的账号按「默认可用」参与**——刚添加的账号不该因为「还没测」就被排除。
- **手动选择从不被改写**：池子通过运行时覆盖决定「谁服务」，**不写回你保存的选择**；关掉开关，你选定的账号立刻完全生效。
- **失败会被记下来**：一次失败会写成该账号的测量（含上游报文中给出的恢复时间），下一个请求直接从可用账号开始，不必每次先撞一遍同一个限流账号。
- **换号会告诉你**：换号是插件替你做的决定，所以它会说出来——回答开头带一条引用块提示，例如 `> [dsh-connect-qoder] 「450702134816」被限流，已改用池中另一个账号回答。`。提示说的是**失败的那个账号**（你选中的那个），不点名接管者；连换多次只写一条，说的是紧邻换号的那次失败。没换号就一个字都不写。

### 这个开关到底控制什么

**它只控制「插件要不要自己决定」，不控制「你能不能操作」。**

| | 账号池 **开启** | 账号池 **关闭** |
| --- | --- | --- |
| 谁服务 | 由排序**自动**选出（可用优先 → 积分快过期 → 积分到期最近 → 积分高 → id） | **你**在设置区的「使用哪个账号」里选定 |
| 请求失败 | **自动**换下一个可用账号重试 | 不换号，如实报错 |
| 一键签到 / 一键测试 | 可用 | **仍然可用** |
| 目标测试模型 | 可改 | **仍然可改** |

最后两行是刻意的：签到与测试是**手动动作**，作用于你勾选的成员，与「插件是否自动路由」是两件事。

**唯一的硬约束**：池里一个成员都没勾选时，批量动作一律拒绝。空的池**绝不**退化成「那就对全部账号执行」——那是唯一会花掉你没授权过的积分的解读。

### 重试预算可以调（`regions.<region>.retry`）

宿主有一个「原地重试」环：值得再试的失败会等一小段时间再发一次。阶梯由插件声明、宿主执行，默认跟随宿主 —— 不填就是宿主的默认值，升级不会改变你现在的行为。

```yaml
regions:
  cn:
    retry:
      maxRetries: 4        # 最多重试几次（0 = 跟随宿主默认）
      initialDelayMs: 5000 # 首次退避毫秒（0 = 跟随宿主默认）
      maxDelayMs: 30000    # 退避上限毫秒（0 = 跟随宿主默认）
      queueWaitMs: 60000   # 排队时插件自己等的上限（0 = 关掉，默认 60000）
```

`5000 → 30000` 兼顾上游两种常见形态：瞬时限流（申报 5 秒）与 `queueType:p2` 排队（约 30 秒）。**前三个 `0` 是跟随宿主默认**（留空等价于不写），而 `queueWaitMs` 的 `0` 是**关掉** —— 两者含义不同，见下节。

#### 排队时插件自己等（`queueWaitMs`，issue #29）

**重试预算管不到「上游明确要求等 30 秒」。** 宿主阶梯是递增的（5s → 10s → 20s → 30s，带抖动），前两次**一定**短于上游申报值；实测一轮 28 次重试、纯等待 296 秒，其中 11 次是在上游说「等 30 秒」之后 5 秒内就重发的。

`pi-ai` 路由没有 `providerRetryAfterMs` 通道（issue #24 已复核，`retry-after` 在该模块与底层 vendor 里都不解析），所以只能在转发层自己等：上游 `isQueued: true` 且申报值 ≤ `queueWaitMs` ⇒ 等满再重发一次（这次失败不交给宿主）；申报值超上限、或重发后仍排队 ⇒ 原样交回宿主；每个请求只等一次，等待可中断。

#### 两种「排队」要分清（issue #29）

| 上游字段 | 含义 | 插件怎么处理 |
| --- | --- | --- |
| `isQueued:true` + `serviceAvailable:true` | 服务是好的，你排在队里 | 记为**排队中**，按申报时长冷却，换号有意义 |
| `isQueued:true` + `serviceAvailable:false` | 上游**整体**在拒服务（实测 `queueCount: 0`） | 记为**上游整体不可用**，换号提示明说「不是该账号的问题」 |

前者「等一会儿 / 换个账号」有效；后者换号、**换 PAT 都没用**（现场 14 个模型同时不可用）。此前两种被压成同一句「排队中」，用户会以为自己的凭据坏了而去重配。

### 排序规则（开启账号池后决定谁服务）

1. **可用优先** —— 被测量判定为不可用（限流未到恢复时间、凭据被拒等）的排到最后；
2. **有临期积分的优先** —— 3 天内到期的先花，过期即作废（临期判定优先于下面第 3 条的用户手排顺序，见 `rankPool` 的注释）；
3. **用户手排的顺序优先**（`orderAccountIds`）—— 拖出来的顺序要真的生效，否则拖了也没用；
4. **积分到期最近 → 临期金额大 → 积分高** —— 只在有**新鲜读数**时参与（卡片轮询、批量测试或保存时读到的那份，10 分钟内有效）：请求路径**不会**为了排序去打上游，否则一页对话就变成 N 个额外请求；
5. 最后按账号 id 收尾，保证顺序是**全序**、可复现。

⚠️ **套餐到期不参与排序**（issue #31）：那个日期说的是「账号还能用多久」，与「手上的分会不会作废」是两件事。把它当临期紧急度会让一个刚过试用期的号永远排在最前面 —— 而它的分一分都不会过期。

### 两个批量动作

- **一键签到所有账号** —— 逐个账号领取当日的官方签到活动。**先查状态再领取**，已领过的直接标「已签到」而**不发写入请求**（幂等，不重复领取）；任何单个账号失败只标记该行，**不中断整批**。签到会改变余额，因此批次结束后作废该区域的积分缓存，卡片不会继续显示领取前的数字。
- **一键测试所有账号** —— 对每个成员发一次真实请求，得出「这个账号此刻能不能用这个模型」。目标模型默认由「自动」挑本区域**倍率为 0 的免费模型**（多个候选取上下文窗口最大的），你也可以显式指定——但**在免费模型出现之前测试保持关闭**，避免在你不知情的情况下花掉积分。测试走的是与模型行同一套探测，因此**有真实成本**。
  
  **「测试用模型」不受「已启用模型」影响**（issue #33）：勾选管的是 DSH 的模型选择器里列哪些模型，不是「允许测哪些」。卡片上写着哪个模型、测试就测哪个——哪怕它没有被勾进「已启用模型」，哪怕「自动」档唯一的免费模型没勾。这两份目录曾经分开过（卡片读完整目录、测试路由读裁剪过的运行时目录），结果就是按钮点了没反应：卡片写着「测试用模型 qfmodel」，点下去却是空结果。现在全插件只有一份目录。
  
  真的**解不出**目标时（目录里一个免费模型都没有，或你手选的那个已下架），接口回 `409` + 原因（`no-free-model` / `target-model-stale`），卡片会直说「没有可测的目标模型」，而不是回一句像是账号坏了的「Host 未返回该账号的结果」。

两种批量动作都**不锁住界面**：按钮自己变成「签到中… / 测试中…」，每处理完一个账号，那一行立刻落位、活动日志也**逐条**写下（时间戳是各自完成的那一刻，不是整批结束的那一秒）；其余界面照常可用。只有**保存配置**与**删除账号**会挡一道——前者在写盘、后者不可逆。

设置页的排布：顶部是**两格独立的供应商卡片**（国内版 / 国际版），每格自带边框与底色、右端有自己的开关，选中的那格描品牌色边——**一格就是一个单位**，点名字切 tab、点开关启用该供应商。再往下是「在对话框显示积分」与「显示位置」两行（整行可点，主标题下一行是说明），第三行是**可选的「在侧边栏显示 Qoder」**，然后是账号池、模型管理。这三行都是**立即生效，不需要点保存**：前两行管积分读数显不显示、显示在哪里，第三行管侧边栏那一行（以及它打开的整页）在不在。

默认**不**自动签到：签到会真实领取奖励，只在你点按钮时执行。

> 1.24.0 起这条改成了**可选**（issue #36）：模式条上的「每天自动签到」勾上之后，插件在后台替你点那一次按钮。理由是代价不对称 —— 漏一窗就是白丢一份（个人用户 100 Credits、30 天有效），连签还会断；而签到本身**不消耗任何积分**，且上游是幂等的（先读状态，`CLAIMED` 就不再发领取请求）。所以诚实的说法不是「插件该不该做这件事」，而是「用户可以决定一次，让它自己做」—— 开关就是那个决定，默认仍然是关。

### 上游没说「什么时候恢复」时，插件在做什么（issue #32）

有两件事长得很像，其实完全不同：

| | 意思 | 谁决定的 |
| --- | --- | --- |
| `retryAtMs` 有值 | 「上游说这个时刻之后可以再用」 | 上游字段、报文里的重置句，或按签到快照的当日窗口**推算** |
| `retrySource: 'unknown-cooldown'` | 「上游没说、快照也没有；我们在**按 30 分钟**自己重试」 | 插件 |

`retryAtMs` 缺席时卡片沉默，看起来像系统也不打算再试，而实际上池子每 **30 分钟**就会拿一次真实请求再撞一次。现在兜底分支写 `retrySource: 'unknown-cooldown'`，卡片说「上游未给出何时恢复 · 每 30 分钟自动重试一次」——**只写来源、不写 `retryAtMs`**，那个字段继续只放上游或推算给出的时刻。

`110`（当日用量限制）的恢复时刻来自签到行的 `endAt`。这份快照以前只在进程内，而兜底冷却恰恰只在「窗口时刻不知道」时生效 —— 于是**每次重启都让兜底必然生效**。现在窗口时刻写进 `$DSH_HOME/.qoder-pool.<region>.json` 的 `windows` 键，重启后读回（进程内优先、磁盘其次，**已经过去的时刻不采用**）。

### 自动签到按「窗口」记账，不按日历日（issue #36）

Qoder 的每日窗口是固定绝对时刻：当天 **10:00** → 次日 09:59（UTC+8）。「今天签过没有」必须按**窗口**判断 —— 照抄本地日历日会让 00:05 被当成新的一天，而 10:00 真正开窗时状态仍写着「已完成」，新窗口那一份要等到次日 00:05 才被领，晚 14 小时。窗口身份 =「(当前 − 2 小时) 的 UTC 日期」，并优先用上游给的 `endAt`。进度单独落盘到 `$DSH_HOME/.qoder-auto-checkin.<region>.json`（`0600`），不进 settings —— 否则卡片保存一次就会用几分钟前的草稿把运行状态覆盖回去。

## 命令行诊断

在**已装本插件的 profile 目录里**跑（推荐，无需全局安装）：

```bash
cd ~/.dsh/profiles/desktop
pnpm exec dsh-connect-qoder doctor    # PAT 来源 + cosy 指纹派生 + pi-ai 代际 + 心跳 + vault 计数（纯本地，不发请求）
pnpm exec dsh-connect-qoder status    # 每区域凭据来源 + 上游模型目录可达性 + 剩余积分（需 PAT）
pnpm exec dsh-connect-qoder logout --region cn   # 清除指定区域的 vault 账号与账号池测量副本
pnpm exec dsh-connect-qoder doctor --json        # 机器可读输出
```

`status` 会真实交换一次 jobToken 并拉取模型目录（随后只读查询一次用量），因此需要对应区域的环境变量或 vault PAT；`doctor` 完全离线。

> **两条实测过的注意事项**：
> 1. **别用 `node node_modules/dsh-connect-qoder/lib/bin.js` 这种裸路径**——包名带作用域，软链在 `node_modules/@bokutake/dsh-connect-qoder`（旧版是 `@dmh2002/`），写旧路径只会得到 `MODULE_NOT_FOUND`（缺的是**入口文件**，不是 peer）。
> 2. CLI 依赖宿主提供的 peer 包（`@deepseek-ai/dsh-atomic-write` / `dsh-home-paths`）。本机实测：pnpm 会随包把它们装进 profile 的依赖树，`pnpm exec` 与 npm 装的 tarball 都能跑通。但这**取决于 pnpm 版本与 `auto-install-peers` 配置**——如果在你机器上报 `Cannot find package '@deepseek-ai/dsh-atomic-write'`，那是这一层没装上；设置页与 provider **不受影响**（它们在宿主进程内，宿主自己解析这些名字）。同族 workbuddy 的 issue #47 是同一个形状，其修复方案（宿主优先、按需回落自带实现）适用于本项目，尚未移植。

## 平台支持

| 平台 | 状态 |
| --- | --- |
| macOS | ✅ 已验证（开发与 CI） |
| Windows | ✅ CI 测试通过（上游请求走标准 fetch，无平台专属路径） |
| Linux | ✅ CI 测试通过 |

## 受支持的宿主范围

| 宿主 | peer 范围 |
| --- | --- |
| DSH（`@deepseek-ai/*`） | `>=0.1.7-rc.1 <0.2.0-0 \|\| >=0.2.0-rc.1 <0.3.0-0 \|\| >=0.2.1-rc.1 <0.3.0-0 \|\| >=0.2.2-rc.1 <0.3.0-0` |
| `@earendil-works/pi-ai` | `>=0.85.0 <0.88.0 \|\| >=1.0.0 <2.0.0` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

> 范围由 `tests/dsh-line.spec.ts` 强制。DSH 至今只发预发布，而 node-semver 只对「范围里存在同元组比较符」的预发布版本放行 —— 所以每开一条新线都要补一支分支，上界必须带 `-0`（`<0.3.0` 挡不住任何东西）。
>
> 两套语义并存：npm / pnpm 走标准语义，新补丁号的 rc（下一个待补 `0.2.3-rc.1`）**仍需手工加分支**，`UNGATED_PRERELEASES` 就是那份待办表；宿主的插件兼容门禁用 `includePrerelease: true`，一支 `>=0.2.1-rc.1 <0.3.0-0` 就覆盖整条 `0.2.x` 线。pi-ai 单列一行是因为它换过主版本，详见 [`docs/DSH-0.2.1-RC1-FOLLOWUP.md`](docs/DSH-0.2.1-RC1-FOLLOWUP.md)。

**当前基线：宿主 `0.2.2-rc.5`（2026-11-19 实测）**，pi-ai `1.3.0`、cordis `4.1.0`、schemastery `3.19.0`。rc.5 那一轮**没有改动运行时代码**，peer 范围也不需要新分支。

历史逐轮逐包核查归档在 `docs/`：

- [`docs/DSH-0.2.2-RC5-FOLLOWUP.md`](docs/DSH-0.2.2-RC5-FOLLOWUP.md) —— 当前基线（跨 rc.4 / rc.5）
- [`docs/DSH-0.2.2-RC3-FOLLOWUP.md`](docs/DSH-0.2.2-RC3-FOLLOWUP.md)
- [`docs/DSH-0.2.2-RC2-FOLLOWUP.md`](docs/DSH-0.2.2-RC2-FOLLOWUP.md)
- [`docs/DSH-0.2.2-RC1-FOLLOWUP.md`](docs/DSH-0.2.2-RC1-FOLLOWUP.md) —— 那一轮**需要适配**：`ResolvedPiAiProviderProfile` 新增必填字段、pi-ai 1.3.0 的 `TranscriptContext` 品牌化、`ctx.locale.register` 签名加宽

## 已知限制

- 依赖 Qoder 的 cosy 网关与 `sash` 接口（**非官方开放 API**），上游变动后插件可能需要随之调整。协议行为参照 [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api)，本项目独立实现，不复制其源码。
- **每日签到**是 Qoder 面向**个人用户**的运营活动（企业版账号不参与），规则与额度以官方为准；国际版的签到活动要求请求带本机 Qoder 客户端的设备身份，因此**未安装 Qoder 客户端的机器上国际版签到不可用**（插件如实报错，不静默降级）。
- 图片输入与「可关闭思考」按**已核实**的清单给出：清单外的模型一律不预勾选，因此某些其实可用的模型可能需要你手动勾一次。**图片开关是白名单**——保存过一次选择后，未勾的模型就是关着的；把勾全部取消再保存，它们会保持关闭，不会被默认值重新打开。
- 模型可用性测试与批量测试**都会发出真实请求**，会消耗少量上游额度；没有「测试已勾选」这类批量按钮，批量动作只作用于你显式勾选进池的账号。
- **独立 CLI 依赖宿主提供的 peer 包**（`@deepseek-ai/dsh-atomic-write` / `dsh-home-paths`）。本机实测：pnpm 会随包把它们装进 profile 的依赖树，`pnpm exec dsh-connect-qoder …` 与 npm 装的 tarball 都跑得通；但这取决于 pnpm 版本与 `auto-install-peers` 配置，若报 `Cannot find package '@deepseek-ai/dsh-atomic-write'` 就是这一层没装上。provider 注册、设置页与对话**都不受影响**（它们在宿主进程内，宿主负责解析这些名字）。同族 workbuddy 的修复方案（宿主优先、按需回落自带实现）适用于本项目，尚未移植。
- **`403 + 10605 / RESOURCE_LIMIT` 也可能是内容拒绝，不是限流。** Qoder CN 会按**请求内容**拒绝，而它返回的信封与「上游整体不可用」逐字相同，插件侧无法区分。已知的一个触发点是 DSH 默认 system prompt 里 `harness:identity` 那一整句。排查方法与 workaround（`includeHarnessIdentity: false` + `personaPrefix`）见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。

## 安全说明

- PAT 只写入本地插件配置（或环境变量），**从不进入任何网络请求**；对外请求一律使用 cosy 会话令牌（jobToken）+ 机器指纹头。
- 本地 shim 用随机端口的 loopback 服务 + 进程内 secret 鉴权，并校验 Host / Origin / Content-Type，请求体有 64MB 上限。
- 本插件只读你显式提供的 PAT；**不读取、不修改** Qoder 桌面端的本地登录/凭据文件。
- 诊断输出（`doctor` / `status` 与卡片探测）均脱敏，不打印任何令牌样式的字符串。

## 隐私与截图

**仓库与 npm 包里不出现任何真实账号数据。** 这一条是硬约束，规则与操作细则见 [docs/PRIVACY.md](docs/PRIVACY.md)：

- README 与 `docs/` 里的截图**一律用假数据拍**：账号名是 `acct-demo`，邮箱是 `account-a@example.com`，余额是整数。**遮挡用不透明白块或直接换成假值，模糊 / 马赛克 / 半透明色块都不算脱敏**——它们保留了字符宽度与亮暗分布。
- 代码、注释、CHANGELOG 里记录「用户实拍」现象时，同样只保留现象、换掉身份。
- `tests/privacy.spec.ts` 会扫描仓库里不该出现的邮箱、上游昵称、凭据指纹、本机绝对路径与凭据本体，CI 单独跑一步。**它读不了图片内容**，所以新增或替换 `docs/assets/` 下的图仍必须自己打开看一眼实际像素。

> 这条规则是吃过教训写下的：早期版本的截图里用过真实数据，后来统一换成了假值。「已经泄露了怎么办」写在 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 Qoder 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 Qoder / 通义灵码的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与阿里巴巴、通义灵码、Qoder、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 市场收录与展示

本插件声明了 `dsh.bundle` manifest（`dsh.bundle.patch: ./cordis.patch.yml`），因此可以用 `dsh plugin add` 安装。社区市场从 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表同步；仓库内的提交草稿在 [`awesome-dsh-plugin-submission/dingminhua__dsh-connect-qoder.yml`](awesome-dsh-plugin-submission/dingminhua__dsh-connect-qoder.yml)。提交规范见该仓库的 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

市场截图与 GitHub 徽章是两套机制：**市场截图**由仓库根目录的 [`screenshots.json`](screenshots.json) 声明；**徽章**由本 README 顶部的 Shields 链接生成；**市场图标**由具体市场的规则决定，既不是 npm 字段也不是 README 徽章。

## 致谢

本项目建立在他人已公开的工作之上，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

- [**Zhengyuuuui/qoder2api**](https://github.com/Zhengyuuuui/qoder2api)：cosy 协议 wire behavior 的参照实现（编码、签名、会话、指纹、jobToken、SSE 形状、错误分类）。本项目按其行为**独立实现**为 TypeScript，不复制其源码；该仓库未附独立 LICENSE，其 README 声明源自 `wangtufly/QCCG`（GPL-3.0）。
- [**L0NE-6/Qoder-Daily**](https://github.com/L0NE-6/Qoder-Daily)（MIT）：每日签到的协议参照（`campaigns` / `claim` 形状、幂等判定、国际版设备风控思路）。本项目按其文档与本机实测行为独立实现，不复制其源码。
- [**dingminhua/dsh-connect-workbuddy**](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）：插件工程结构、卡片交互模型、loopback shim 模式与 npm 发布工程的基准。
- [**dingminhua/dsh-connect-trae**](https://github.com/dingminhua/dsh-connect-trae)（MIT）：经 workbuddy 转引的卡片外观与发布工程基准。
- [**franksong2702/dsh-codex-connect**](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）：经 workbuddy 转引的 DSH 插件结构与 pi-ai provider 注册参照。
- Qoder 官方 SDK 的类型定义：仅用于 usage/头的形状核对，不随本项目分发。

## License

MIT © LaoDing —— 详见 [LICENSE](LICENSE)。