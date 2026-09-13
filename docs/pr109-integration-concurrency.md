# PR109 本地整合与并发修复（2026-09-13）

用户已授权把本地提交移动到 PR 提交之后。`work/v0.8.0` 已完成重放，固定基座为
`17252bf546b0d3fb62efd3305f07bc1905d33b8e`；该 PR merge 和之前所有提交未改写。
没有另建分支、stash、push、部署、Actions 或签名操作。新增修复/回归已按后续授权保存为本地提交，独立评审 deferred。

| 本地范围 | 原提交 → 重放后 | 当前实现 / 验证 / 评审 / push |
| --- | --- | --- |
| UI | `f3b9903` → `61a6d050bf86412d4dbad0618abef25014f1b913` | 保留本地布局与 PR 分页；定向及浏览器 PASS；未独立评审；No |
| P05 DASH/DownKyi | `2f5a02b` → `8ba65a853595b5fb0dcf9e5c3796b1d08fd566a3` | range-diff 补丁等价，保留 PR Android TLS builder；组合门禁 PASS；deferred；No |
| P03 桌面完整导出 | `210a574` → `4395abe84d015b6e818fed95ec33fa8a84803330` | Rust renderer/FFI 保留，依赖并集；导出/HTTP/QR 组合测试 PASS；deferred；No |
| 控制 FIFO/ACK、AV-delay | `4d1fd99` | 三项确认故障修复；真实 HTTP/FFI 与 loopback WebRTC PASS；deferred；No |
| S1–S3/M1–M6、完成 T/P01 | 原状态保留 | 不重开；其他 P 迁移和 D0 未开始 |

备份：`/tmp/bilikara-pr109-rebase-a0ou194a/` 的 `pre-rebase.bundle`、`working.patch`、
`files/` 和 `manifest.json` 保存原提交及所有未提交文件；重放后恢复了全部原改动。
重放命令：`GIT_EDITOR=true git -c rebase.autoStash=false rebase --onto 17252bf546b0d3fb62efd3305f07bc1905d33b8e 49b1bd07a77398851fce0d4ac797dd24a248fe9a`。
每处冲突仅暂存已解决文件后 `GIT_EDITOR=true git rebase --continue`。
`range-diff.txt`、`replayed-history.txt`、`replayed-files.txt` 保存精确补丁比较、SHA/原消息和全部重放文件。
冲突仅 `static/remote.js` 三处与 Runtime lock 的 csv/deranged 插入点；没有整文件选一侧。

## 本地提交整理（后续授权）

用户要求清理未暂存工作并提交。核对的 13 个 tracked 修改与 6 个 untracked 文件均为有效整合工作，
没有需要删除的临时调试文件。按职责保存 19 个文件；未清理 ignored 构建产物或历史证据。

| 提交 | 消息 |
| --- | --- |
| `0543b56` | `build(tauri): align lockfile with Rust playlist export dependencies` |
| `4d1fd99` | `fix(remote): preserve concurrent controls and AV delay adjustments` |
| `8b6a5bb` | `test(native-host): isolate diagnostic connectivity probes` |
| 本文与 ledger 所在提交 | `docs: record PR109 integration and validation status` |

本次仅清除测试脚本未使用的 json import，并将原失败基线的测试说明更新为持续回归；未改变生产行为或断言。
提交前新执行以下检查，全部 PASS：

```bash
git diff --check
cargo fmt --manifest-path rust/Cargo.toml --check
cargo fmt --manifest-path rust-runtime/Cargo.toml --check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
node --check static/app.js
node --check static/remote-transport-client.js
node --check tests/live_transport_concurrency.js
python -m py_compile bilikara/server.py bilikara/store.py tests/test_server.py tests/test_transport_concurrency.py tests/live_transport_concurrency.py tests/run_native_host_http.py
BILIKARA_HOME=$(mktemp -d /tmp/bilikara-pr109-commit-home-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_transport_concurrency -v
git diff --cached --check
```

并发回归 13 PASS（6.259s），日志 `/tmp/bilikara-pr109-commit/concurrency.log`。
下方完整门禁、383 项定向及真实 loopback RTC 是上一整合阶段执行的证据，本次提交整理复用，未重复全量构建。
独立评审、无夹具外部诊断超时和实体跨网/平台验收状态不变；本次没有启动迁移或更改发布配置。

## 修复、复用和边界

