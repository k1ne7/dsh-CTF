<div align="center">

# dsh-CTF

### CTF · 为 DeepSeek Harness 提供证据驱动的 CTF 协作

[![Version](https://img.shields.io/badge/version-0.6.0-blue)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![CI](https://github.com/k1ne7/dsh-CTF/actions/workflows/ci.yml/badge.svg)](https://github.com/k1ne7/dsh-CTF/actions/workflows/ci.yml)

**原生多 Agent · 批量工具执行 · 自动证据摘要 · 内置离线知识库**

[安装](#安装) · [使用](#使用) · [能力](#能力) · [验证与边界](#验证与边界) · [致谢](#致谢)

</div>

## 简介

dsh-CTF 是面向 DeepSeek Harness 的 CTF 解题插件，提供 **CTF 模式**、原生多 Agent 协作、
批量工具执行、共享假设与证据摘要，以及按需检索的离线知识库。

目标是减少重复探索、工具往返和多 Agent 之间的信息损失，让有效推理用于解题。
不承诺固定两分钟解题，也不把更多 Agent 数量等同于更高成功率。

## 安装

### 前置条件

- 已安装并初始化 DeepSeek Harness；**已在 0.2.1-rc.3 验证**。实验性 API 升级后需要重新检查兼容。
- 已配置自己的模型账户/API。插件不包含模型、Key、Cookie 或付费服务。
- Python 3.11+ 用于可选的脚本助手与离线检索；运行助手仅需标准库，无需 pip 安装依赖。
- 多 Agent 需要 DSH 原生 Agent Teams；可在 Plugins 页面启用。没有 Team 时仍可使用宿主实际可用的 Workflow 或单 Agent。

### Web profile：直接从 GitHub 安装

```bash
dsh plugin --profile web add github:k1ne7/dsh-CTF
```

随后在 DSH **Plugins** 页面启用 **dsh-ctf** bundle，重启 DSH。
`plugin add` 安装依赖，启用 bundle 才会加载模式；这两个步骤都要完成。

若手动管理 profile，确认 `package.json` 的 `dsh.profile.bundles` 中含 `dsh-ctf`，
原有 bundles 仍需保留。

### Desktop

在桌面版插件管理入口添加 `github:k1ne7/dsh-CTF` 并启用 `dsh-ctf`，然后重启应用。
桌面版 profile 由应用管理，使用应用插件管理流程，不使用 CLI 启动 `--profile desktop`。

也可下载 Release 的 `.tgz`，交由 DSH 插件管理器作为本地包安装。
从源码/包安装均无需运行本机构建脚本；入口在运行时从包位置解析资源，支持移动目录。

> GitHub 访问受限时，可使用自己已配置的代理，或下载 Release 包离线安装。
> 插件不修改代理设置，不自动下载 Kali、Docker 镜像或新操作系统。

## 使用

1. 新建会话，选择 **CTF**，工作目录选在题目目录。
2. 开场核对 `K1NE_CTF_PRESET=0.6.0`，工具列表有 `ctf_batch` 与 `ctf_hypotheses`。
3. 给出题面、附件/实例、规则和已知事实；不要为提速而编造提示。
4. Lead 按独立分支选择队友，最多 4 个且服从宿主可用槽位，主 Agent 同时推进。

示例：
```text
解这道 CTF 题。附件在当前目录，题目实例为 <URL>，规则为 <规则>。
按任务独立方向自行选择最多 4 个子 Agent，主线同时推进。
合并已知工具操作，复用跑通脚本；先给实际验证结果和证据，长 writeup 按需生成。
```

已运行过的旧会话可能保留旧装配，更新后用新会话验证，不能仅根据磁盘版本判断生效。

## 能力

| 能力 | 实现与作用 |
|---|---|
| 原生 Team 协作 | 使用 DSH 的成员、消息、任务板；不另建生命周期和第二套任务分配系统 |
| `ctf_batch` | 一次提交多项原生工具调用，完整结果归档、短预览；宿主声明安全的只读操作可并行 |
| 结构化执行 | `ctf_exec.py` 使用 argv 数组，减少 PowerShell/Python 多层引号问题；记录退出码与原始输出 |
| `ctf_hypotheses` | 共享假设、观察、证据和反例，版本检查防止并发覆盖；旧结论保留历史 |
| 自动上下文摘要 | 绑定同一 case 的 Agent 在下一次组装上下文时收到精简状态；不逐轮灌入全部历史 |
| 内置知识库 | 随包离线分发，字面量搜索与按行展开，不调用嵌入 API、不全量进入模型上下文 |

### 批处理

```json
{"steps":[{"tool":"read","args":{"file_path":"source.php"}},{"tool":"read","args":{"file_path":"config.php"}}],"output_path":"observations","parallel_reads":true}
```

每项仍经过宿主工具管线。shell/写入保持串行，默认遇错停止后续操作；已经开始的并行读取先结算。
归档经原生 write 写入 `output_path.<随机ID>.json`，不覆盖原文件。
归档失败不会自动重跑已完成操作。图片和交互式调试可直接使用原工具。

### 共享假设

Lead 为每题选择唯一 `case_key`，传给队友；每人首次调用 `list` 绑定同题。
`update` 带 `expected_revision`；`supported/refuted` 要求观察和证据引用，写快照失败不提交版本。
这不是 Flag 裁判：证据路径仍是模型声明，需要实际内容支持。

状态在当前预设修订/进程内共享；重启后读取保存的快照并显式重新录入相关事实。
本版没有自动跨进程恢复。简单题可省略台账，避免流程开销。

### 离线知识检索

资料已内置于 `vendor/ctf-knowledge`，默认无需另外配置。
在已加载技能显示的资源路径下调用：

```bash
python skills/k1ne-ctf/scripts/kb_search.py search --query "JWT"
python skills/k1ne-ctf/scripts/kb_search.py read --file "JWT.md" --line 1 --count 20
```

这些示例相对路径在源码目录执行；Agent 应使用技能提供的实际资源路径。
默认搜索最多 5 个命中、6000 字符，按需读取默认 4000 字符，可调节；字符不等于精确 Token。
可用环境变量 `DSH_CTF_KB` 或 `--root` 指向自己的资料目录。
知识库脚本仅作参考，不会因安装而执行；历史 WP 的前提需要在当前题目中验证。

## 更新与卸载

用相同插件管理流程更新 GitHub 来源，重启后新建会话。
卸载时在 Plugins 中停用 bundle，再移除包：
```bash
dsh plugin --profile web remove dsh-ctf
```
题目目录中的产物不随卸载删除。插件不覆盖默认模式、模型路由或全局子 Agent 上限。

## 验证与边界

- 发布版：32 项 Python 测试、20 项 Node 测试；实际 DSH bundle 装配与原生工具执行检查通过。
- 已检查错误停止、宿主 guard、生效指纹、共享证据注入和归档。验证未调用真实付费模型。
- Windows 已实测；Linux 由 CI 检查 Python/Node 测试，完整 Linux/macOS DSH 运行未实测。
- 旧预设安装器专用测试已由可移动包入口测试替换，旧本机安装/构建脚本不参与发布。
- 本项目用于题目、靶场及授权测试，遵循用户规则和宿主审批。不会以预设文字绕过宿主权限。

开发检查：
```bash
npm test
```
本仓库有 Windows/Linux CI；无需启动模型或下载额外操作系统。

## 致谢

- **[Dest1ny-Sec/Des-CTF-Knowledge](https://github.com/Dest1ny-Sec/Des-CTF-Knowledge)**：感谢 **Dest1ny** 以及知识文章、历届 WriteUp、脚本的原作者与贡献者。本项目随包保留用户提供知识库的精选离线快照（专题文章、分段索引与工具手册；完整 WP/脚本见上游）与原始 README/LICENSE。
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**：提供原生 Agent、工具、Skill 与 Team 机制；基础组合参考官方 standard preset。
- **[fb0sh/dsh-pentester](https://github.com/fb0sh/dsh-pentester)**：参考精简运行状态注入的架构思路，未复制其运行时代码或 Skill Pack。

本项目原创代码 MIT。第三方知识的整体整理与单篇文章/脚本可能适用不同作者和许可，
不统一重新授权第三方内容。详见 [第三方声明](THIRD_PARTY_NOTICES.md) 和保留的原始许可证。

## 0.6.0：流程调整（效果待评估）

- 模式显示名为 **CTF**；内部 id 仍为 `k1ne-ctf`，保留会话引用兼容。
- 按独立工作量选择 **0–4 个队友**，不强制开场分工；主 Agent 可直接推进。
- 只保留 **k1ne-ctf 一个通用 Skill**；漏洞/POP 方法为按需参考，不默认加载。
- 默认工具面不注册建图工具；`plugins/chain.mjs` 仅为保留的实验代码。
- 假设支持 `depends_on`，前提被反驳时显示受影响分支；保留依赖验证与历史。
- 摘要按最新更新排序，以完整 JSON 条目组成，并显示省略数量。
- `tools/result` 观察器仅在失败或相同参数重复调用时注入简短反馈；正常成功不增加该反馈上下文。

观察器保存最近 64 条元数据作比较，不是解题回合限制；不输出原始参数、不拦截必要轮询、
不自动重试，也不推断目标状态一定未变。它不依赖模型先调用“检查进度”工具。

**功能测试通过不等于提速得到证明。** 当前缺少固定模型/参数、干净环境、多题重复的对照评测，
且已有单题回归现象。本版作为候选流程调整提交审查，不宣称全面快于原生模式或提高难题解出率。
原有 v0.3.0 Release 保留，可作为基线；PR 合并与 Release 发布是独立操作。
