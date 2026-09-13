# 本地批次独立评审记录（2026-09-13）

Status: **BILIKARA_LOCAL_BATCH_REVIEW_PASS**（2026-09-13 复审后）
首轮结论为 `BILIKARA_LOCAL_BATCH_REVIEW_CHANGES_REQUIRED`；F1 已修复并复验，
F2 经用户决策确认为有意的发布策略。变更依据见文末「复审更新」，首轮原文全部保留。

评审对象：`work/v0.8.0` 实际本地树（HEAD `3f3d5a1` + 未提交的共享 catalog/Sheets 工作）。
本记录不覆盖既有报告；`docs/pr109-integration-concurrency.md` 与
`docs/catalog-rust-local-migration.md` 的原作者文本保持不变，仅各自追加署名页脚。
本轮只做评审：未修改产品或 tracked 测试代码，未 commit/amend/merge/stash/切分支/push，
未触发 Actions、部署或签名。临时探针与输出全部在仓库外。

## 分范围结论

| 范围 | 结论 | 依据 |
| --- | --- | --- |
| P05 DASH/DownKyi（`8ba65a8`） | **PASS** | 下载器归属、native_media 策略、选流、Cookie/超时、URL 次序与错误分类不变 |
| P03 完整导出（`4395abe`） | **PASS** | 真实 CSV/PNG/ZIP 产物与视觉结果复核通过；生产 Pillow 已退役 |
| 共享 catalog / Sheets 回退（未提交） | **PASS**（复审后） | F1 已修复并复验；首轮为 CHANGES_REQUIRED |
| LAN/公网并发与命令投递（`4d1fd99`） | **PASS** | 真实 HTTP/FFI/DataChannel 8/8，且以未打桩的慢 catalog 复验锁释放 |
| UI（`61a6d05` 及 PR 合并页面） | **PASS** | 真实浏览器两项 UI 回归 PASS，已目视代表截图 |
| PR #109 实际整合（本轮界定范围内） | **PASS**（复审后） | F2 为有意策略，非缺陷；首轮为 CHANGES_REQUIRED |

PR #109 已真实合入本地历史（merge `17252bf`，父 `49b1bd0` / `6eb91d8`），不是仅 fetch/评估。
本评审只按任务要求复核其改动到的共享 media/cache/state/persistence/auth 与 build/release 边界，
**未对 PR109 全量内容出具通过结论**；Android/Kotlin/native_host 主体仍未评审、未设备验收。
S1–S3 / M1–M6 与已完成的 T/P01 未重开。历史
`S3_MEDIA_ERROR_TAXONOMY_REVIEW_CHANGES_REQUIRED` 未被作为本批证据引用。

## 首轮必须修复项（原文保留；当前状态见文末「复审更新」）

### F1 — Sheets 快照刷新沿用了 D1 搜索超时（2 秒），而非文档承诺的 20 秒

- 实现路径：`rust-runtime/src/shared_catalog/sheets.rs` 的 `fetch()`
  使用 `.timeout(Duration::from_millis(request.timeout_ms.clamp(100, 20_000)))`，
  而 `request.timeout_ms` 就是调用方的 D1 读取超时。
  搜索路径为 `bilikara/shared_catalog.py:16` 的 `_CLOUDFLARE_SEARCH_TIMEOUT = 2.0`
  （`:61 search_catalog`）；其余读取路径最大 8 秒。没有任何生产调用方传入 20 秒。
- 触发条件：D1 出现可回退故障 → 进入 Sheets 回退 → 需在 2 秒内完成对
  `docs.google.com` 的整表 GViz CSV 快照下载（上限 32 MiB / 100,000 行）。
- 违反的当前契约：`docs/catalog-rust-local-migration.md`
  “A snapshot refresh is bounded to 32 MiB, 100,000 rows and a 20-second maximum HTTP timeout.”
- 复现（仓库外探针 `sheets_timeout_probe.py`，loopback 夹具）：
  CSV 延迟 3 秒 + 默认搜索超时 → 2.01 秒失败，`catalog_providers_unavailable`；
  同一 CSV + Python 超时 10 秒 → 3.01 秒成功返回 `source: sheets`；
  CSV 延迟 0.2 秒 + 默认搜索超时 → 成功（对照组）。
  现有夹具全部在 loopback 上瞬时返回，因此无法暴露该问题。
