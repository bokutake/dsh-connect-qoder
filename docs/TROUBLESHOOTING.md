# 排障（Troubleshooting）

> 这份文档收的是「出了某条错误，接下来该做什么」。**插件的定位**、安装与配置在
> [`README.md`](../README.md)；设计取舍与取证过程在 [`DESIGN.md`](DESIGN.md)；
> 版本变更在 [`CHANGELOG.md`](../CHANGELOG.md)。

## 先分清两种失败：**这一次请求**的，还是**这个账号 / 上游**的

这决定了你接下来该做什么，而这个仓库踩过最多的坑就是把它弄反：

| 你在界面上看到 | 它其实是什么 | 该做什么 |
| --- | --- | --- |
| `401` / `invalid_api_key` | PAT 被上游拒了（业务码 `105`） | 换 PAT，或到「设置 → Qoder」核对该区域的 PAT |
| `429` / `quota_exceeded` | 额度用完（业务码 `110`/`113`/`144`/`147` 等配额族） | 充值或换模型；**换 PAT 无效** |
| `429` / `rate_limit_exceeded` | 限流（HTTP 429 短窗） | 等一会儿，会自动恢复 |
| `400` / `content_policy_rejected` | 内容审核拒绝 | 改输入；**换账号无效** |
| `502` / `upstream_error` | 上游瞬时故障，或**内容拒绝**（见下一节） | 先看下一节 |

## 一、`403 + 10605 / RESOURCE_LIMIT` 也可能是**内容**拒绝，不是限流（issue #2）

### 现象

对话完全发不出去，日志或界面里的信封长这样：

```
HTTP 403 {"code":"10605","message":"{\"isQueued\":true,\"queueCount\":0,\"queueType\":\"p2\",
  \"retryAfterSeconds\":30,\"serviceAvailable\":false,\"subCode\":\"RESOURCE_LIMIT\"}"}
```

换 PAT、换账号、等冷却、清限流窗口**全部无效**。而把 prompt 里某个可疑的整句改掉就正常了。

### 已知触发点

DSH 默认的 system prompt 里，`harness:identity` 段那一整句（`includeHarnessIdentity` 默认开启）：

```
You are an AI agent powered by DeepSeek Harness.
```

**本机实测（2026-11，3 轮共 10 次真实请求，模型 `dfmodel`）**：

| system 内容 | 结果 |
| --- | --- |
| `You are an AI agent powered by DeepSeek Harness.` | **403 / 10605 / `serviceAvailable:false`（3/3 复现）** |
| 只把 `agent` 改成 `assistant` | 正常返回 |
| **完全不带 system 消息** | 正常返回 |
| 30 000 字符的 `z` 填充 | 正常返回 |

拆词全过、整句才挂，`DeepSeek Harness` 单独出现也能过 —— 这更像**精确整句指纹**（针对已知 agent 模板），而不是泛化的内容审核。

### 为什么插件不替你处理

**因为这两件事共用一个信封，字段层面无法区分。** 本仓库 issue #29 的现场是真宕机，它的信封与本条**逐字相同**：

```
{"isQueued":true,"queueCount":0,"queueType":"p3","retryAfterSeconds":30,
 "serviceAvailable":false,"subCode":"RESOURCE_LIMIT"}
```

#29 那次的证据是「插件自己的探针在 14 个模型上全部失败」。而探针**不带 system 消息** —— 所以探针失败意味着上游真的整体不可用。

如果把 `10605` 一律改判成内容策略，真限流 / 真宕机就会变成「不记账号、不冷却、不换号」，于是每个请求都去撞同一堵墙且不退避。**改写所有请求的 system prompt 也不在插件职责内** —— 它会影响你的每一个会话。

### 怎么判断是这一条

- 失败的**是每一个会话**，不是偶发，也不是某个模型特有；
- 用**不带 system 消息**的请求能过（插件的探针就是这种形状：账号池的「测试」/「一键测试所有账号」走的正是它）；
- 关掉 `includeHarnessIdentity` 之后立刻正常。

