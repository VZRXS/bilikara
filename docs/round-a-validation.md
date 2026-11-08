# Round A 复核与验证报告

结论：**CONTINUE-VALIDATION**。保持现有 WebView 默认后端；本报告不批准 Round B，也不认定任一原型已满足产品迁移门槛。

## 源代码与隔离

起始 private main：`734aae9b4272346662ae1b899b8dfddb92d6e919`。
本报告最终测量的代码版本：`cd0f47ecc4e284e03de58ee1f9191b81feb30c40`，测量开始时工作区干净。
最后封存只修改文档；实际集成 HEAD、推送结果及代码等价检查记录在外部 `integration-receipt.json`，并在交付消息中给出。

归并后 `feat(media-core)`：`8ffc373fd05cfcb4db0f23b3044fc3727cce6504`；另一个逻辑提交仍为 `research(media-gstreamer)`。
较早的 `fix(playback)`（`5adc6511`）和 `build(ci)`（`f2801e87`）保持原 SHA。原历史、测量版本和归并前草稿保留本地引用与 Git bundle；不改 public。

本次复核中，生产 `static/`、Rust Domain/Runtime、Tauri、Python 和 package 配置与起始版本逐字节一致。默认媒体对、DSP、120/250/100 ms 循环、手动开始回退及 AppState/队列权威均保持原状。两个原型不进入正常产品依赖或打包图。
LegacyPlaybackAdapter 仍只委托既有媒体 owner，保留同步返回值/原 Promise；身份检查、观察者和撤销不产生第二个播放或 Next 状态机。责任分工与完整接口见 [media-backend.md](media-backend.md)。

## 环境与方法

机器 `005ceed2e105`；Linux 6.8.0-138，Threadripper PRO 9965WX、48 逻辑 CPU；nice 19、限定 CPU affinity，全程使用 HDD。
Rust/Cargo 1.97.0、GCC 11.4、Node 24.18.0、ffmpeg 4.4.2；dev 构建。
Chromium 153.0.8010.12、Linux WebKit 26.6。
GStreamer core 1.20.3 / playback plugin 1.20.1，gstreamer-rs 0.23.x。
实际原生解码/输出：`avdec_h264`、`avdec_aac`、`flacdec`、`ximagesink`、`pulsesink`、`GstPulseSinkClock`；F32LE stereo 48 kHz，现有 Signalsmith 延迟 5760 samples / 120 ms。
浏览器 AudioContext 为 44.1 kHz。Chromium/GStreamer 确认软件解码；WebKit 按禁用硬件解码配置运行，但本夹具没有取得实际 decoder 名称。没有物理平台或硬件解码资格认定。

资源比较：相同 720p30 H.264 与独立 AAC、Host 1280×800、Audience 1920×1080、全部 +2 key，三次独立 60 秒测量。显式预热至少 3 秒，录音就绪等待还会延长部分路径的预热；各次实际开始媒体位置和所有边界均保留。
音视频输入 SHA-256 分别为 `661940ce30c918f3eae74ecf4be5af204543af428564e76a51b267e80672e90f`、`0883b15379d7441789b694c6231b80d07c9c52d837cf7b232f2dba716c732553`。
时间码实验另用 640×360/30fps 条码视频与每秒可识别音频脉冲，不能与资源测试的媒体负载混作同一数据。

## 复核项与实际边界

| 项目 | 状态 | 结果 |
| --- | --- | --- |
| P0-A | PARTIAL / BLOCKED | 沿用生产正负号；正延迟插入真实音频等待，负延迟保持视频首帧，不通过向前 Seek 跳过开头。暂停/Seek 重绑捕获输入与 DSP，保留 Context/gain/租约；实际精度见下表，不以公式正确代替 PCM 证据。 |
| P0-B | PASS 调研 / FAIL 当前 SDK 能力 | 独立 AAC/FLAC、容器 StreamCollection/SELECT_STREAMS、Signalsmith 后实际 PCM 均验证。当前 SDK 主视频 Seek 至 12 秒后，auxiliary audio Segment 仍从零开始，PCM 指向源秒 2/3 而非 12..15。不是所有 GStreamer 版本都不支持的结论。 |
| P0-C | 已实现测量，资格仍开放 | 单调时钟往返校准、实际条码/PCM、固定偏差/漂移/恢复分开；80 ms 是虚拟诊断门槛，不是产品单帧或物理口型验收。 |
| P0-D | 已实测 / NOT COMPARABLE 产品总成本 | A0 完整 UI、A1 精简实验页、A2 尚无 Host/UI/IPC 集成；另做相同 A1 有无隐藏视频的受控对比。 |
| P0-E | PASS 所列生产回归 | 默认路径不变；完整 Release gate 和物理平台仍未完成。 |

