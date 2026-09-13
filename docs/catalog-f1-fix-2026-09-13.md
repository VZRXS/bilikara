# Catalog F1 修复记录（2026-09-13）

状态：**F1 已修复，本地 23 阶段门禁全部 PASS，待独立复审**。
批次评审原结论未覆盖，F2 仍未处置。

本轮基于 `work/v0.8.0` / `3f3d5a12efd3b36501fe2d6cf67e70bb00a5f3ae`
的实际未提交整合树，仅修复 [批次评审](batch-review-2026-09-13.md) 的 F1。
P05/P03/UI/并发的既有 PASS 结论不重开；本轮不修改 Android 签名或 R2 发布工作流。

## 修复与归属

Rust 的 Sheets `fetch()` 现在使用独立的 `SNAPSHOT_TIMEOUT = 20 秒`，
涵盖建立连接、接收响应和读取 CSV 响应体；不再使用 `CatalogRequest.timeout_ms`。
该字段继续只控制原有 D1 读取预算，Python 搜索仍为 2 秒、其他读取预算保持原样。
快照 32 MiB / 100,000 行上限、60 秒 TTL、30 秒失败退避、AppState 锁外解析不变。
20 秒是 HTTP 超时，CSV 解析仍由既有输入大小和行数限制约束。

新增真实 Python → FFI → Rust → loopback HTTP 回归：D1 立即返回 503，
Sheets 延迟 3 秒才返回 CSV；在 D1 搜索预算 2 秒下应成功获得 Sheets 结果，
第二个关键词复用同一快照，总共只有一次 D1 请求和一次 CSV 请求。
未打桩 Rust 请求、未访问生产读写端点。

- 修复前同一测试 FAIL：约 2.014 秒，`catalog_providers_unavailable`。
  日志：`/tmp/bilikara-f1-before.log`。
- 修复后同一测试 PASS：约 3.014 秒，返回 Sheets 结果并复用快照。
  日志：`/tmp/bilikara-f1-after.log`。

本次修改文件：

| 文件 | 分类 |
| --- | --- |
| `rust-runtime/src/shared_catalog/sheets.rs` | Rust HTTP 服务预算；唯一生产行为修复 |
| `tests/test_shared_catalog.py` | Python 本地传输回归夹具；不增加 Python 业务策略 |
| `docs/catalog-f1-fix-2026-09-13.md` | 本次范围、验证与限制记录 |
| `docs/catalog-rust-local-migration.md` | 仅追加实现者修复跟进，保留独立评审原文 |

## 验证

完整门禁日志目录：`/tmp/bilikara-catalog-f1-validation/`，阶段索引为 `results.json`。
命令运行器：`python /tmp/bilikara-catalog-f1-validation/run.py`。
测试环境：`BILIKARA_REQUIRE_RUST_LIB=1`、`TZ=Asia/Tokyo`、
`BILIKARA_HOME=/tmp/bilikara-catalog-f1-validation/fixture-home`。
测试阶段的 HTTP/HTTPS/ALL_PROXY（大小写）使用拒绝连接的 `http://127.0.0.1:1`，
NO_PROXY（大小写）仅放行 localhost/127.0.0.1/::1；原生 HTTP 探针使用其自身拒绝代理。

定向命令（仓库根目录）：

- `cargo fmt --manifest-path rust-runtime/Cargo.toml`：PASS。
- `cargo build --manifest-path rust-runtime/Cargo.toml --release --locked`：PASS。
- `BILIKARA_REQUIRE_RUST_LIB=1 BILIKARA_HOME=/tmp/bilikara-f1-fixture HTTP_PROXY=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1 ALL_PROXY=http://127.0.0.1:1 NO_PROXY=localhost,127.0.0.1,::1 python -m unittest tests.test_shared_catalog.SheetsFixtureTest.test_snapshot_refresh_has_independent_budget_from_d1_search -v`：修复前 FAIL；修复后 PASS（3.014 秒）。

## 状态与限制

这是实现者的修复与本地验证记录，不代替独立复审。F2 的桌面 R2 / Android 发布耦合未修改；
即使配置 Android 签名，Android 构建失败仍可能阻断 R2，因此密钥配置不能算作 F2 的修复。
没有生成密钥、读取已有密钥、配置 GitHub secrets、签名、触发工作流或部署。

本轮为 Linux x86_64，本地 CSV 夹具不验证生产快照体积/发布节奏或外部删除同步，
也不替代 Android/Windows/macOS 实体设备、打包运行与跨网验收。
Python/Rust 已有条件跳过/忽略的具体原因见原 catalog 迁移报告；本轮保持这些断言与条件。