> ⚠️ **「换个新会话试试」不是有效判别** —— 那句话在**每一个** DSH 会话里都会被注入，换会话照样失败。

### workaround

在 profile 的 `cordis.patch.yml` 里关掉那一句，并用 `personaPrefix` 补一句你自己的身份描述，然后**重启该 profile 的宿主进程**：

```yaml
- id: system-prompt
  name: "@deepseek-ai/dsh-system-prompt"
  config:
    includeHarnessIdentity: false
    personaPrefix: "You are a helpful software engineer assistant."
```

`id: system-prompt` 是宿主自己的 entry id；DSH 自带的 `dsh-sdk-minimal` bundle 用的就是这套写法，可以直接对照。

### 为什么不提供「把 identity 改成另一句」的插件配置项

`harness:identity` 的文本**没有**对外暴露的配置，只有开 / 关（`includeHarnessIdentity`）。在**全局层**注册同名 section 会被宿主拒绝：

```
prompt section "harness:identity" is already registered
  (for a per-agent override, register through that agent's `agent.ctx` instead)
```

只有**每 agent 的 scope**（agent preset / 子代理）才能覆盖同名槽位。`personaPrefix` 是官方提供的、可自由填写的那一格 —— 所以能做的是「关掉 + 补一句」，不是「原地改写」。

## 二、`401` / 「API 密钥无效」但 PAT 其实是好的

上游对**配额族**（当日用量、专属积分包用完等）回的是 HTTP 403。业务码没进码表时，插件只能按状态码猜成「凭据被拒」，宿主就显示成「API 密钥无效」——而真正该做的是充值或换模型。这类码已逐个补进码表（`110`/`112`/`113`/`144`/`147` 等）。

若你仍看到这种情况，请把「诊断」栏里上游错误的**原文**连同 `modelKey` 一起贴进 issue —— 业务码就在那串里。

## 三、`NO_ADAPTER`

该会话此前选中的模型属于一个**已被你关闭**的供应商。「设置 → Qoder」里把那个区域重新勾上，或在模型选择器里换一个可用模型。关闭供应商会把它从选择器里**彻底撤掉**（不是只藏起 tab），但 PAT、用量与勾选都保留着。

## 四、CLI 报 `Cannot find package '@deepseek-ai/dsh-atomic-write'`

独立 CLI 依赖宿主提供的 peer 包。pnpm 通常会把它们装进 profile 的依赖树；装不上时就是这个报错。**provider 注册、设置页与对话都不受影响**（它们在宿主进程内）。绕开方式：改用 `dsh-connect-qoder` 在宿主内的路径，或检查 pnpm 的 `auto-install-peers` 配置。

## 五、排队很慢，或者「上游整体不可用」

同一个 `isQueued: true` 有两种形态，处置完全不同：

| 上游字段 | 含义 | 该做什么 |
| --- | --- | --- |
| `isQueued:true` + `serviceAvailable:true` | 服务是好的，你排在队里 | 等；或换账号（有效） |
| `isQueued:true` + `serviceAvailable:false` | 上游**整体**在拒服务（`queueCount` 常为 0） | 等；**换账号、换 PAT 都无效** |

插件在 `queueWaitMs` 以内会自己等掉上游申报的时长（重试预算管不到这件事，原因见 README 的「重试预算」一节）。

## 六、Qoder 计费控制台里没有逐模型消费行

1.28.0 修了两处根因：`business` 记录改为**一条用户输入一条记录**，并补上每轮结束的 `business/finish` 闭合。修复后本机实测控制台能出现逐模型消费行。

**仍未验证的边界**：`Billing daily count exceeded` 这条报错是否还会出现。当日计数器不对外暴露，也没把额度跑到上限，所以**这一条没有实测结论** —— 不要把它当成「已修好」。