- 影响放大：刷新失败会写入 30 秒 `sheets.backoff`，故障期内后续搜索直接不可用。
- 最小修复建议：让快照刷新使用独立预算，而不是复用 D1 读超时。例如在 `sheets::fetch`
  内用 `request.timeout_ms.max(SNAPSHOT_TIMEOUT_MS)` 再 clamp，或给 `CatalogRequest`
  增加 Host 侧 `sheets_timeout_ms`（默认 20000）。不要提高 D1 读取超时。

### F2 — 桌面 R2 发布镜像新增了对实验性 Android 正式签名的依赖

- 实现路径：`.github/workflows/ci-bundle.yml` 的 `mirror-release-r2`
  由 `needs: bundle` 改为 `needs: [bundle, android-bundle]`；
  `scripts/android_release.mjs` 在 `refs/tags/v*` 上缺少四个
  `ANDROID_KEYSTORE_*` / `ANDROID_KEY_*` secret 时直接抛错。
- 触发条件：打 `v*` tag 而 Android 签名 secret 未配置，或 Android SDK/NDK/Gradle
  任一步失败 → `android-bundle` 失败 → `mirror-release-r2` 被跳过。
- 后果：桌面 GitHub Release 本身仍会发布，但 R2 镜像
  `https://api.kevinx96.icu/bilikara/releases/latest` 与 `/releases`
  （`bilikara/config.py:145,149`，由 `bilikara/updater.py:197,231` 作为镜像回退消费）
  不会刷新，依赖镜像的桌面客户端会停留在上一版本元数据。
- 这是相对 PR 前工作流的实际发布边界变化。`docs/pr109-integration-concurrency.md`
  已将其记为待决策事项，本评审确认其为需要处置的阻塞项，而非已接受的设计。
- 最小修复建议：解耦平台发布——把 `android-bundle` 移出 `mirror-release-r2` 的 `needs`，
  或拆出独立的 Android 镜像 job。**本轮未创建密钥、未改 secret、未选择发布策略**，
  该决定属于用户授权范围。

## 非阻塞差异与观察（不要求修复）

- P05：`视频播放地址不可用: ` / `请求被风控拦截: ` 等中文前缀不再拼接，改为直接透传 Rust
  message。`kind` / `api_code` / `status_code` 与 `_is_terminal_track_failure` 分类均已保留并有断言。
- P03 与 Android：`src-tauri/gen/android/.../PlaylistExport.kt` 是第二套独立的 CSV/排版实现
  （固定表头 `播放时间`、全字段加引号、`= + - @` 公式前缀、`UP 主 UID` 为 0 时留空、
  720px 系统 Typeface、不同文件名、`Locale.ROOT` 时间）。行选择/排序确实来自
  `native_host/exports.rs` 的只读投影。该差异已在整合报告中如实记录，未被悄悄固化为 P03 的替代品。
- `static/i18n.json` 的 `search.larkPartialNoResults` / `search.larkFoundPartial`
  已无任何 JS 引用（多表语义随 `searchLarkPoolTable` 一并退役），属可清理的死键。
- `shared_catalog/sheets.rs` 的 `search()` 在持有 AppState 互斥锁时整体 clone 排除集合
  （上限 10,000 × 3 String）。当前有界，量大时值得改为只读借用。
- catalog 路由现在返回真实 HTTP 状态码（原先恒 200 + `{"ok":false}`）。
  `app.js` / `remote.js` / `remote-transport-client.js` 均已按 `!response.ok` 处理；
  `_call_runtime_service` 的全部失败分支都抛 `RustRuntimeServiceError` /
  `RustRuntimeUnavailableError` 并由 `_request` 转成 `CatalogError`，收窄 `except` 未留裸异常。
- 空 `q` 与空分类 tag 现在在 Rust 内直接短路返回空结果，不再发出 Worker 请求。
- 残留的 `lark` 命名仅为 DOM/i18n 标识与 `/api/lark/search` 薄别名（`table` 一律 410），
  直接飞书 token/表探测代码与配置已随 `lark_pool_client.py` 一并删除。

## 待定（非代码缺陷）

- 实体设备与跨网：手机、Wi-Fi/蜂窝、NAT/TURN、长时后台恢复；Android / Windows / macOS 打包验收。
  本轮全部为 Linux x86_64 + loopback，未冒充跨网验收。