本次 Commit：无（SHA/消息不适用）。Amend/stash/push/部署：无。

## 完成本地门禁记录

全部 23 阶段 exit 0；本轮 npm build 无需重试。

| 工作目录（仓库相对） | 实际命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| `rust` | `cargo fmt --check` | PASS (exit 0) | `rust-fmt.log` |
| `rust` | `cargo clippy --all-targets --locked -- -D warnings` | PASS (exit 0) | `rust-clippy.log` |
| `rust` | `cargo test --locked` | PASS (exit 0) | `rust-test.log` |
| `rust` | `cargo build --release --locked` | PASS (exit 0) | `rust-build.log` |
| `rust-runtime` | `cargo fmt --check` | PASS (exit 0) | `rust-runtime-fmt.log` |
| `rust-runtime` | `cargo clippy --all-targets --locked -- -D warnings` | PASS (exit 0) | `rust-runtime-clippy.log` |
| `rust-runtime` | `cargo test --locked` | PASS (exit 0) | `rust-runtime-test.log` |
| `rust-runtime` | `cargo build --release --locked` | PASS (exit 0) | `rust-runtime-build.log` |
| `src-tauri` | `cargo fmt --check` | PASS (exit 0) | `src-tauri-fmt.log` |
| `src-tauri` | `cargo clippy --all-targets --locked -- -D warnings` | PASS (exit 0) | `src-tauri-clippy.log` |
| `src-tauri` | `cargo test --locked` | PASS (exit 0) | `src-tauri-test.log` |
| `src-tauri` | `cargo build --release --locked` | PASS (exit 0) | `src-tauri-build.log` |
| `.` | `python -m unittest discover -s tests -v` | PASS (exit 0) | `python-tests.log` |
| `.` | `python -m compileall -q bilikara` | PASS (exit 0) | `python-compileall.log` |
| `.` | `python -m py_compile start_bilikara.py build_bundle.py` | PASS (exit 0) | `python-entrypoints.log` |
| `.` | `npm ci` | PASS (exit 0) | `npm-ci.log` |
| `.` | `npm run build` | PASS (exit 0) | `npm-build.log` |
| `rust-runtime` | `cargo clippy --all-targets --features native-host --locked -- -D warnings` | PASS (exit 0) | `runtime-native-clippy.log` |
| `rust-runtime` | `cargo test --features native-host --lib --locked` | PASS (exit 0) | `runtime-native-lib-test.log` |
| `rust-runtime` | `cargo build --features native-host --example native_host_alpha --locked` | PASS (exit 0) | `runtime-native-example.log` |
| `.` | `python -m tests.run_catalog_native` | PASS (exit 0) | `native-catalog-fixture.log` |
| `.` | `python tests/run_native_host_http.py` | PASS (exit 0) | `native-http-fixture.log` |
| `.` | `git diff --check` | PASS (exit 0) | `diff.log` |

测试计数：Rust core 218 passed；Runtime 212 passed / 15 ignored；
native-feature Runtime 257 passed / 15 ignored；Tauri 77 passed；
Python 1,617 项（1,602 passed / 15 skipped）；native catalog 2 passed；
既有 native HTTP fixture 1 passed。既有跳过/忽略原因未变，本轮未省略门禁命令。

本轮构建仍有 Tauri `.app` bundle identifier 与复用二进制 `__TAURI_BUNDLE_TYPE`
marker 警告，已存在于上次门禁记录；构建退出成功不代表验证了打包 updater。
已生成的 deb/rpm/AppImage 仅为本地门禁产物，未发布或部署。
文档完成后另执行 `git diff --check`：PASS。

---

> **独立复审页脚（2026-09-13，评审者追加，未修改上方原文）**
> 本文档的「待独立复审」到此关闭：**F1 复审通过**。
> 评审者以首轮同一组 loopback 探针独立复验：3 秒 CSV 在 2 秒 D1 搜索预算下
> 现于 3.01 秒成功返回 `source: sheets`；21 秒 CSV 仍在 20.01 秒失败（上界有效）；
> D1 延迟 3 秒且关闭 Sheets 时仍在 2.00 秒失败（D1 预算未被一并放宽）。
> 另以阻塞的 Sheets 快照复验：更长的刷新窗口未把 AppState 权威锁握在网络等待里。
> F2 已由用户决策确认为有意的发布策略，认定撤回，工作流无需修改。
> 批次结论已更新为 `BILIKARA_LOCAL_BATCH_REVIEW_PASS`，
> 详见 [批次独立评审记录](batch-review-2026-09-13.md) 的「复审更新」。
> 平台与设备验收仍未执行，PASS 不涵盖这两项。
