# Source 开发与兼容边界

桌面产品从 Preview 2 起使用原生 Rust Host。Source 开发统一使用 `python -m bilikara`：它围绕 Rust AppState 提供 HTTP / SSE 与 FFI 传输，保留 yt-dlp 编排和显式媒体 CLI 兼容路径。它不是原生桌面包、构建器或解压包验收的依赖。

在仓库根目录运行：

```bash
python -m bilikara
# 保留不打开浏览器、后台运行、绑定地址和端口的启动选项
python -m bilikara --no-browser --headless --host 127.0.0.1 --port 8080
```

`start_bilikara.sh` 继续作为 POSIX 便捷入口。需要记录启动日志时，在仓库根目录运行 `bash scripts/start_debug_log.sh`，Windows 使用 `scripts\start_debug_log.bat`；它们也调用同一个模块入口。根目录重复的 Python 启动脚本已删除，实际的 `bilikara/server.py` Source 后端继续保留。

Rust AppState 初始化是启动条件，没有整场应用的 Python 状态回退。新的后端与业务功能仍由 Rust 实现；保留的旧纯工具回退不能扩展成新的 Python 业务副本。共享 Rust API、JNI 和媒体 C 接口也不能仅因 Python 调用减少而删除。

Source 的 `--tool-smoke` 保留 `native`、`bbdown`、`aria2c`、`ffmpeg`、`media-routing` 和 `no-media-cli`。只针对旧 PyInstaller 包的 `libav-package`、`windows-libav-preview` 及 `media-libav/windows-smoke.ps1` 已移除；旧参数会在启动前被拒绝，不会转成构建或下载。当前原生包使用 `xtask verify-native-desktop`，媒体比较使用 `npm run test:media`，它们不需要旧包内的 Python、FFmpeg CLI 或私有测试程序。

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

只在能消除具体的重复或过时维护路径、保留有效覆盖，而且不拖慢开发反馈或增加诊断负担时继续退休。简单的 Python 适配器和测试可以长期保留。当前 Python 的明确消费者是 Source HTTP / FFI、yt-dlp / 媒体 CLI、源启动器及其兼容测试；第三方重建工具链和 AWS CLI 的解释器依赖另行标注。原生桌面与各构建 / 验证命令见 [原生桌面](native-desktop.md)，产品阶段见 [路线图](version-roadmap.md)。
