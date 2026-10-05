# 升级说明

从 **v0.8.0-preview.2 及更早版本** 升级，请下载完整包；这次过渡不使用旧版本的软件内更新。

1. 关闭旧软件，备份数据。
2. 从 [Releases](https://github.com/VZRXS/bilikara/releases) 下载对应系统与架构的完整包，解压到新文件夹。

**从 Preview 2 升级：**

- **Windows**：把旧版整个 `runtime` 文件夹复制到新版，与 `bilikara-desktop.exe` 放在同一级，再打开新程序。
- **macOS**：替换完整的 `bilikara-desktop.app`，保留 `~/Library/Application Support/bilikara/`，再打开新程序。这个文件夹包含歌单和设置，不只是 WebView 缓存。

**从 Preview 1 及更早版本升级：**

关闭旧软件，首次打开新版时会检查已知的旧数据位置；检测到后，确认来源并点击「导入」。没有检测到时直接正常启动。

旧安装在其他位置，或已经打开过新版，也可以关闭软件后双击导入工具：Windows 为 `导入旧数据.cmd`（与 `bilikara-desktop.exe` 同一级），macOS 为 `导入旧数据.command`（与 `bilikara-desktop.app` 同一级）。在弹出的文件夹选择窗口中选择旧版 `runtime` 或 `data`；不用编辑脚本或输入命令。

导入保留旧版已保存的歌单、历史和分场记录，旧文件保留。若新版已有数据，工具会另行询问：确认后先完整备份当前数据，再导入旧记录，两份记录不会合并。完成后打开新版，媒体会重新缓存，Remote 设备需要重新登记。