- PR `native_control/native_ack` 的 16 项 FIFO 已移至 `app_state/player_control.rs`，唯一实例归 AppState。
  Native Host 和桌面 Runtime/FFI 共用它，Python 单槽、序号与 ACK 高水位状态已删除。
  队列满明确 429；入队再次校验 item/generation，晚到 Host effect 明确 409；切代清除旧队列。
  初始化/清空保留进程序号，旧 ACK 不会指向新命令。ACK 只移除匹配队首；native Host token 边界保留，
  桌面 ACK 只允许本机 Host。浏览器同序号 ACK 在途去重、失败后随状态轮询重试，不重复执行相对 seek。
  ACK 表示命令已消费，不承诺媒体已 seek-settled。没有第三队列、双发或整体替换 Python HTTP 后端。
- `player.av_delay_action` 保留 adjust/set_effective/reset_local/toggle_lock 意图，复用 Rust 原子 AV policy。
  两端各 +50 得 100ms；absolute 仍按提交次序覆盖；旧 `player.set_av_delay` 保留。Viewer 无写权限，非法字段拒绝。
- P05 粗粒度 DASH 服务和 PR `http_client::builder()` 同时保留；native-video 已随 PR 在树内并编译，
  桌面 metadata、Gatcha/维护 WBI 未迁移，P05 不代表全部 WBI。
- P03 桌面 CSV/SourceHan 1600px renderer 不变。PR `native_host/exports.rs`、Android `PlaylistExport.kt`
  和 SAF/下载桥保留；Android 的 720px/系统字体/CSV 处理仍未统一到 P03。字体打包、旧场次与限制差异
  仍需定向处理，不能把本轮称作 Android 导出契约统一完成；相关源码/JS 桥验证不等于 Android 设备验收。
- 共享 UI 保留 Android platform/presentation 分支、本地 workspace 和 PR 分页；真实 workspace/房间 UI PASS。
  PR catalog.rs 已在本地并 native-feature 编译，但桌面 searchable catalog/飞书回退仍走 Python，不新造另一套 catalog。
- PR 发布链不改：desktop GitHub Release 本身不依赖 Android job；联合 R2 mirror 仍 `needs: [bundle, android-bundle]`，
  Android 正式签名失败会阻塞它。平台发布解耦仍待决定，未接触签名凭据。

## 测试与证据

定向（新执行，日志 `/tmp/bilikara-pr109-fixes/`）：

- `BILIKARA_HOME=$(mktemp -d /tmp/bilikara-pr109-shared-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_transport_concurrency tests.test_internet_remote tests.test_internet_remote_frontend tests.test_server tests.test_split_player_sync tests.test_remote_request_workspace tests.test_search_result_frontend -v`：383 PASS。
- `cargo test --manifest-path rust-runtime/Cargo.toml --locked --features native-host app_state::native_session::tests`：10 PASS，包含 native/FFI 交叉入队/ACK、Host 权限、队列满/旧代。
- `python tests/live_transport_concurrency.py --output /tmp/bilikara-pr109-fixes/integrated-browser`：8/8 PASS。
  原失败断言保留：两个接受的 seek 投递 2 次，位置 18；AV 为 100；future ACK 不吞命令。
  另有同代 Next、最新重复/revision、阻塞 metadata/search、超时后真实 RTC 重连且 mutation 只发送 1 次、关房间时 LAN 可用。
  新增 Event 屏障验证 dispatch 后切歌再入队必须失败；Node 执行生产消费/ACK 函数验证 ACK 丢失不重放 seek。
- `python tests/live_host_ui_browser.py --mode remote-request-workspace --screenshot /tmp/bilikara-pr109-fixes/integrated-request-ui.png`：PASS。
- `python tests/live_host_ui_browser.py --mode internet-remote-host --screenshot /tmp/bilikara-pr109-fixes/integrated-room-ui.png`：PASS。

稳定组合树默认完整门禁（新执行一次，各阶段由 `/tmp/bilikara-pr109-integration-gate/run.py` 记录）：