Audio-First 还修正了 Audience 准备、规范化 program identity、局部 renderer epoch、漂移死区内显式 Seek、过期段与 ended 元素恢复。原生业务 generation 不因这些局部操作改变。
实验夹具的状态上报原可重叠，曾触发 Rust 正确的 `stale_status` 拒绝；现串行、单次在途，并以故意延迟首请求的实际 Host 测试验证。没有放宽 Rust 校验。
首次资源比较因此中止，其原始数据保留，未混入最终均值；记录工具现会先保存指标再断言有效性。

统一录音就绪后，示例中 Chromium 首个 frame 1 约在 Play 返回后 147 ms、零秒 PCM 约 216 ms；WebKit 约 257/287 ms。目标为 +200 ms 时，相应开头相关残差仍约 97/132 ms。首音保留、时钟公式正确不等于实际输出起点已对齐：独立 Audience 的调度/解码启动及普通追赶策略仍需隔离验证。不能以延长等待或跳过开头来宣布修复，也不能直接归咎于 Apple WebKit。

发现录音客户端可能约 1.91 秒后才送回首批 PCM；现必须等实际录音数据就绪才 Play，而非依赖固定短等待。之前未完成此握手的开头“缺失/偏差”数据不能直接归因于播放器。开头门槛还明确要求源零秒 400 Hz 脉冲（pitch 时按倍频还原），不能拿第二个脉冲代替。

GStreamer 修正 DSP 尾部零输入/排空、监测 AppSink 的异步 preroll、CLOCK_LOST 对 Pause 的保持；真实 C ABI 尾段/flush 单测通过。
自定义 Pipeline 验证了 44.1k FLAC 重采样、预加载两音轨切换、signed Sink offset、静音、原生窗口切换和 Rust Next。
但切轨/Seek 组合曾出现 drained EOS 超时，后续成功不能消除该间歇性失败。独立 FLAC/+2、−500/0/+500ms 的额外 EOS 检查均通过，因此不能认定 signed offset 单独导致停滞。
EOS-to-Next 重建 Pipeline 仍有间隙；不是不中断连播。输入 selector 已把 Seek 转发给全部输入，未保留“重复 Seek 非活动输入”的错误修补。
延迟 GstBus EOS 跨 Seek/音轨 generation 的归属仍 **NOT QUALIFIED**：命令身份拒绝通过，不等于所有排队原生事件均已绑定正确 program；这是审查风险，尚未证明是此次停滞的原因。

