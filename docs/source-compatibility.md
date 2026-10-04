# Source 开发与兼容边界

桌面产品从 Preview 2 起使用原生 Rust Host。`start_bilikara.py`、`server.py`、`python -m bilikara` 仍是受支持的 Source 入口：它们围绕 Rust AppState 提供 HTTP / SSE 与 FFI 传输，保留 yt-dlp 编排和显式媒体 CLI 兼容路径。它们不是原生桌面包、构建器或解压包验收的依赖。

Rust AppState 初始化是启动条件，没有整场应用的 Python 状态回退。新的后端与业务功能仍由 Rust 实现；保留的旧纯工具回退不能扩展成新的 Python 业务副本。共享 Rust API、JNI 和媒体 C 接口也不能仅因 Python 调用减少而删除。

## 保留的纯工具能力

`bilikara.rust_backend` 保留以下独立检测的旧兼容能力，`tests/test_native_utility_release_gate.py` 以独立列表检查文档、导出符号、实际库与失败语义：

```text
title_cleanup
safe_filename
normalize_version_tag
version_tuple
version_sort_key
normalize_machine_arch
asset_tokens
asset_has_windows
asset_has_macos
asset_has_linux
asset_has_x64
asset_has_arm64
asset_has_universal
release_list_api_from_latest
format_download_proxy_url
is_downloadable_archive
```

这些旧纯工具的缺失符号只禁用对应能力。库缺失、ABI 不兼容、空指针、无效 UTF-8、调用异常或明确失败标记使用原有的冻结兼容实现；这不适用于 AppState 或 Rust 专属业务服务。Source / FFI 的 CI 使用 `BILIKARA_REQUIRE_RUST_LIB=1`，要求实际加载当前库。

可选解析的 `(True, value)` 表示成功结果，`(True, None)` 表示语法被正常拒绝，`(False, None)` 才表示调用未完成。归档识别的 `1` / `0` / `-1` 分别表示真、合法假与失败。资产词元使用排序后的 ASCII 换行列表，空列表是成功结果；不能把正常空值或拒绝结果误当成回退条件。

## 继续退休的条件

先保留 Source 路由、负面与恢复检查的有效覆盖，再替换调用者和删除源文件。当前 Python 的明确消费者是 Source HTTP / FFI、yt-dlp / 媒体 CLI、源启动器及其兼容测试；第三方重建工具链和 AWS CLI 的解释器依赖另行标注。原生桌面与各构建 / 验证命令见 [原生桌面](native-desktop.md)，产品阶段见 [路线图](version-roadmap.md)。