| 工作目录 | 精确命令 | 结果 |
| --- | --- | --- |
| `rust/` | `cargo fmt --check`; `cargo clippy --all-targets --locked -- -D warnings`; `cargo test --locked`; `cargo build --release --locked` | 全 PASS；218 tests |
| `rust-runtime/` | 同上四条 | 全 PASS；201 PASS + 15 existing ignored |
| 根目录 | `python -m unittest discover -s tests -v`; `python -m compileall -q bilikara`; `python -m py_compile start_bilikara.py build_bundle.py` | 全 PASS；1618 tests，15 skipped |
| `src-tauri/` | 同上四条 Cargo 命令 | 全 PASS；77 tests |
| 根目录 | `npm ci`; `npm run build`; `git diff --check` | 全 PASS；Linux deb/rpm/AppImage 已生成 |

门禁环境 `BILIKARA_REQUIRE_RUST_LIB=1`、`BILIKARA_HOME=/tmp/bilikara-pr109-integration-gate/fixture-home`、`TZ=Asia/Tokyo`。
日志与逐命令 exit code：同目录 `{core,runtime,python,tauri,frontend}.json` 和对应 `.log`。
最终增量语法/差异检查：`node --check` 分别检查 `static/app.js`、`static/remote.js`、
`static/remote-transport-client.js`、`tests/live_transport_concurrency.js`；
`python -m py_compile tests/test_transport_concurrency.py tests/live_transport_concurrency.py tests/run_native_host_http.py`；
`cargo fmt --manifest-path rust-runtime/Cargo.toml --check`、`git diff --check` 均 PASS。
`rg -n 'from PIL|import PIL' bilikara build_bundle.py start_bilikara.py` 无生产命中；
`requirements-test-qr.txt` 的 Pillow 保留。没有新 checksum/revision gate。
15 Rust ignored 需要显式同构建 libav companion/M1–M5/故障注入/包内 fixtures；15 Python skips 是 PowerShell、
macOS/Win32、包内可执行文件和显式 live companion 条件。未改跳过规则；精确原因在 runtime-3.log/python-1.log。

额外 native-host 检查：`cargo clippy --all-targets --features native-host --locked -- -D warnings` PASS；
`cargo test --features native-host --locked` 的 unit 部分 249 PASS + 15 ignored，HTTP test **FAIL** 在外部诊断探测超时。
曾只给该请求外层增加至 10s，仍超时；已撤回，所有原断言和 5s 超时保留。临时跟踪定位到三个外部探测，
AppState 锁已释放；未确认更深层 DNS/proxy 根因，未改生产诊断代码或假装网络可达。
`python tests/run_native_host_http.py` 使用本地拒绝代理覆盖三个实际诊断 HTTP 错误路径，**1 PASS**（1.52s），
对外转发 0；原 native Host HTTP/auth/export 断言全部执行。此额外结果只证明本地夹具路径，
不能将无夹具外部连通性超时抹掉。日志 `native-http-fixture.log` 和原失败/跟踪日志均保存。

已目视新 `integrated-browser/host-consumption.png`（0:18，两个接受/投递）与 `remote-connection.png`（认证/双通道/pending 0）。
P03 视觉基线复用：`/tmp/bilikara-p03-export/before-single.png` / `after-single.png`，
对应 `*-single-text.png`、`*-single-footer.png`，以及空/多页图与 comparison.json；本轮未重新制作基线。
另目视 `integrated-request-ui-remote-stage2-375-name.png` 与 `integrated-room-ui-internet-remote-active-preview.png`，
名称浏览卡片/内层视口和 Host 双入口弹层可读。组合测试重新执行了真实导出、PNG/ZIP 解码、CSV BOM/引用/时区与独立 QR 解码、禁导入 Pillow。
RTC 是真实 RTCPeerConnection/DataChannel，但信令/metadata 为本地夹具、ICE 无外部 STUN/TURN、媒体合成。
手机/实体 Wi-Fi/蜂窝/NAT、Android/Windows/macOS 包验收仍待；没有把 loopback 称作跨网验收。

## 文件、依赖及余项

本批本地提交新增/修改文件（重放各提交文件另见备份目录 `replayed-files.txt`）：

- `bilikara/server.py`、`bilikara/store.py`：薄传输/结果验证与 Host ACK 授权；删除 Python 投递状态，不新增业务镜像。
- `rust-runtime/src/app_state.rs`、`rust-runtime/src/app_state/player_control.rs`（新增）、
  `rust-runtime/src/app_state/native_session.rs`、`rust-runtime/src/app_state/native_session/tests.rs`：共享 Rust 状态与测试。
