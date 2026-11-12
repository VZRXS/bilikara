# Windows 无线投屏开发

在 Windows x64 桌面 Host 的「双屏显示」菜单中打开「无线投屏」，搜索并选择同一局域网的 DLNA 设备。实体观众屏和无线投屏互斥：切换时先结束原输出，再启用新输出。仅打开搜索不接管本地播放。

每次搜索同时使用 Windows 系统 UPnP、UDP 1900 的 SSDP 公告和各网卡的主动查询。系统 UPnP 或 UDP 1900 不可用时仍会主动查询。搜索最多监听 40 秒，验证通过的设备即时出现，可以直接选择。选择设备、关闭投屏开关或切回实体观众屏会结束搜索。

和 Kirakara-App 一样，Windows 桌面端运行期间会保持系统和屏幕唤醒，退出时释放请求。手动睡眠、合盖和电源键仍由 Windows 处理。

需要带 `show_host_set_audience_hud_state` 的 x64 Show（已针对 Kirakara Show `a045213` 验证）。开发时，从启动桌面端的同一 PowerShell 环境指定可信 DLL 的绝对路径：

```powershell
$env:BILIKARA_SHOW_HOST_DLL = 'C:\path\to\libshow_host.dll'
npm run dev
```

未指定时，Host 查找自身可执行文件旁的 `vendor/show-host/libshow_host.dll`。常规构建不会自动下载或加入 Show。需要随 Windows x64 包部署时，将 `libshow_host.dll` 和同次构建生成的 `libshow_host.dll.LICENSES.txt` 放在一个目录中，构建前把绝对目录设为 `BILIKARA_SHOW_HOST_DIR`。xtask 检查架构、导出和依赖后再复制。没有安装组件时，仅无线投屏不可用。

投放后收到 Show 已发送首批 TS 数据的确认，Host 才切到双屏主控布局。Rust AppState 接收现有播放命令；Show 的实际节目状态用于主控进度和自然换歌。关闭投屏后，本地播放从 Show 最后报告的位置和暂停状态恢复。投屏时：

- 待播卡片显示当前歌与后四首。歌名使用主控已有的清理规则，第二栏为点歌人。Show 按自身规则展示浮窗；本分支不发送二维码。
- 进度条为只读的发送端进度。现有前后 15 秒按钮、暂停/继续、下一首和变调交给 Show，不向接收端发 Pause 或 Seek。
- 投屏时先载入当前选中的音轨，以及 P 数最靠前的另一条已缓存音轨。两条已载入的轨可以原地切换。选到其他已缓存分 P 时，Show 在同一个 TS 会话里换入目标轨和正在播的轨，从当前进度继续。这次换入会重新缓冲视频。
- 同一首歌始终按所选视频的时间轴播放。音轨较短时尾部输出静音，音轨较长时播放到视频结尾。跨分 P 的剪辑差异沿用各自的原始时间轴。
- 音画延迟不生效，Host 和 Remote 的控件禁用，后端拒绝此项写入。Show 输出音量上限为 100%，既有本地设置不被投屏本身改写。
- 不显示换歌倒计时。准备好的下一首先尝试预热；未缓存时等待缓存，Show 输出会话仍保持。

Windows x64 的缓存任务同时保存下载的原始音视频轨和本地播放成品。Show 只读原始轨，负责输出 TS；本地播放和退出投屏后的恢复使用普通缓存文件。只有本地成品的旧缓存仍可用于本地播放；投屏时缓存服务会为当前和下一首补齐原始轨，等待期间保持投屏会话。

Rust 负责 SSDP 发现与首次投放；一次投屏保留一个 Show 子进程、一个端口和一条持续 MPEG-TS 输出。自然结束、切歌、切音轨不重新投放 URI。不依赖接收端报告进度或缓冲；已进入接收端缓冲的内容仍按顺序播放，操控效果会晚于发送端状态。投屏断开时先结束 Show 和媒体读取，再收回临时缓存文件名；长时间投屏期间，本场用过的文件仍占用磁盘。

### 验证

在具备原生 MSVC x64 Rust 工具链的 PowerShell 中运行：

```powershell
cargo build --locked --manifest-path rust-runtime/Cargo.toml --features native-host --bin bilikara-desktop-host
cargo test --locked --manifest-path rust-runtime/Cargo.toml --features native-host --lib cast
cargo test --locked --manifest-path rust-runtime/Cargo.toml --features native-host --lib show_dlna
npm run test:frontend
```

用本机构建的 Host、Show DLL 和短小的本地 H.264 MP4 / AAC M4A 测试样本设置以下环境变量，路径均为绝对路径：

- `BILIKARA_TEST_SHOW_HOST_EXE`
- `BILIKARA_TEST_SHOW_DLL`
- `BILIKARA_TEST_SHOW_VIDEO`
- `BILIKARA_TEST_SHOW_AUDIO`

```powershell
cargo test --locked --manifest-path rust-runtime/Cargo.toml --features native-host --lib show_cast_real_dll_advances_over_the_same_http_connection -- --ignored
node --test tests/show_cast_browser.test.mjs
```

三轨回归使用 12 秒视频和三条可区分的音轨。设置 `BILIKARA_TEST_SHOW_TRACK_VIDEO`、`BILIKARA_TEST_SHOW_TRACK_FIRST`、`BILIKARA_TEST_SHOW_TRACK_SHORT`、`BILIKARA_TEST_SHOW_TRACK_LONG` 为对应的绝对路径，短轨约 3.8 秒，长轨超过 12 秒。执行同一 Cargo 测试命令时将用例名换成 `show_cast_real_dll_switches_three_parts_over_the_same_http_connection`。

如需复现原始轨和本地成品不同的场景，可以在自然切歌用例中用 `BILIKARA_TEST_SHOW_NEXT_VIDEO`、`BILIKARA_TEST_SHOW_NEXT_AUDIO` 指定第二首的原始轨，再用 `BILIKARA_TEST_SHOW_NEXT_LOCAL_VIDEO`、`BILIKARA_TEST_SHOW_NEXT_LOCAL_AUDIO` 指定同一首的本地缓存成品。

原生用例会启动实际 DLL 和播放进程，检查自然切歌、同一 HTTP 连接、待播字段与暂停交还。浏览器用例使用真实 Host 页面与受控的输出事件；可用 `BILIKARA_TEST_CHROMIUM_CHANNEL=msedge` 选择已安装的 Edge。两者都不代表特定电视的 DLNA 兼容性或实机缓冲已经验收。