- Sheets 生产快照体积与发布节奏、外部删除/黑名单同步覆盖：未验证（实现方已记录为覆盖限制）。
  未访问生产表格，未使用凭据。
- Android 导出契约与 P03 的统一、Android renderer 可用性：未验收。
- `npm run build` 首次在 AppImage `linuxdeploy` 阶段 FAIL、重试 exit 0，根因未确认。
  按证据复用处理，不作为本批代码缺陷。

## 本轮实际执行的检查

仓库内命令（工作目录 `/sunhonglin/bilikara`），日志在会话 scratchpad：

| 命令 | 结果 |
| --- | --- |
| `cargo test --manifest-path rust-runtime/Cargo.toml --locked` | PASS，212 passed / 15 ignored |
| `cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --lib --locked` | PASS，257 passed / 15 ignored |
| `cargo fmt --check`（`rust/`、`rust-runtime/`、`src-tauri/` 三个 manifest） | 全 PASS |
| `git diff --check` | PASS |
| `BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_shared_catalog tests.test_transport_concurrency tests.test_internet_remote tests.test_internet_remote_frontend tests.test_server tests.test_playlist_export tests.test_rust_runtime` | PASS，295 tests |
| `python -m tests.run_catalog_native` | PASS，2 tests（native Host HTTP + native Internet，D1 与 Sheets 两条） |
| `python tests/live_transport_concurrency.py --output <scratchpad>/browser` | PASS，8/8 |
| `python tests/live_host_ui_browser.py --mode remote-request-workspace --screenshot …` | PASS |
| `python tests/live_host_ui_browser.py --mode internet-remote-host --screenshot …` | PASS |

仓库外探针（未改动仓库文件）：

- P03 真实导出：经 `bilikara.playlist_export` → FFI → Rust，生成并**目视检查**
  ordinary / empty / longtext 单页 PNG 与 165 条的 3 页 ZIP；CSV 含 BOM、CRLF、
  最小引号、嵌入换行、`""` 转义与本地时间。longtext 页确认中日韩、希腊、西里尔、
  阿拉伯、希伯来、泰文、全角与彩色 emoji 均有真实字形回退，无豆腐块，三行省略正常。
- catalog 锁探针：用**未打桩**的阻塞 D1 HTTP 夹具，在 catalog 读取仍挂起时，
  经真实桌面 HTTP → FFI → AppState 完成两次相对 seek（均 200，队列保留
  `seq1 delta 7` 与 `seq2 delta 11`，按序投递）与一次相对 AV adjust（200，effective 50）。
  这补上了 `test_delayed_search_releases_state_lock_and_control_lane` 只打桩
  `internet_remote.search_catalog` 所留下的证据缺口。
- Sheets 超时探针：见 F1。

复用的既有证据（未重跑）：`/tmp/bilikara-catalog-sheets-validation/results.json`
记录的稳定组合树完整门禁（23 个阶段，除 `npm-build` 首次 exit 1 外全部 exit 0，
`retry-results.json` 记录 `npm run build` 重试 exit 0），以及
`/tmp/bilikara-p03-export/` 的 P03 前后视觉基线。

## 全局计划位置与状态（分别陈述）

- 里程碑：v0.8 Rust Core Convergence / Preview。Phase 2 早已 8/8 完成，本批不属于新阶段。
- 实现：P05、P03、UI、PR109 整合、控制 FIFO/AV-delay 修复均已完成并提交；
  共享 catalog / Sheets 回退已完成但**未提交**（37 个 tracked 改动 + 5 个 untracked 路径）。
- 本地测试：上表全部通过；完整门禁证据有效（含一次 AppImage 重试）。
- 独立评审：本记录即为结论，**CHANGES_REQUIRED**（F1、F2）。
- Commit：P05/P03/UI/并发修复已提交；catalog 工作未提交。**Push：No**（本轮及本批均未 push）。

### 生产 Python 实际移除的职责

- 导出（P03）：CSV 生成、排序与时间解释、字体发现/回退/缓存/预热、排版、PNG 与多页 ZIP 编码。
  `bilikara/playlist_export.py` 只剩 41 行入口签名与资源路径，生产已无 Pillow 导入。
