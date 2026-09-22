bilikara for macOS
首次启动说明

【启动入口】

普通用户请优先双击运行：

Bilikara-Desktop.app

压缩包中的 bilikara.app 是指向 Bilikara-Desktop.app 内嵌原生后端的相对符号链接，
用于命令行诊断及显式旧数据导入，不是第二个桌面启动入口。
请完整解压后使用；安装桌面版时只需移动 Bilikara-Desktop.app。
后端命令位于 Contents/Frameworks/bilikara-backend.app/Contents/MacOS/bilikara-desktop-host。
程序不需要 Python。原生数据保存在 ~/Library/Application Support/bilikara/native。
若检测到旧数据，启动提示会要求显式导入到新的独立目录；不会覆盖旧数据。
导入及构建命令见 docs/native-desktop.md。


【首次启动被 macOS 阻止时】

如果首次打开 Bilikara-Desktop.app 时，macOS 提示无法验证开发者，
或提示 Apple 无法检查 App 是否包含恶意软件，请先关闭该提示，然后：

1. 打开「系统设置」→「隐私与安全性」。

2. 向下滚动到「安全性」，找到有关 Bilikara 被阻止打开的提示。

3. 点击「仍要打开」。

4. 如系统要求，输入当前账户的登录密码进行确认。

5. 警告再次出现后，点击「打开」即可启动 Bilikara。

「仍要打开」选项只会在尝试启动 App 后出现。
完成一次授权后，之后可以正常双击启动。

如果没有看到有关 Bilikara 的选项，请再次尝试打开
Bilikara-Desktop.app，然后重新进入「隐私与安全性」页面。

请仅对从 VZRXS/bilikara 官方 GitHub Releases 下载、
且确认来源可信的发布包执行上述操作。
