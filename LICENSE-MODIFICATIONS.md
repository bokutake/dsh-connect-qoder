# 修改声明（Modification Notice）

MIT License

Copyright (c) 2026 bokutake <i@html.moe>

本文件声明本仓库（`bokutake/dsh-connect-qoder`）相对上游
[`dingminhua/dsh-connect-qoder`](https://github.com/dingminhua/dsh-connect-qoder)
的**修改范围**与**授权**。

## 一、上游

- **上游项目**：[`dingminhua/dsh-connect-qoder`](https://github.com/dingminhua/dsh-connect-qoder)
- **上游许可证**：MIT，`Copyright (c) 2026 LaoDing`（全文见 [`LICENSE`](LICENSE)）
- **本仓库起点**：上游 `1.27.1`（2026-11-20）之后的未发布改动 + 本仓库的后续修改
- **分叉原因**：上游已于
  [`dingminhua/dsh-connect-qoder#49`](https://github.com/dingminhua/dsh-connect-qoder/issues/49)
  公告停止维护（理由是 Qoder 官方取消免费用户的每日签到积分）。本仓库继续维护，起因是
  上游在**计费记账**与**设备身份**这两侧存在与本插件核心用途无关的缺陷，与停更公告所述的
  签到政策变更没有关系。

## 二、授权

本仓库的修改部分同样以 **MIT** 发布，全文见 [`LICENSE`](LICENSE)。

上游的版权声明**原样保留**，不因本仓库的修改而移除 —— MIT 只要求保留声明，不要求
修改者放弃署名权，也不要求修改者承担上游作者的义务。因此：

- `LICENSE` 保留 `Copyright (c) 2026 LaoDing`（上游原文，未改一字）；
- 本文件载明修改者与修改范围；
- 两者并存即满足 MIT 的「上述版权声明与许可声明应包含在软件的所有副本或实质部分中」。

## 三、修改摘要

完整记录见 [`CHANGELOG.md`](CHANGELOG.md) 的 `1.28.0` 一节。按性质分三类：

| 类别 | 内容 |
| --- | --- |
| **修复（对齐官方 CLI）** | `business` 记录按「一条用户输入一条记录」归并并补上 `business/finish` 闭合；`cosy-clienttype` `10`→`5`；`cosy-business-product` `ide`→`cli`；`user-agent` 改为 `Bun/1.4.4`；`cosy-version` 改为动态解析且与 bearer 载荷同源；设备身份改为默认取本机真实值且 `machineId` 与 `machineToken` 分开取 |
| **新增** | 区域节点发现与 inference 节点轮换；`cache_control` 标记（默认关，可配）；`src/client-version.ts`、`src/device-identity.ts`、`src/endpoints.ts` |
| **测试与文档** | 6 个新增测试文件；`tests/privacy.spec.ts` 补一条规则及其自测；`docs/issues/magpie-330-billing-count.md` |

## 四、与上游的关系

- 本仓库是**独立维护的分叉**，不是上游的官方延续，也不代表上游作者的立场；
- 上游的 issue 编号与本仓库的 issue 编号**互不相同**，引用时请写明仓库；
- 维护按 best-effort 进行，**不承诺**任何 SLA 或功能路线图（见 README）。

## 五、上游未包含的代价

本仓库修改了与上游共享的协议行为，因此：

- 若上游日后恢复维护并发布新版本，本仓库的改动**不会**自动合入；
- 反向亦成立：本仓库的改动**不会**自动回流到上游；
- 两边若各自演进，`business` 记账语义可能再次分叉，届时以各自文档为准。

---

若你是上游作者并认为本文件有不妥之处（例如署名方式、修改描述、或你不希望被以这种方式
分叉），请在本仓库提 issue，我会按你的意愿调整。