- DASH（P05）：playurl WBI 签名、请求、响应解析、durl 回退、FLAC/Dolby 绑定与错误分类。
- 控制投递：Python 单槽命令状态与 ACK 高水位已删除，唯一 FIFO 在
  `rust-runtime/src/app_state/player_control.rs`。
- Catalog：`bilikara/lark_pool_client.py`（1,414 行）整体删除，含全部直接飞书 token/表探测。
  D1 查询规划/归一化/去重/分页/缓存/回退与 review/admin/rating/maintenance 请求策略均归 Rust。

### 仍存活的生产 Python 与薄适配

- 薄适配：`shared_catalog.py`（185 行）、`playlist_export.py`（41 行）、
  `bilibili.py` 的 `fetch_dash_playurl` 包装、`rust_runtime.py` 服务传输与结果校验、
  `store.py` 的 `issue/ack/player_control_snapshot`。
- 仍有实际业务/IO 职责：HTTP/SSE/cookie/公开投影、启动与环境/路径、基于 Rust 快照的持久化、
  其余 Bilibili metadata 与 Gatcha/维护 WBI（`enc_wbi` / `get_cached_wbi_keys` 仍在
  `bilikara/bilibili.py:933,945,974,978`）、登录与 Local Remote identity、updater 适配、
  BBDown/yt-dlp/aria2c/FFmpeg 外部工具编排、缓存调度与取消。
- 明确不随本次模块迁移的：独立的月度维护 runner `monthly_gatcha_d1_refresh.py`
  （本次只改了一行 import），以及本地评分身份台账。

### PR 内但桌面尚未使用的 Rust 候选

`rust-runtime/src/native_host/`（login、session/transport、preferences、updates、
library、cache、files、diagnostics、maintenance、exports）、`native_persistence`、
`native_host_storage`、`native_video`。它们已入树并通过 `--features native-host` 编译，
但**未**出现在 `rust-runtime/src/ffi.rs` 的 `RuntimeServiceCommand` 中，
桌面 Python 无法调用，因此不计为桌面迁移完成。本批新增并真正接入桌面的只有
`RuntimeServiceCommand::SharedCatalog`。

---

## 复审更新（2026-09-13，同一评审者）

首轮结论 `BILIKARA_LOCAL_BATCH_REVIEW_CHANGES_REQUIRED`（F1 + F2）原文完整保留在上方。
本节记录两项的处置与**独立复验**结果，复审后结论为 `BILIKARA_LOCAL_BATCH_REVIEW_PASS`。

### F1 — 已修复，复验通过

实现方把 Sheets 快照预算与 D1 读预算分离：
`rust-runtime/src/shared_catalog/sheets.rs:9` 新增 `SNAPSHOT_TIMEOUT = 20 秒`，
`:49` 改为 `.timeout(SNAPSHOT_TIMEOUT)`，不再使用 `CatalogRequest.timeout_ms`。
实现方另加了真实 Python → FFI → Rust → loopback HTTP 回归
`tests/test_shared_catalog.py:548 test_snapshot_refresh_has_independent_budget_from_d1_search`
（D1 立即 503、CSV 延迟 3 秒、显式 pin `_CLOUDFLARE_SEARCH_TIMEOUT = 2.0`），
该测试直接锁住本回归，且没有打桩被测算法。

评审者用**首轮同一组探针**独立复验（仓库外，loopback 夹具）：

| 探针 | 首轮（修复前） | 复审（修复后） |
| --- | --- | --- |
| CSV 延迟 3 秒 + 默认搜索预算 2 秒 | FAIL，2.01 秒 `catalog_providers_unavailable` | **PASS，3.01 秒返回 `source: sheets`** |
| CSV 延迟 0.2 秒（对照） | PASS，0.21 秒 | PASS，0.21 秒 |
| CSV 延迟 21 秒（上界） | 未测 | **失败于 20.01 秒**，仍为 `catalog_providers_unavailable`——预算有界，未变成无限等待 |
| D1 延迟 3 秒 + 关闭 Sheets（防回归） | — | **仍失败于 2.00 秒**；D1 读预算未被一并放宽 |