- `rust/src/internet_remote_protocol.rs`、`rust/src/lib.rs`：类型/纯协议；`src-tauri/Cargo.lock`：补齐 P03 path 依赖。
- `static/app.js`、`static/remote-transport-client.js`：UI 消费与传输适配。
- `tests/test_server.py`、`tests/test_transport_concurrency.py`（新增）、`tests/live_transport_concurrency.py`（新增）、
  `tests/live_transport_concurrency.js`（新增）、`tests/run_native_host_http.py`（新增）：实现边界与受控 I/O 夹具。
- `docs/internet-remote-v1-protocol.md`、`docs/rust-native-utility-inventory.md`、本文（新增），
  `/tmp/bilikara-t4-python-remnants/HANDOFF.md`：协议、进度和交接。

没有新生产依赖；Tauri lock 只新增 P03 依赖缺项，保留 PR 已锁版本。首次 offline metadata 遇旧索引/yanked 条目，
联网 metadata 确认 lock 需更新，随后以 `cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1` 补齐；
最终 `--locked` 编译通过。Pillow 仍仅 test-only，未重新引入生产。

未找到可用 Google Sheets 歌曲目录，沿用下方已完成的定向搜索证据；README 评分备份不是目录。
真实回退仍是 `lark_pool_client.py` 的 D1→飞书，不抄录凭据。没有新一轮全库审计。
本轮删除 Python 控制投递状态；P03 的业务/字体/编码已 Rust，Python 只留适配/HTTP；P05 仅 DASH/DownKyi。
C01 append 已 Rust；catalog/飞书、其余 metadata/WBI、登录/Local identity、HTTP/SSE、updater、外部工具 workers、
环境/启动/快照 persistence 仍有生产 Python。PR Rust 对应模块现在已入树、native 编译，但不代表桌面调用已迁移。
T2/T7 冻结参考/保留接口不动，build/test scripts 单列。未知 P-ID 映射保持 unknown；D0 不实施。

---

# PR109 集成与并发基线（历史实测，2026-09-13）

当前停止点：只完成集成准备、测试和证据；没有合并或产品修复。失败断言保留。
下一步是另行授权的本地集成及已确认故障修复，不启动另一项重叠迁移。

## 实际树与进度

开始时 `work/v0.8.0` 的 staged、unstaged、相关 untracked 均为空。HEAD 为
`210a574a74c9796d9c7fa42eef5d593628e7ccb2`，并非尚待保存的 P03 diff。
已读根 AGENTS.md；子目录没有其他 AGENTS.md。没有其他活跃 writer。
本轮新增三个测试文件和本文，更新进度 ledger 与已有临时 handoff；生产文件未改。

| 范围 | 实现 / 本地 checkpoint | 本地测试 | 独立评审 | 本轮 push |
| --- | --- | --- | --- | --- |
| P05 DASH/DownKyi 切片 | `2f5a02b`，保留；不代表所有 WBI | 复用既有 focused + P05/P03 合并门禁 | Deferred | No |
| P03 完整导出 | `210a574`，保留 | 复用既有真实 FFI/HTTP/CSV/PNG/ZIP/QR、图像对比及合并门禁 | Deferred | No |
| 最新 Remote UI | `f3b9903`，保留；`49b1bd0`/`1eab03a` 等较早 UI 也保留 | 复用既有证据；本轮另跑房间 UI | 未独立评审；不推定通过 | No；历史各提交远端状态不由本轮推定 |
| 本轮 PR109 基线 | 测试/文档未提交；PR 没有集成 | 见下表，有明确失败 | 没有进行独立评审 | No |
| S1–S3 / M1–M6、已完成 T/P01 | 既有已完成/接受范围不重开 | 不追加设备验收结论 | 原状态保留 | No |
| 其他 P / D0 | 没有实施 | 未执行 | 原状态 / unknown | No |

