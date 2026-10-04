# 升级与数据保留

从 **v0.7.2、v0.8.0-preview.1、v0.8.0-preview.2** 过渡到后续原生桌面版本时，使用完整包手动升级。旧 Python 后端不能直接采用当前原生包；Preview 2 虽已采用 Rust 后端，其旧更新器仍有首次过渡限制。新包不能先修复尚未升级的旧更新器。

Preview 3 尚待开发包测试与发布确认；本页不表示该版本已可下载。正式发布后从 [GitHub Releases](https://github.com/VZRXS/bilikara/releases) 下载对应系统与 CPU 的完整包。不要只替换 exe，也不要把新旧程序文件混合覆盖。

## 先备份，再换完整程序

关闭所有 Bilikara 窗口，等待 Host / updater 退出。备份旧安装目录和配置过的外部数据目录。将新包解压到**新的目录**；旧目录先保留，以便回退。

### Windows：从 Preview 2 原生数据迁移

1. 把旧安装旁的整个 `runtime/` 复制到新安装，与 `bilikara-desktop.exe` 同级，**在首次打开新软件之前完成**。不要只复制缓存或某个 JSON 文件，也不要合并两套数据。
2. 如使用自定义数据目录，保留该目录和原覆盖配置；路径位于旧安装内部时，改为指向迁移后的对应位置。既有顶层 `data/` / `updates/` 可随备份保留，不应拿它们覆盖 `runtime/data/`。
3. 启动新目录中的 `bilikara-desktop.exe`，核对显示版本、用户、队列、场次歌单和设置。需要延续原队列时选择「继续上一场」。确认后再更新快捷方式并处理旧目录。

Preview 2 原生数据不需要旧后端导入。不要因为启动出错就删除 `runtime/`；保留原备份与更新恢复目录，先检查日志。

### Windows：从 v0.7.2 / Preview 1 导入旧后端记录

先备份完整旧 `runtime/` 或实际使用的数据根。旧版也可能使用 `%LOCALAPPDATA%\bilikara`；以实际旧目录为准，不能仅凭同名文件夹猜测。

旧格式需要**只读导入到一个尚不存在的新数据目录**，不能把旧文件直接混进已经创建的原生 `runtime/data/`。在新解压的安装目录打开 PowerShell，修改旧目录路径：

```powershell
$env:BILIKARA_NATIVE_DATA_DIR = Join-Path (Get-Location) "runtime\data"
$env:BILIKARA_DESKTOP_RUST_IMPORT_FROM = "D:\旧安装\runtime"
try {
    Start-Process -FilePath .\bilikara-desktop.exe -Wait
} finally {
    Remove-Item Env:BILIKARA_NATIVE_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:BILIKARA_DESKTOP_RUST_IMPORT_FROM -ErrorAction SilentlyContinue
}
```

`runtime/data` 必须尚不存在，其父目录必须存在，且不能与旧源目录重叠。若新包还没有 `runtime/`，先 `New-Item -ItemType Directory -Path .\runtime`。旧源保持不变；支持的记录与设置被导入，媒体重新缓存。之后正常双击新启动器即可，不必每次导入。遇到「已有数据」「导入未完成」或损坏提示时不要删除旧备份或强行合并，按 [原生数据与导入契约](native-desktop.md#data-and-import) 排查。

### macOS

保持新 `bilikara-desktop.app` 完整，包括嵌入的 backend app 与资源链接。关闭旧 App 后用 Finder（或 `ditto`）替换整份 App，保留旧 App 备份。**不要把 backend 拖出来另建第二个应用，也不要把 `runtime/` 塞入 App。**

Preview 2 数据保存在 `~/Library/Application Support/bilikara/`，替换 App 时保留它和任何自定义数据根；无需再导入。v0.7.2 / Preview 1 的旧格式需要显式只读导入，并选择与旧源分离的新原生根，例如启动前设置绝对路径的 `BILIKARA_NATIVE_DATA_DIR` 与 `BILIKARA_DESKTOP_RUST_IMPORT_FROM`，再从终端运行新 App 的 `Contents/MacOS/bilikara`。验证后继续使用同一新数据根；详见 [原生数据与导入](native-desktop.md#data-and-import)。

首次被系统拦截时，先尝试打开，再前往「系统设置 → 隐私与安全性」按系统提示允许。现有开发包采用 ad-hoc 签名，不能当作已通过 Apple 公证；测试步骤见 [macOS 开发包验收](macos_testing.md)。

## 核对后再清理

检查版本、历史与指定场次导出、继续上一场、用户与播放器设置；再用一首有权访问的歌曲检查实际播放。导入旧数据不表示已验证所有账号登录，请需要时重新登录。保持旧目录备份到核对结束，不同时运行两个版本访问同一数据根。Android APK 使用独立的安装 / 数据路径，不套用 Windows `runtime/` 方法。