`bilikara/shared_catalog.py` 的 `_CLOUDFLARE_SEARCH_TIMEOUT = 2.0`、
`_CLOUDFLARE_CATEGORY_TIMEOUT`/`_CLOUDFLARE_PREWARM_TIMEOUT = 8.0`
与 `read_catalog` 默认 8.0 均未改动，修复没有以放宽 D1 预算的方式绕过问题。

刷新窗口从 2 秒变为最长 20 秒，因此评审者重跑了锁属性复验：用**未打桩**的阻塞
Sheets CSV 夹具（D1 立即 503），在快照 HTTP 读取仍挂起时，经真实桌面
HTTP → FFI → AppState 完成两次相对 seek（均 200，队列保留 `seq1 delta 7` /
`seq2 delta 11` 并按序投递）与一次相对 AV adjust（200，effective 50）。
更长的刷新窗口**没有**把 AppState 权威锁握在网络等待里。

复审重跑的检查（全部 PASS）：三个 manifest `cargo fmt --check`、`git diff --check`、
`rust-runtime` clippy `-D warnings`、`cargo test --locked` 212 passed/15 ignored、
`--features native-host --lib` 257 passed/15 ignored、
定向 Python **296 tests OK**（较首轮 295 增加的 1 项即上述新回归）、
`python -m tests.run_catalog_native` 2 PASS。
P05/P03/UI/并发的首轮 PASS 结论未重开，相关证据复用未重跑。

`docs/catalog-f1-fix-2026-09-13.md` 记录的实现方 23 阶段完整门禁（全部 exit 0，
本轮 npm build 无需重试）作为有效证据复用。

### F2 — 撤回该缺陷认定：经用户决策确认为有意的发布策略

用户已配置 Android 签名 secret，并明确决定：**Android 构建失败就应该阻止桌面产物上传到 R2**。
因此 `mirror-release-r2: needs: [bundle, android-bundle]`
（`.github/workflows/ci-bundle.yml:556`）是有意的耦合，不是缺陷；首轮把它列为必须修复项的
认定到此撤回，工作流无需修改。已确认当前配置与该意图一致：
桌面 GitHub Release 上传在 `bundle` 作业内（`:440`，`needs: test`）不受 Android 影响，
被 Android 门控的只有 R2 镜像作业，正是用户所指的范围。

随之而来的、现已被接受的运行后果（记录而非异议）：在 Android 失败的 tag 上，
GitHub Release 会发布新版本，而 R2 镜像
`https://api.kevinx96.icu/bilikara/releases/latest` 与 `/releases`
（`bilikara/config.py:145,149`，`bilikara/updater.py:197,231` 的镜像回退）
保持在上一版本，两条分发渠道会短暂不一致，直到 Android 作业成功重跑。

评审者**没有**创建密钥、读取密钥、配置或验证 GitHub secrets、签名、触发 Actions 或部署。
因此 secret 是否正确、`android-bundle` 在 tag 上能否实际通过，均**未经验证**，
属于尚未执行的平台门禁，见下方待定项。

### 复审后的三类事实（分别陈述）

- **代码就绪**：本轮界定的全部评审范围通过，见上方分范围表。
- **自动化平台验证**：Linux x86_64 完整本地门禁通过（实现方 23 阶段 + 评审者重跑的定向与真实浏览器检查）。
  Android / Windows / macOS 的 CI 与打包运行**未执行**；`android-bundle` 从未在本环境运行过。
- **人工 / 设备验证**：手机、Wi-Fi/蜂窝、NAT/TURN、长时后台恢复、Android 导出 renderer
  与实体安装**未执行**。Sheets 生产快照体积/发布节奏与外部删除、黑名单同步覆盖仍未验证。

上述三项互不代表，`BILIKARA_LOCAL_BATCH_REVIEW_PASS` **不**等于平台或设备验收通过，
也**不**构成对 PR #109 全量内容（Android/Kotlin/native_host 主体）的通过结论——
本轮对 PR109 的评审范围仍限于它改动到的共享
media/cache/state/persistence/auth 与 build/release 边界。

### 用户验收与提交授权（2026-09-13）

用户在复审通过后确认「验收通过，可以 commit」，授权将当前 catalog / Sheets、
F1 修复和本批评审记录创建本地提交。F2 保持全部平台成功后才同步 R2 的既定策略。
此授权不扩大上方平台/设备验证范围，不包含 push、触发工作流、签名或部署。
