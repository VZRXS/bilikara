# 升级说明

从 **v0.8.0-preview.2 及更早版本** 升级，请下载完整包；这次过渡不使用旧版本的软件内更新。

1. 关闭旧软件，备份数据。
2. 从 [Releases](https://github.com/VZRXS/bilikara/releases) 下载对应系统与架构的完整包，解压到新文件夹。

**从 Preview 2 升级：**

- **Windows**：把旧版整个 `runtime` 文件夹复制到新版，与 `bilikara-desktop.exe` 放在同一级，再打开新程序。
- **macOS**：替换完整的 `bilikara-desktop.app`，保留 `~/Library/Application Support/bilikara/`，再打开新程序。这个文件夹包含歌单和设置，不只是 WebView 缓存。

**从 Preview 1 及更早版本升级：**

关闭旧软件，双击新版完整解压目录中的导入工具：Windows 为 `导入旧数据.cmd`（与 `bilikara-desktop.exe` 同一级），macOS 为 `导入旧数据.command`（与 `bilikara-desktop.app` 同一级）。

工具会弹出窗口，自动寻找旧版 `runtime` 和系统中的 bilikara 数据目录。确认显示的来源后点击「导入」；没有找到时，会弹出系统的文件夹选择窗口，在其中选择旧版的 `runtime` 或 `data` 文件夹。需要换位置时点击「选择其他位置」。**不用编辑脚本，也不用打开终端、输入路径或拖拽文件夹。**

导入会保留已保存的歌单、历史和分场记录；原文件保留，原地转换时另存备份。已有新版记录不会被覆盖或合并。完成后正常打开新版，媒体会重新缓存，Remote 设备需要重新登记。
