bilikara for macOS
首次启动说明

【启动入口】

普通用户请优先双击运行：

bilikara-desktop.app

请完整解压后使用；安装桌面版时只需移动 bilikara-desktop.app。
许可证、第三方源码和说明集中在内嵌 bilikara-backend.app 的 Contents/Resources/license/ 中；
压缩包外层的 license/ 是指向该目录的相对链接，方便直接阅读。

从 Preview 2 升级时，替换完整 App，保留 ~/Library/Application Support/bilikara/。
这个文件夹包含歌单和设置，不只是 WebView 缓存。
从 Preview 1 及更早版本升级时，先关闭旧软件并保留备份。
首次打开新版，检测到旧数据后会询问是否导入；核对来源后点击“导入”。
没有检测到时可正常启动，也可选择其他路径。
已经打开过新版，或旧安装位于其他目录时，关闭软件后，
在完整解压目录中双击“导入旧数据.command”（与 bilikara-desktop.app 放在一起）。
在窗口中确认来源，或选择旧版 runtime / data 文件夹；无需编辑脚本或输入命令。
若新版已有数据，工具会另行确认，完整备份后替换，两份记录不会合并。
导入完成后再正常打开新版；窗口会显示备份位置。
下载完整包：
https://github.com/VZRXS/bilikara/releases


【首次启动被 macOS 阻止时】

如果首次打开 bilikara-desktop.app 时，macOS 提示无法验证开发者，
或提示 Apple 无法检查 App 是否包含恶意软件，请先关闭该提示，然后：

1. 打开「系统设置」→「隐私与安全性」。

2. 向下滚动到「安全性」，找到有关 bilikara 被阻止打开的提示。

3. 点击「仍要打开」。

4. 如系统要求，输入当前账户的登录密码进行确认。

5. 警告再次出现后，点击「打开」即可启动 bilikara。

「仍要打开」选项只会在尝试启动 App 后出现。
完成一次授权后，之后可以正常双击启动。

如果没有看到有关 bilikara 的选项，请再次尝试打开
bilikara-desktop.app，然后重新进入「隐私与安全性」页面。

请仅对从 VZRXS/bilikara 官方 GitHub Releases 下载、
且确认来源可信的发布包执行上述操作。