PR [#109](https://github.com/VZRXS/bilikara/pull/109) 实际读取的头为
`6eb91d86d31c953d8e3f1bb51d8dede5d95cb2ad`，API 所报 base 为
`49b1bd07a77398851fce0d4ac797dd24a248fe9a`。只运行
`git fetch --no-write-fetch-head origin pull/109/head`，用 `git archive` 将源码展开到
`/tmp/bilikara-pr109-concurrency/pr-source/`；没有 checkout、merge、分支/ref 创建。
PR 的既有 1598 项测试、Windows/Android 构建是作者报告，本轮没有执行，不能替代本地结果。
未使用 GitHub mergeable 标志判断本地树兼容性。

## 重叠与复用决定（待执行）

| 交界 | 实际差异与下次集成决定 |
| --- | --- |
| P05 / Bilibili / native-video | 本地 `bilibili_service.rs` 的粗粒度 DASH 服务与 Python/DownKyi 适配保留。PR 在同文件改用 `http_client::builder()`（含 Android TLS 平台处理），不是另一份 DASH 规则；合入该 builder 时保留 P05 服务。PR `native_video.rs` 是 metadata/选 P I/O，复用 core audio binding，是剩余 metadata/WBI 的候选，当前桌面仍执行 Python metadata。不能把 PR 合入候选等同于完成全部 P05。 |
| P03 / native exports / Android | 本地 `rust/src/playlist_export.rs`、`rust-runtime/src/playlist_export.rs` 已拥有规范 CSV/排版/字体/PNG/ZIP；PR `native_host/exports.rs` 另做排序/字段投影，`PlaylistExport.kt` 另做 CSV 与 720px 系统字体位图，和本地 1600px/SourceHan 450/800/QR/自定义时间列契约不等价。建议统一调用 P03 粗粒度 renderer，复用 PR 的场次选择、授权、临时文件清理与下载桥。保留 `HostExports.kt` 的来源限制、Host cookie、SAF 保存/取消反馈及 `static/android-export.js` 的请求关联；不要保留两套导出业务规则。Android 字体资源路径/打包、CSV 全引号及公式前缀、PR 10000 行/64MiB 限制、旧场次名称等差异需在集成时明确处理，不覆盖桌面既定契约。本轮未验证 Android renderer 可用性。 |
| UI / presentation / platform | 同改 `app.js/index.html/remote.js/remote.css/styles.css/i18n.json`；本地 Request workspace/卡片与尺寸修复必须保留。PR 增加 `android-host.*`、`android-playback.js`、`android-platform.js`，还改 split seek/audio-clock、native SSE 恢复、Gatcha 卡片和分页，不能整文件选一侧。复用 Android 的 nativeHost 分支、系统栏/后台生命周期和保存桥，逐块整合共享页面；桌面 presentation/controller 既有冻结接口不退役。 |
| 控制投递 / ACK | 桌面 `AppContext.issue_player_control` 是单槽，ACK 用任意 seq 的高水位。PR `app_state/native_session.rs:475` 的 `native_control` 在锁内校验 item/generation，保留同代 FIFO、上限 16，满时显式 429；`:537` 的 `native_ack` 只移除匹配队首且要求 Host 身份。`native_host/api.rs` 与 `internet.rs` 都调用它。复用这一候选，经现有 Runtime/FFI 接入桌面；不创建第三队列，不为此切换整个桌面 HTTP Host。ACK 重试、旧代清理、队列满错误及身份边界仍需在集成后执行本轮失败测试。PR 源码未执行。 |
| 共享 catalog | PR `native_host/catalog.rs` 已有 D1 查询规划、分页、归一化和 60 秒/48 项缓存，可提为共享 catalog 服务；`catalog_append.rs` 复用既有 Cloudflare append。保留本地 C01 已迁移的 append 调度。PR catalog 明确没有飞书回退、预热和管理 API，不能直接宣称替代整个 Python `lark_pool_client.py`。优先复用，暂停另造共享 catalog 实现。 |
| build / release | `ci-bundle.yml` 的 desktop `bundle` 和 `android-bundle` 各自依赖 test；tag 下 Android 缺正式签名会失败，debug 不冒充 release。`mirror-release-r2` 新的 `needs: [bundle, android-bundle]` 使桌面 **R2 联合镜像** 等待 Android 签名构建成功；桌面 GitHub Release 上传本身不以 Android 为 needs。建议把平台产物发布解耦或明确接受联合镜像依赖，不能靠配置/读取密钥绕过问题。本轮没有接触签名凭据或触发 Actions。 |

双方自 PR base 起共同修改的文件：`rust-runtime/{Cargo.toml,Cargo.lock,src/lib.rs,src/bilibili_service.rs}`、
`rust/src/lib.rs`、`static/{app.js,index.html,i18n.json,remote.js,remote.css,styles.css}`、
`tests/test_search_result_frontend.py`。模块导出/dispatcher 应做增量合并；Cargo 清单合并后统一更新锁文件，
不要用 PR 锁文件覆盖 P03 的 cosmic-text/chrono/csv。P03 `rust-runtime/src/ffi.rs` 的出口保留。

建议 checkpoints：现有 UI/P05/P03 三个提交已经满足分域保存；另行授权后先提交本轮
`test: capture LAN and Internet concurrency baseline`，再从当前 HEAD 建本地
`integration/pr109-p03-p05`，保存范围明确的集成提交与控制/AV 增量修复提交。
这只是建议，本轮未创建分支或任何 commit/amend/stash/push。

## 实测结果与界限

测试入口为 `tests/test_transport_concurrency.py` 和 `tests/live_transport_concurrency.py` + `.js`。
Python 使用实际 AppContext、ThreadingHTTPServer、PlaylistStore、Runtime CFFI；只替换 metadata/search、
cache/update/外部 append 副作用。临时 persistence、合成 BV/标题和相同 `Fixture ID`，不写线上歌曲/评分。
Event/Barrier 明确控制提交和消费顺序；超时只用于防止夹具挂死，不靠随机 sleep。

| 契约 | 证据 |
| --- | --- |
| LAN/Internet 两个 seek 都接受后才消费 | **FAIL**：HTTP 层只取到一个；真实浏览器 +7s/+11s 后只到 11s，期望 18s。 |
| future ACK / duplicate、stale ACK | **FAIL**：未来 seq 隐藏待消费队首。已消费旧 seq、重复 seq、0 不清除新命令：PASS。 |
| 同代 Next / 旧歌控制 | PASS：Internet Next 先接受，两个同代 Host `/next` 并发只推进一次，另一个 stale；旧代公网 seek 拒绝。LAN 接受的旧代命令也由真实 `applyRemotePlayerControl` 拒绝播放应用。 |
| metadata 中的 add/remove/reorder | PASS：add 等待 metadata 时 LAN add/remove/reorder 能提交，旧 revision 的 move 不接受；延迟 add 完成时按最新状态拒绝重复，队列保留正确次序。 |
| search/metadata 与控制 | PASS：FFI 返回 Host I/O effect 后不占状态锁；阻塞查询/metadata 时 pause 可完成。真实 WebRTC bulk 阻塞时 control 设置可完成。 |
| timeout/reconnect/late response | PASS：真实 DataChannel→HTTP→Rust 变更已提交后扣留响应，精确触发客户端请求 timeout，再真实重建 RTC/重新认证，最后释放旧 HTTP 响应；发送变更一次，pending 清空，没有重提。信令重连触发由夹具控制。 |
| absolute vs relative 设置 | PASS：受控同时在途的绝对 key-shift 以后提交者为准；LAN 两个 adjust +50 得到 +100。**FAIL**：公网 adjust 将旧快照换算成 `player.set_av_delay(50)`，覆盖已提交 LAN +50，结果 50 而非 100。 |
| 关闭/重建房间 | PASS：真实 peer close/open、旧 epoch 拒绝、LAN 在关闭期间仍可用；浏览器重建实际 RTC 并重新认证。现有完整 Host 房间 UI 测试另行 PASS。 |

明确分层：JSON decoder/Host dispatch 与 Rust 协议有独立测试；浏览器另用真实
`RTCPeerConnection`、两条 ordered DataChannel、实际 auth/identity/decoder/dispatch/request/ACK。
SDP/房间服务及 metadata 为本地夹具，ICE 无外部 STUN/TURN。视频用 FFmpeg 生成 60 秒 VP8 WebM，
走生产 Range 文件服务。消费函数从当前 `app.js` 原样载入；周围页面/播放器 session 是夹具，
不是完整桌面 playback session 验收。另跑既有完整 Host UI 房间测试弥补页面层范围。
Loopback 不算实体 LAN 或跨网/NAT 验收：手机、Wi-Fi/蜂窝网、TURN/NAT、长时段/后台恢复仍待设备测试。
PR native_host/Android/Kotlin 未在本轮编译运行；FIFO 是否通过这些回归仍是待集成验证的候选。

最终命令与结果（完整输出在 `/tmp/bilikara-pr109-concurrency/`）：

- `BILIKARA_HOME=$(mktemp -d /tmp/bilikara-pr109-final-XXXXXX) BILIKARA_REQUIRE_RUST_LIB=1 python -m unittest tests.test_internet_remote tests.test_internet_remote_frontend tests.test_transport_concurrency -v`：76 项，74 PASS、2 FAIL（seek 丢失、future ACK），`focused-python.log`。
- `python tests/live_transport_concurrency.py --output /tmp/bilikara-pr109-concurrency/browser`：8 组，6 PASS、2 FAIL（seek、AV 增量），`browser/browser-results.json`；测试非零退出保留。
- `python tests/live_host_ui_browser.py --mode internet-remote-host --screenshot /tmp/bilikara-pr109-concurrency/room-ui.png`：PASS，`room-ui.log`；注入 401/503/500 场景外无意外 console/page error。
- `cargo test --manifest-path rust/Cargo.toml --locked internet_remote`：15 PASS，`rust-core-internet.log`。
- `cargo test --manifest-path rust-runtime/Cargo.toml --locked internet_remote`：16 PASS，`rust-runtime-internet.log`。
- `node --check tests/live_transport_concurrency.js`、`python -m py_compile tests/test_transport_concurrency.py tests/live_transport_concurrency.py`、`git diff --check`：PASS。

四个新增文件还分别执行 `git diff --no-index --check /dev/null <文件>`，无 whitespace 诊断
（退出 1 表示新增文件存在差异）；staged 仍为空，HEAD 仍是 `210a574`。

已经目视检查 `browser/host-consumption.png`（实际 0:11，18 秒期望/两个接受/一个投递）、
`browser/remote-connection.png`（认证和两通道状态）与 `room-ui-internet-remote-active-preview.png`（完整 Host 双入口）。
首次夹具 H.264 在当前 Chromium 不支持，改用 VP8；首次 fixture 未启用 Range 导致 seekable=0，
改为生产 `_stream_file(..., allow_ranges=True)` 并断言 seekable 覆盖 60 秒。这两项不计产品故障。
没有生成/修改产品图像；P03 前后图像仍见 `/tmp/bilikara-p03-export/` 原证据。
本轮依赖不变，沿用已有 Playwright/Chromium/FFmpeg，无安装、浏览器下载或运行字体下载。
未重跑全发布门禁：当前是测试/文档基线且故意保留失败；既有 P05+P03 稳定树完整门禁见
`/tmp/bilikara-p03-export/P03-HANDOFF.md`，属于复用，不能据此宣称新增失败测试通过。
Windows/macOS/Android 打包、签名、Actions、生产 Worker 部署全部未执行。

## Sheets 来源与尚留 Python

已针对本地代码/配置/文档、全部已有 Git 历史和 PR 源码搜索
`docs.google.com/spreadsheets`、`script.google.com`、`gviz/tq`、published CSV、Google Sheets/表 ID。
可见的相关邻近 checkout（`/sunhonglin/Kirakara-Show`、`/sunhonglin/kara_ws`）也无可用入口；
未发现信令/曲库 Worker companion checkout。没有读取远端凭据或访问任何表格 URL。

**没有找到可用 Google Sheets 歌曲目录源。** `README.md:97`（来源历史 `b15666b`）只说评分同步备份，
没有表格 URL、sheet ID、歌曲 schema 或查询消费链。真正可定位的歌曲检索回退是
`bilikara/lark_pool_client.py:815` → `:798` → `_search_lark_pool_table`：D1 不可用时访问飞书表，
不是 Google Sheets；配置是同文件的 Lark 应用/表参数，凭据和表标识不在此抄录。
PR `native_host/catalog.rs` 只有 D1 查询，也未提供 Sheets 回退。

本轮没有移除任何生产 Python 责任。P03 已移除 CSV、排序/时间解释、字体/布局/PNG/ZIP，只留适配与 HTTP 保存；
P05 已移除该 DASH/DownKyi 规则，Gatcha/维护 WBI 和 metadata 仍在 Python。
C01 append 调度已归 Rust；共享 catalog 查询/飞书回退/维护尚在 Python，PR catalog 是未集成候选。
登录/Local Remote identity、HTTP/SSE 与控制投递、updater、BBDown/yt-dlp/aria2c/FFmpeg workers、
路径/启动环境与快照持久化仍有 Python 生产职责；PR login/native_session/native_host/preferences/updates/
native_persistence/native_video 是候选，不记为桌面已迁移。T2/T7 冻结参考/公共接口保留决定不变；
build_bundle、测试/构建脚本单列，不充当业务迁移进度。D0 未实现。
已有 ledger 仅能确认 P01/P03/P05、C01、T2/T7 等 ID；其他 P-ID 完整映射原交接缺失，保持 unknown，不杜撰编号。
