# 仓库敏感信息与结构审计

审计日期：2026-07-31
审计基准：`bf226cb`
审计范围：首次导入的私有仓库 `apmengzi/friberg-assistant`

## 结论

初步检查没有发现实际私钥、真实 `.env`、数据库凭据或已填写的管理员 Token。仓库中的 `PUBLIC_LICENSE_KEY.pem` 是离线许可证验证公钥，按设计允许分发。

但仓库当前包含较多运行时/生成物，并存在一个高风险本地自动化配置。当前适合继续私有开发，不建议在清理完成前改为公开仓库。

## 已确认的高优先级问题

### 1. `.codex/config.toml` 启用了 `danger-full-access`

当前内容：

```toml
sandbox_mode = "danger-full-access"
```

风险：仓库级配置可能让后续自动化助手在本机以过宽权限运行。该文件不属于插件运行所需内容，应从版本控制中移除并加入忽略规则。

处理：本 PR 删除该文件，并忽略 `.codex/`。

### 2. 运行时浏览器快照被提交

已提交 `.playwright-mcp/page-*.yml`。当前抽样主要是页面可访问结构，但此类文件未来可能包含房间文本、用户输入或临时页面状态。

建议：

- 加入 `.gitignore`；
- 后续专门清理已跟踪快照；
- 需要保留的 DOM fixture 应脱敏后移入 `tests/fixtures/`。

### 3. Python 缓存和临时服务日志被提交

包括：

- `tests/__pycache__/`
- `work/server.err`
- `work/server.out`

这些不是源码，应移除并忽略。

### 4. 本地绝对路径出现在文档中

`docs/INSTALL_EDGE.md`、`docs/INSTALL_SCRIPTCAT.md` 等文件包含开发机路径 `C:\Users\30369\...`。

风险较低，但会暴露本地用户名/目录结构，并让安装说明不可移植。

建议改成：

- 项目相对路径；或
- `<项目根目录>` 占位符。

### 5. 旧的在线商业构建仍指向 localhost

`dist/friberg-assistant-commercial-extension/license-config.js` 包含：

```js
apiBase: 'http://127.0.0.1:8787'
```

这不是秘密，但该目录不能作为买家可用构建。当前离线 Ed25519 构建位于 `dist/friberg-assistant-commercial/`，两者名称相近，容易误发。

建议：

- 将在线旧构建标记为 legacy；
- 构建审计中禁止把 localhost 版本当作销售包；
- 明确唯一商业交付目录。

## 中优先级结构问题

### 6. 核心文件存在多份复制

根目录、`extension/`、`dist/` 和 `artifacts/backups/` 中都有：

- `solver.js`
- `automation-core.js`
- `live-dom-adapter.js`

`tools/package-personal-extension.ps1` 表明根目录版本是主要来源，再复制到 `extension/` 和 `dist/`。长期手改任意副本容易产生漂移。

建议：

- 根目录核心文件为唯一来源；
- `extension/` 作为可加载源码模板；
- `dist/` 仅由脚本生成；
- CI 比较摘要，防止复制版本不一致。

### 7. 下载的第三方站点资源被提交

`artifacts/live-site-assets/` 包含下载的 JS/CSS bundle。

风险：仓库体积、许可证边界、过期代码和误用风险。

建议：将其视为临时审计材料，不作为长期源码；需要保留的证据只记录文件哈希、URL 和关键片段。

### 8. 备份目录与正式源码并存

`artifacts/backups/` 保存旧扩展副本。Git 已经承担版本历史职责，继续在仓库中保存完整副本会增加误改和搜索噪声。

建议：后续确认基准标签后删除备份目录，使用 Git tag/branch 代替。

### 9. 扩展权限范围仍需单独审计

`extension/manifest.json` 包含：

- `optional_host_permissions: ["http://*/*", "https://*/*"]`
- web accessible resource 的 `<all_urls>` 匹配

当前主要 content script 仍限制在弗一把和 localhost，但可选权限较宽。应另开任务确认是否能缩到实际需要的私人测试 origin。

## 已检查的敏感关键词

初步检查覆盖：

- PEM 私钥头；
- `ADMIN_TOKEN`；
- `LICENSE_SIGNING_SECRET` / `LICENSE_PEPPER`；
- `.env`；
- GitHub/OpenAI 常见 Token 前缀；
- 本地绝对路径；
- localhost 商业配置。

出现 `ADMIN_TOKEN`、`BEGIN PRIVATE KEY` 的已知位置目前属于：

- 环境变量读取代码；
- 商业包审计规则；
- 集成测试假值；
- “不得包含私钥”的断言。

这些不是实际凭据。

## 后续处理顺序

1. 删除并忽略 `.codex/`；
2. 加入 CI 敏感信息扫描；
3. 忽略运行时快照、缓存、日志和证据包；
4. 另开清理 PR 删除已跟踪生成文件；
5. 将本地绝对路径改为可移植说明；
6. 统一源码/生成物边界；
7. 审计扩展权限；
8. 保持仓库 Private，直到许可证和第三方资源边界另行确认。

## 当前不修改的内容

本次流程建设不得修改：

- `solver.js`
- 646 人题库；
- 严格反馈规则；
- 全量契约 oracle。