`suburi` 属性文档写的是下一字幕 URI，但该 SDK 实现也支持 auxiliary audio。结论来自真实 PCM、Segment 和流选择，而不是 setter 成功。参考 [playbin3](https://gstreamer.freedesktop.org/documentation/playback/playbin3.html)、[Stream Selection](https://gstreamer.freedesktop.org/documentation/additional/design/stream-selection.html)、[对应 SDK 源码](https://github.com/GStreamer/gstreamer/blob/1.20.1/subprojects/gst-plugins-base/gst/playback/gstplaybin3.c)。自定义 Pipeline 的预加载切轨不等于任意运行时新资源替换已完成。

## 资源与实际输出

| 场景 | CPU 合计 / 范围 | 峰值 PSS / RSS MiB |
| --- | --- | --- |
| A0 / chromium | 44.10% / 42.71–46.07% | 563.1 / 1248.7 |
| A1 / chromium | 29.02% / 28.38–29.90% | 394.6 / 1046.0 |
| A1-SHADOW / chromium | 35.98% / 34.04–38.33% | 458.4 / 1112.9 |
| A0 / webkit | 100.55% / 99.20–101.99% | 719.1 / 1167.1 |
| A1 / webkit | 52.90% / 52.35–53.25% | 506.2 / 936.3 |
| A1-SHADOW / webkit | 75.66% / 74.86–76.51% | 575.8 / 1009.5 |
| A2 / GStreamer | 21.91% / 21.61–22.16% | 225.6 / 274.7 |

CPU 100% 表示一个逻辑核心。表中为三次均值；内存为各次同时合计峰值的均值，RSS 会重复计入共享映射。各进程组原始 CPU/PSS/RSS 均保存。
A2 总计包含虚拟 Pulse/X server；浏览器总计不包含这些 server。原生 DSP 每 buffer 的分配/复制仍计入实际成本，不能称为优化后的量产引擎。
**这些是整个测试夹具的开销；不是产品同等集成成本，不能发布一个“GStreamer 全产品节省百分比”。**

相同 A1 加回隐藏视频，Host browser CPU 平均增加 Chromium **7.00**、WebKit **23.02** 个百分点；同时合计峰值 PSS 约增加 **64/70 MiB**。Audience CPU 均值基本相近。A2 的 native 进程本身为 **19.63%**，另有 Pulse/X server **0.73/1.56%**；尚无完整 Host/UI/IPC 成本。其 DSP 在约 60 秒记录窗口仍有每 chunk 两次 Vec 分配及输入/输出复制，细数见 comparison-summary.json。

隐藏视频实验包含其采样观察开销；隐藏帧未被合成不等于没有解码。它证明额外视频路径有成本，不证明它是所有平台唯一瓶颈。可见 Audience 的解码/渲染、桥接及尚未实现的原生集成成本必须分别看待。

Chromium 可见视频回调/计数约 30/s，每次可见 dropped 报告 0–2；p95 回调间隔约 50 ms。WebKit Audience 回调约 31.4–31.7/s、p95 33 ms，但校正 Seek 会重置解码计数，出现负首尾差；**解码 FPS 与 dropped 资格未认定**，回调率不等于唯一呈现 FPS。原生 BaseSink rendered 约 29.92–29.94/s、报告 dropped 0；原生逐帧呈现间隔 p95 未取得。

21 次均通过 ≥98% 的 500ms 音调窗口诊断，但这不代表无短中断。独立 5ms RMS 复核：A0 WebKit 在各次采样最初 0.8 秒内有 200–455ms 连续低能量段，说明显式 3s 预热未证明 DSP 完全稳定；不能据此判定实机持续断音。A0/A1 Chromium 各有一次 5ms 低能量窗口；A1 WebKit、Shadow 及原生未见此阈值下的静音窗口。全部 PCM 有限值，不能等同硬件无 underrun。原始数据及时间范围完整保留，没有事后删去这些片段。

## 同步、恢复与长时观测

| 实验（capture-ready） | Chromium | WebKit |
| --- | --- | --- |
| 18s ×3 | 0/3 PASS；开头残差 97.1–229.2ms；各阶段稳态 p95 12.6–128.9ms | 0/3 PASS；开头残差 46.7–132.4ms；各阶段稳态 p95 57.4–290.7ms |
| 初始 −200ms | 0/1 PASS；开头残差 82.1–82.1ms；各阶段稳态 p95 24.1–155.5ms | 0/1 PASS；开头残差 158.5–158.5ms；各阶段稳态 p95 87.2–263.3ms |
| +2 pitch | 0/1 PASS；开头残差 110.7–110.7ms；各阶段稳态 p95 4.9–29.5ms | 0/1 PASS；开头残差 147.6–147.6ms；各阶段稳态 p95 33.7–95.5ms |
| 180s | 0/1 PASS；开头残差 206.6–206.6ms；各阶段稳态 p95 31.4–112.8ms | 0/1 PASS；开头残差 356.4–356.4ms；各阶段稳态 p95 24.8–514.2ms |

上述脚本均以 FAIL/退出码 2 保留失败，不降低 80ms 门槛。最新原生 G8 的自定义 Pipeline/虚拟时间码/真实 Host Next 为 PASS；EOS→Next 观察到约 **978ms** 间隙，连续性仍 NOT QUALIFIED。局部恢复与各段完整数据见对应 JSON。

小时实验确实运行约 60 分钟，使用冻结 source `554e730cf1dd8fb9c63bbdfc33f2bd83c04307c1` 与独立保存的可执行文件。新代码复核同一原始数据：3597 对，平均固定残差 −29.52 ms，p95 绝对残差 40.64 ms，拟合变化约 +25.94 ms/小时。之前的 −0.63 ms 估计依赖不同帧筛选方法，不能据此宣称亚毫秒精度。X11 只有 10 Hz 像素采样、查询 p95 半往返约 5.05 ms，另有视频帧量化；这些仍是虚拟输出诊断。
该连续单轨实验不覆盖后来增加的 Seek 诊断、混合控制可靠性，也不认定物理漂移；旧录音未就绪阶段不作开头验收。
A1 60–120 分钟及所有物理平台音画接受检查：**NOT RUN / DEVICE-UNVERIFIED**，不将未运行记为通过。

## 回归与重现

| 检查 | 实际结果 |
| --- | --- |
| media-core（最终） | PASS 9/9，含两引擎、延迟状态请求、DSP、切轨、Seek/输出/Rust Next |
| frontend / ios-playback | PASS 868 / 43；后者不是 iOS 真机验收 |
| Native Host / Remote sync | PASS 24 / 110；Remote 包含源代码/协议契约检查 |
| queue_ordering_r7 / standard playlist stress | PASS 21 / 9；压力配置另有 **2 ignored**，不作通过 |
| media-output / L1+Native HLS / Pure K output / controller | PASS 5 / 6 / 5 / 3；非物理接收端资格 |
| presentation timing desktop / iOS 配置 | PASS 各 2；浏览器证据 |
| GStreamer fmt/clippy -D warnings、真实 DSP tail/flush 单测 | PASS，单测 1；原生代码随后未变 |
| G8 调研 / 自定义功能与虚拟时间码 / Native Next | PASS；SDK auxiliary Seek 能力仍 FAIL，先前 EOS 超时仍 OPEN |
| Audio-First 精确同步 | FAIL，见上表；粗 450ms 功能检查不替代精度 |
| 完整 workspace/Release gate、Bundle、物理平台、A1 长时 | NOT RUN / DEVICE-UNVERIFIED；历史 gate 问题未宣称解决 |

精确命令、source hash、退出码在外部 command JSON 内。全部经 `CUDA_VISIBLE_DEVICES='' .tmp/local-build-run.sh`，使用 HDD 构建/临时目录；独立 Gst Cargo 另选外部 SDK pkg-config/target，Node Native Host 保持正常 target。
关键入口：`npm run test:media-core`、`test:frontend`、`test:ios-playback`、`test:native-host`、`test:media-output`、`test:purek-l1`、`test:purek-output`、`test:purek-controller`、`test:remote-sync`、`test:playlist-stress`；`cargo test --manifest-path rust-runtime/Cargo.toml --locked --test queue_ordering_r7`；presentation timing browser test 的 desktop/iOS 两种配置。
实验入口为 `validate-audio-first-round-a.mjs`、`validate-gstreamer-round-a.mjs`、`validate-media-timing.mjs`（18s×3、180s、native 3600s，另测 −200ms 初始值和 +2 pitch）及 `compare-media-round-a.mjs`（60s×3、+2、a0/a1/a1-shadow/a2）。SDK、输入、二进制和输出路径均显式记录。


## 文件与责任

- `research/webview-audio-first/audio-first.js`：开头/重绑/本地段、保持隔离；`tests/media_round_a_*`：真实 Host、Audience、生产基线及回归。
- `research/media-gstreamer/src/{main,playbin_probe,surface}.rs`：真实 DSP、流选择、Segment/clock/EOS 与 X11 输出观测。
- `research/{av-timing,pcm-observer,linux-sampler,decoder-observer}.mjs`：实际 PCM/画面、单调校准、进程组及解码事实。
- `scripts/{compare-media-round-a,profile-playback,validate-*-round-a,validate-media-timing}.mjs`：可重现比较和失败门槛；本报告、backend/performance 文档及研究 README：契约和资格边界。

## 交付与下一步

原始 PCM、条码、日志、失败尝试、版本、SHA-256 清单和可恢复 Git bundle 均保留在机器 `005ceed2e105`：
`/sunhonglin/bilikara_bundles/round-a-review-20261108-201534/`，位于源码仓库外。
主要索引为 `comparison-summary.json`、`pcm-continuity-summary.json`、`ready-validation-commands.json`、`long-native/reanalysis-current.json` 和 `integration-receipt.json`；各次 metadata/source-snapshot 是实际加载代码的权威记录，不把驱动结束时的 HEAD 倒算成早先测量的 source。

R8 映射：MEDIA-ARCH-01/02/06/07 的权威、最小接口、隔离/回退为 SOURCE-CONFIRMED / targeted BROWSER-TESTED；03/04 仍为候选和实验证据；05 的精确同步、连续输出门槛仍 OPEN。这里只测 P0-PERF-01 和相关 MEASURE，不宣告整个 §20 完成。

原生 Linux PoC 的播放/EOS 不依赖 WebView 的 play()/AudioContext.resume()，只证明架构边界；没有验收 Apple AVAudioSession、系统中断/路由/前后台、AirPlay 或 macOS 输出生命周期。Android/Windows/iOS/macOS 产品及硬件解码、设备最低配置均不能由这组软件实验推定。
下一步限于：复现混合控制 EOS 并按 Segment/时钟定位、验证排队原生 EOS 归属与不中断 Next、提高实际帧/PCM 时钟观测精度并复验 Apple 路径；可在独立 SDK 对照中验证 auxiliary Seek 是否已修复。保留 Legacy，暂不进入 Round B 或打包 GStreamer。
