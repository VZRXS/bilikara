# 升级说明

从 **v0.8.0-preview.2 及更早版本** 升级，请下载完整包；这次过渡不使用旧版本的软件内更新。

1. 关闭旧软件，备份数据。
2. 从 [Releases](https://github.com/VZRXS/bilikara/releases) 下载对应系统与架构的完整包，解压到新文件夹。

**从 Preview 2 升级：**

- **Windows**：把旧版整个 `runtime` 文件夹复制到新版，与 `bilikara-desktop.exe` 放在同一级，再打开新程序。
- **macOS**：替换完整的 `bilikara-desktop.app`，保留 `~/Library/Application Support/bilikara/`，再打开新程序。这个文件夹包含歌单和设置，不只是 WebView 缓存。

**Preview 1 及更早版本**使用旧数据格式，复制 `runtime` 不会自动恢复记录。旧格式导入另行完善，请先保留旧软件和数据备份。
