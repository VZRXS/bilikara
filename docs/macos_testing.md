# macOS 开发包验收

适用于 CI 生成的原生 `bilikara-desktop.app`。现有包使用 ad-hoc 签名，没有 Developer ID 或 Apple 公证；`codesign` 校验通过不代表 Gatekeeper 信任。正式公开发布和开发包验收是不同环节。

## 完整解压与校验

下载与本机架构对应的完整 ZIP，保留 `dist_release/` 包装、`license/`、`README-macOS.txt` 及相对链接。唯一桌面入口是 `bilikara-desktop.app`；Host 和 updater 嵌在 `Contents/Frameworks/bilikara-backend.app`，不是第二个供用户启动的 Python 应用。

在解压目录运行：

```sh
codesign --verify --deep --strict --verbose=4 bilikara-desktop.app/Contents/Frameworks/bilikara-backend.app
codesign --verify --deep --strict --verbose=4 bilikara-desktop.app
cargo run --manifest-path /absolute/checkout/xtask/Cargo.toml --locked --target host-tuple -- verify-native-desktop /absolute/extracted/bilikara-desktop.app/Contents/Frameworks/bilikara-backend.app/Contents/MacOS/bilikara-desktop-host
```

最后一条需要仓库构建环境，并使用隔离数据检查实际包；它不会修复或重新签名待验收包。CI 还检查架构、依赖、归档解压往返与独立原生启动。手动验收保留这些门槛，不能仅确认文件存在。

## 启动与数据

尝试打开 App，再按「系统设置 → 隐私与安全性」中的提示允许。仅对已确认来源、签名完整的**自己的开发包**，可以移除隔离属性再测试：

```sh
xattr -dr com.apple.quarantine /absolute/trusted/bilikara-desktop.app
open /absolute/trusted/bilikara-desktop.app
```

此步骤不能代替公证，也不应批量作用于无关目录。首次测试使用独立的绝对 `BILIKARA_NATIVE_DATA_DIR`；升级时按 [升级说明](upgrading.md) 保留已有数据，不向签名 App 内写入用户数据。

检查 Finder 启动、退出后 Host 回收、再次打开、上一场选择、播放/切歌/音轨、Remote、导出和窗口状态。双屏必须使用系统扩展模式并在实际显示器上验证；浏览器截图不能代替此项。

启动诊断在 `~/Library/Application Support/bilikara/data/logs/desktop-startup.log`（或所选隔离数据根的 `logs/`）。日志记录启动与握手失败的受限信息，不应公开附带完整数据目录、cookies 或认证令牌。安装 / 重启失败时保留更新日志与恢复目录，先查明结果再清理。
