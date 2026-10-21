# 纯 K 媒体输出

原生 Host 提供 P0 能力探测、P1 L0 直通、P2 L1 音频处理及 P3 共享播放控制的实验性 MPEG-TS 输出，Android 使用同一 libav/companion。授权、协议探测、实际发送与实机资格是不同的条件；协议声明及模拟房台不能使 `supports_*` 变为真。软件检查和 APK 构建不代替 G0–G4 房台与设备验收。

## 状态与接口

普通 DLNA MediaRenderer 可通过 Host 手动输入设备描述文档的完整 HTTP(S)
地址连接，例如 `http://192.168.1.20:8200/renderer/device.xml`。
`POST /api/purek/prepare` 接受 `{ "url":"设备描述地址或纯 K 二维码链接" }`；
原有 `qr_url` 与二维码图片接口继续只解析纯 K 二维码。新输入返回
`connection_type=dlna/purek`；普通 DLNA 的 `authorization_url` 为 null。
完成准备后仍需显式调用 `/api/purek/connect`，不会扫描或自动连接设备。

普通 DLNA 连接只读取描述、复查设备/服务身份并调用标准 ConnectionManager
`GetProtocolInfo`；不发送纯 K 的 `SetDeviceAuthorization` 或接收器 SSDP
公告。纯 K 路径保留官方授权、登记和撤销。两种方式共用 Rust AppState、
媒体管线和 AVTransport 控制，均不把模拟器通过当作实机认证。描述地址只
接受数值型私有 IPv4，同源服务校验、禁止重定向、响应上限及凭据隔离保持
一致；地址、描述和授权不持久化。缺少 ConnectionManager、AVTransport 或
兼容媒体格式时明确失败或报告不支持，不猜测设备能力。

状态由 Rust `AppState.native_session.purek.output` 独占，随 `/api/state` 和 SSE 发布。`GET /api/purek/state` 同时返回房间连接状态和输出状态。房间接口仅允许 Host，Remote 不可发起登记或能力探测。

房间投影携带父级 Rust native session 的 `revision` 和 `state_epoch`。同一 Host epoch 内，界面拒绝较旧的 API/SSE 投影；Host 重启产生新 epoch 时允许代次重新开始。偏好请求、探测结果和语言切换不能把已完成的操作恢复成旧的 busy 状态。

连接授权与身份复查成功后自动执行 `ConnectionManager:GetProtocolInfo`。`POST /api/purek/output/probe` 接受空 JSON 对象，对已登记房台重试探测；不接受客户端提供的设备或控制地址。未授权返回 409，已有房间操作进行中返回 409。网络请求在 AppState 锁外执行，开始与结束在锁内提交；旧 generation 的回调不能修改新会话或释放新操作的 busy 状态。

`output` schema version 1：

| 字段 | 当前语义 |
| --- | --- |
| `schema_version` | `1` |
| `target_room_id` | 每次授权生成的 128 bit 随机标识；不是房间名称、设备 UDN 或凭据 |
| `generation` | 房间操作代次；重试、断开和失联会使旧结果失效 |
| `status` | `stopped`、`authorized`、`probing`、`unverified`、`unsupported`、`starting`、`streaming`、`paused` 或 `error` |
| `capabilities.has_*` | 已校验描述中的 AVTransport、RenderingControl、ConnectionManager 服务存在性 |
| `capabilities.sink_formats` | HTTP 接收格式的 MIME 与 DLNA profile，不输出原始 vendor 参数 |
| `capabilities.protocol_info_state / protocol_info_error` | `not_checked`、`reported`、`empty` 或 `unavailable`；查询失败保留固定错误码，不把失败改写为空声明 |
| `capabilities.supports_*` | 当前全部 `false`；协议声明不能启用实机能力 |
| `pipeline_level` | 活动实验性管线为 `L0` 或 `L1`，否则为 `null` |
| `offset_mode` | `splice`（默认）或 `gradual`；仅 L1 处理 offset |
| `last_error` | 可本地化的固定错误码，无远端错误正文 |
| `measured_adjust_latency_ms` | `null`，无 G3 实机测量 |

`GetProtocolInfo` 是能力声明查询，不是播放前的授权门槛。已连接且有 AVTransport 的设备返回空 Sink 或查询失败时为 `unverified`，保留空声明与查询失败的区别，允许用户通过现有 DLNA 开关明确发起实验性 H.264/AAC MPEG-TS 试播；不会填入虚构的 `sink_formats` 或把 `supports_*` 改为 true。缺少 AVTransport 仍对应 `unsupported / purek_output_no_av_transport`。非空声明明确只有音频、RTSP、MP4、MPEG-PS 或不兼容音轨时不以未知能力回退绕过格式限制。通配 `*` / `video/*` 按 UPnP 匹配规则可选用实际 MPEG-TS，但不证明设备能播放。

188-byte TS 支持 `video/MP2T` 和 `video/mpeg`（包括 AVC_TS_*_AAC_*_ISO 声明）。不将 192-byte `video/vnd.dlna.mpeg-tts` 冒充成 188-byte TS。DIDL 与 HEAD/GET 使用相同 MIME；接收器声明中的 profile 不会原样反射为本机资源的认证结论。媒体元数据、AVTransport 命令、真实接收端拉流和中断监测继续执行，只有 Play 成功且实际交付媒体后才进入 `streaming`；`qualified` 仍为 false。

探测错误不撤销已成功的房台授权；用户可以试播、重试查询或断开。尚未开始播放的查询失败不显示为“电视输出已中断”。普通 DLNA 可使用经过同源及身份复查的 AVTransport-only 描述；纯 K 仍必须提供 ConnectionManager 并成功完成官方设备登记。断开或连接存活检查失败会清除输出能力与房间标识。输出状态不持久化。所有新业务均由 Rust 实现，Python 源码 Host 不提供此接口的媒体能力。

## 共享输出控制

在 Host 的设置 / Android「我的」中打开房间，完成官方授权和设备连接后，可明确开启“DLNA”开关试用实验性输出；关闭开关返回本地播放。DLNA 模式复用双屏控制台：播放器区域显示后续歌曲报幕，下面沿用同一套播放/暂停、前后 15 秒、进度条、重唱和下一首控件；网络操作进入 Rust 命令 FIFO，不操作已保留的本地媒体节点。Host 的设置、房间弹窗和播放控制台共用此开关，Remote 不管理输出目标。标题后的 i 按钮收纳实验性说明、发送端估计进度的含义和错误详情，简短状态常驻。原有音轨、AV delay、变调和音量控件继续生效。延迟调节模式位于共享输出控件；本地/公网 Remote 将其并入播放设置面板，与音画延迟、音量等模块共用外框、标题样式和分隔线。Host 设置仅显示手动连接入口，整个房间设置只有一层底框，没有自动发现选项或嵌套底框。已启用双屏时需先关闭双屏；返回本地后可继续使用双屏。房间弹窗的引导按识别、授权和连接阶段收纳在同一标题 i 内，简短能力状态跟随房间名；Escape 先关闭说明，再关闭弹窗。卡片保留错误重试；不将授权或软件封装成功显示为实机认证。

`POST /api/player/output` 的 Host 请求 `{ "target":"purek", "experimental":true }` 明确选择实验性 L1 电视输出，`{ "target":"local" }` 明确返回本地。授权与 MPEG-TS 格式检查不构成实机认证。选择保存在当前 Rust AppState 会话，不持久化房台凭据。`/api/state`、SSE 与公网 Remote 的 `media_output` 是共享脱敏投影：目标、状态、待播放意图、发送端估计进度、offset 模式与错误；不包含设备地址、名称、URI 或令牌。`position_source=sender_estimate` 不表示接收端实际出声位置。

输出控制器消费既有经过歌曲/代次验证的播放命令 FIFO。Host/Remote 的播放、暂停、跳转、下一首及既有音轨、变调、音量、AV delay 操作复用当前接口；网络输出接管期间不允许本地播放器认领、发布观测或 ACK 网络命令。本地媒体节点可保留；返回本地通过既有 FIFO 恢复位置和播放意图。旧代次命令被丢弃，旧流回调不影响新流。

未取得 G2/G2b 实机证据时采用 Stop＋新 URI：暂停停止并保存位置；恢复、跳转、重唱及切歌重新准备 IDR 对齐的 L1 流。音轨、变调、增益及 offset 调节继续在原 URI 内处理。沿用歌曲间隔设置；未缓存歌曲和空队列等待，不发送虚构画面或编码视频。仅在生产结束、HTTP 队列排空且房台报告 STOPPED/NO_MEDIA_PRESENT 后自动下一首，并保留 Rust 历史/评分规则。网络或管线失败锁定网络输出并显示错误；只有明确操作才重试或返回本地。

本地 Remote 可 POST `{ "offset_mode":"splice" }` 或 `gradual` 到 `/api/player/output`。公网 Remote 使用经过 typed 协议权限校验的 `output.set_offset_mode`；不提供远程登记、探测或目标选择。Host 独占 `/api/purek/*` 的原有受控实验接口，默认 L0 行为保留；共享输出活动期间拒绝并行手动 start。

## P1 / P2 实验接口

以下 POST 接口沿用 Host 身份与请求保护，Remote 不可调用。请求和响应不接受或暴露媒体文件路径、接收端控制地址或 capability URI。

| 路径 | 请求 | 行为 |
| --- | --- | --- |
| `/api/purek/output/start` | `{"experimental":true,"pipeline":"L1","framing":"close"}` | 从当前已缓存歌曲及播放器观测位置开始；`pipeline` 可省略（L0），`framing` 可省略或为 `chunked` |
| `/api/purek/output/stop` | `{}` | 取消管线、作废旧 URI，然后停止本会话的房台播放；空闲停止不控制房台 |
| `/api/purek/output/pause` | `{}` | 采用暂停方案 B：取消输出并发送 Stop；再次 start 创建新 URI，从当前本地观测位置开始 |
| `/api/purek/output/set_offset_mode` | `{"mode":"splice"}` | `splice` / `gradual`；L1 在原 URI 内生效；活动 L0 拒绝 `gradual` |

start 要求已授权且声明 MPEG-TS/H.264/AAC 兼容格式、当前歌曲缓存就绪、视频 H.264。HEVC 显式拒绝。L0 要求选中音轨为 AAC-LC 单/双声道，offset=0、key shift=0、volume=100 且未静音。其他设置返回 `purek_output_l1_required`，不改写本地设置。L1 显式指定，不自动降级或转码视频；缺少当前 companion 能力时失败。

控制顺序是 Stop → SetAVTransportURI（转义后的 DIDL-Lite）→ Play；只有实际 SOAP Fault 才允许空元数据重试一次，HTTP 错误、重定向或畸形 XML 不触发重试。两级管线均不发送 Pause。输出仅在 Play 接受且实际发送 TS 字节后进入 `streaming`。所有网络操作位于 AppState 锁外；busy 一直保持到 SOAP 操作或失败回滚完成，看到终态但 busy 仍为真时不能重启。

每次会话固定歌曲、缓存版本和节目生命周期。L0 另固定音轨、playback generation 和播放设置；它们变化会取消旧流并报告 `purek_output_context_changed`，需要显式重新 start。L1 接受现有 AppState 的音轨、AV delay、变调、音量/静音更新；音轨选择保留本地 playback generation 原有递增规则，独立的 Rust 输出节目代次仅排除该类选择。切歌、分P、跳转/重唱仍会使两级旧流失效，不自动重启。GetTransportInfo 每两秒检查，连续三次停止/网络失败会收尾；管线结束且房台报告停止为正常结束，其余为 `purek_output_interrupted`。没有拉流、封装失败或失联均显式报告错误，本地/双屏/HDMI 行为保留。

L0 使用进程内 libav 读取只读文件描述符、H.264 Annex B bitstream filter、原音频直通和单个 MPEG-TS muxer，不调用媒体 CLI。视频定位到目标位置之前的关键帧，音频按其源 PTS 对齐；输出按 DTS 交错、重建非负时间轴。拒绝缺失/倒退 DTS、容器声明或包 side data 中的 decoder configuration 变更、加密、损坏包及超过四秒的 GOP；这不是完整视频解码验证。输入源时间限定在正负七天、单包最多 8 MiB；请求定位最多六小时。参数协商是 companion 的 additive ABI，不替换旧探测/重封装 ABI。

封装采用 CBR（两路容器声明码率之和的两倍再加 1 Mbps，声明总码率上限 256 Mbps）、500ms 解码提前量、PAT/PMT 50ms、PCR 20ms、每个视频帧重发表。填充包保证低帧率视频也能满足 PCR 周期；不改动编码内容或源音画偏移。实际产物仍须检查 PCR ≤40ms、表周期 ≤100ms、连续计数器及 A/V 时长。

## L1 音频处理

L1 在同一个 MPEG-TS muxer 中保留 H.264 视频包，音频解码后统一为 48 kHz、f32、stereo，再经过原生 Signalsmith Stretch、增益和 AAC-LC 编码。一个会话只建立一个 192 kbps AAC 编码器，PTS/DTS 由连续输出样本计数产生；参数调整不重建编码器或 URI。编码延迟参与共同时间轴起点计算，结尾仅补齐最后一个 AAC 帧。

每次开始固定并持有当前缓存组的最多两个音源读取租约，接受 AAC、FLAC、E-AC-3、AC-3、MP3、Opus 的本地 MOV/MP4 或 raw FLAC。输入限 8–192 kHz、1–8 声道且布局有效；实际解码、采样率转换、配置改变或损坏检查失败即停止。未缓存的新音轨不会通过客户端路径临时打开。音轨标签与业务选择仍来自 AppState。

- 拼接：在下个 1024 样本边界切换源位置，两个已预热 DSP 声部做 40ms 等功率交叉淡化。
- 渐进：从当前有效 offset 向目标移动，至少三秒，极端调整延长到源消耗速率处于 0.75–1.25；Signalsmith 保持音高。新的调节从当前映射继续。
- 原唱/伴奏切换：预热目标声部，80ms 等功率淡化。淡化期间的快速请求合并到最新 AppState 值，结束后继续处理。
- 变调复用现有 ±6 半音范围，以每秒最多 24 半音接近目标；音量复用现有 0–500% 与静音策略，逐样本斜坡并限制输出峰值。设备 RenderingControl 音量未启用，避免双重增益。

正 offset 表示音频滞后：可听源位置为 `videoSource − offset`，正向调节重复历史、负向调节前移。规格中“正差值跳过”与这个定义相反，故这里沿用现有播放器语义。DSP 的输入位置在可听位置上加 `inputLatency + outputLatency`，并用 outputSeek 预热，匹配 Host 的 `videoTime − offset + pitchDelay`；规格中的减延迟表达式不能直接用于解码输入游标。原生脉冲测试验证稳态补偿，实际房台缓冲另由 G3 测量。

每轨 PCM 历史使用固定 16 秒环形缓冲，覆盖最大正负 5 秒间的切换和解码预读；转换暂存、PCM 读取和每个 DSP 块另有限额。该历史不同于 HTTP 四秒/16 MiB 队列，不随歌曲长度增长。资源在同步调用结束后由分配模块释放；取消、回调 panic、解码失败和网络停止均释放缓存读取租约、DSP 声部、编码器、解码器、resampler 与 descriptor。参数只从 Rust AppState 获取；这些缓冲不拥有第二套用户设置。

原生 Stretch 固定到与前端相同的 1.3.2 提交，Linear 固定为 0.6.6；源码、MIT 许可及逐文件 Git blob/SHA-256 位于 `media-libav/signalsmith/`。使用 C++17 编入 companion，无 Web Audio / AudioWorklet 移植，无新增 FFT 动态依赖。旧媒体 ABI 保留，L1 另按结构大小和 schema 协商。

## Android 统一方向

Android APK 使用 NDK 构建同一 libav/companion 与原生 DSP，复用 L0/L1 的时间轴、重采样、AAC 和 TS 实现，并接入现有媒体适配器。启动仅从系统提供的应用 nativeLibraryDir 加载，独立校验 L0/L1 ABI；缺库或不兼容会明确失败。保留 WebView 本地播放及既有 Rust 容器兼容路径，不维护独立 MediaCodec 编码器与 Rust TS muxer。

| 方面 | 原有 Android | 统一 libav 后的媒体输出 |
| --- | --- | --- |
| 文件处理 | Rust MP4/FLAC 处理，不加载 libav | 可共享已验证的 libav 解码/重封装适配器 |
| L1 / TS 发送 | 尚未提供 | 复用桌面 AAC、DSP、采样时钟与 TS muxer |
| 本地显示和播放 | WebView 的媒体元素 | 继续使用现有路径，无需一并替换 |
| 原生依赖 | 无 libav/C++ DSP 载荷 | 增加各 ABI 的媒体库、companion 和 C++ runtime |
| 性能验收 | 现有 Android 播放检查 | 另测软件音频编码/DSP、持续网络、后台、温度及电池 |

此选择增加各 ABI 的原生库、C++ shared runtime 和构建/升级工作；AAC 软件编码的 CPU、发热与耗电需真机对照，不能由桌面或交叉编译结果推断。接入须完成 ELF 与 APK 的 16 KiB 对齐、动态依赖/许可闭包、实际 APK 运行、前台服务/Wi-Fi 与后台限制等独立验收。Gradle 与 xtask 按选定 ABI 构建/检查原生闭包，APK 带许可与完整重建源码包；上游 C 缓存独立于 companion 与应用源代码。Android 编译和 APK 产物仍不替代 G3/G4、实际设备后台、温度和耗电验收；能力标记继续保持实验状态。

## 网络与隐私边界

设备描述只来自二维码校验后的私有 IPv4 地址。三个媒体服务的 controlURL 和 URLBase 必须与该描述同源；拒绝外部地址、不同端口、URL 凭据、query/fragment、重复或无效版本的服务。授权后的身份复查同时比较所有媒体服务地址。

探测使用授权时选择的本机网卡，不跟随 HTTP 重定向，不向 `GetProtocolInfo` 发送房间 Token。SOAP 响应必须是唯一的匹配命名空间的 `GetProtocolInfoResponse`，包含各一个 `Source` 与 `Sink`；拒绝 Fault、DTD、嵌套伪造字段及过大响应。HTTP 正文限制 1 MiB，Sink 限制 64 KiB 和 128 项，XML 节点数限制 8192。

媒体端点绑定接收端可达的本机 IPv4 和系统临时端口，每次 start 使用新的 128 bit 随机 capability。仅授权接收端源 IP 可访问；其他 IP 返回 403 并只累计计数，不记录 URL。URI 不出现在状态投影或日志中，取消后监听器和已连接发送线程结束。最多四条并发探测连接、一个 GET 消费者，请求头上限 8 KiB/两秒。

HEAD 与 GET 返回相同媒体头；无 Content-Length，Range 统一返回 200 全流，`Content-Type` 使用本次选定的 `video/MP2T` 或 `video/mpeg`，DLNA Streaming 头。支持 close 和 chunked 两种分帧用于 G2 比较。发送按时间轴一倍速、每条连接开头最多两秒突发；队列同时受四秒跨度和 16 MiB 限制，满时可取消地暂停生产，单 GOP 同受 16 MiB 限制。重连只从下一个未发送的关键帧开始，丢弃此前非关键帧，不重放旧数据。

设备地址、控制地址、UDN、二维码链接、Token 和原始协议响应不得写入验证记录、截图或测试日志。设备型号、固件与经过脱敏的网络拓扑可记录；不要附带门店名称、房间编号或无关局域网地址。

## 验证

在仓库根目录执行：

```sh
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked purek:: --lib
cargo clippy --manifest-path rust-runtime/Cargo.toml --features native-host --all-targets --locked -- -D warnings
npm run test:purek
npm run test:media-output
# 先用已准备的、当前平台 libav prefix 构建包含 live_ts.c、live_audio.c 和原生 Signalsmith 的 C/C++ companion。
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-companion --prefix /absolute/prefix --out /absolute/owned-companion --test
BILIKARA_TEST_LIBAV_COMPANION=/absolute/owned-companion/libbilikara_media_libav.so npm run test:purek-output
BILIKARA_TEST_LIBAV_COMPANION=/absolute/owned-companion/libbilikara_media_libav.so npm run test:purek-l1
BILIKARA_TEST_LIBAV_COMPANION=/absolute/owned-companion/libbilikara_media_libav.so npm run test:purek-controller
```

以上路径示例用于 Linux；macOS/Windows 分别使用当前平台的 dylib/DLL 绝对路径。缺少实际 companion 必须失败。P1 测试显式执行两个需外部输入的 Rust 测试：真实 libav 管线与独立进程内 TS 探测，以及实际隔离 NativeHost 连接 Node MediaRenderer。Node 另行解析真实 TS 的 DTS/PCR、PAT/PMT、计数器、ADTS 帧及音画时长；它不代替产品管线或 AppState。HTTP 测试覆盖访问范围、过期 URI、两种分帧、重连与背压。P2 另外执行 AAC/96 kHz FLAC 重采样、原生变调频率/脉冲延迟、快速调节/取消清理，以及同一 URI 的实际 Host 参数和音轨变化；重唱即使歌曲不变也必须停止旧流。原生 shim 覆盖 PCM 环形历史多次绕回、EOF 静音与越界拒绝。Linux CI 在准备本机 prefix 后运行两级检查。

其他 Rust 测试覆盖真实回环 HTTP 的授权、探测、重定向/Fault 拒绝、服务身份改变、协议解析、响应上限、AppState busy 提交及过期结果。Chromium/WebKit 验证状态显示、重试防重入及语言切换；旧 WebView 的额外检查需要显式配置对应浏览器。

正式启用能力或进入下一产品化阶段前必须保存经过脱敏的实机记录，运行结果保存在忽略的 `.tmp/` 或仓库外：

1. G0：在目标桌面平台、真实房间 Wi-Fi 和官方授权完成后连接。检查输出投影中的服务存在性及 `sink_formats`，并与弹窗结果核对；记录型号、固件、平台、样本和测试时间。无 AVTransport 或非空声明明确不兼容时停止 DLNA 路线；能力未知时可由用户明确试播，不自动开始或切换本地输出。
2. G1：在独立受控的短文件试播实验中分别验证 H.264+AAC MP4 与 TS；记录电视画面/音响结果、GET/HEAD/Range 行为、MIME 和 DLNA 头。当前探测接口不执行此实验，需后续实机试播工作包完成。
3. P1 软件可用于受控实验，但不代替 G0/G1。G2 必须用单 URI 连续播放至少三十分钟，分别测试两种 HTTP 发送方式，记录首帧、缓冲、暂停方案 A 和断开重连。G2b 另测同 URI 切歌和跳转。未通过前保持实验性，采用显式停止和重建 URI。P2 软件实现保持显式 experimental，不视为通过 G2。G3 仍需对真实房台执行两种 offset 模式的 +150 → 0 → −150ms、音轨和变调操作，核对画面、音响、P50/P95 调节延迟、静音/卡顿次数与 TS 时间轴；没有实测值时保留 null 和 false。G4 决定正式支持范围。

libav 必须检查对应平台 CI 产物中的 `records/config_components.h`，确认 `CONFIG_MPEGTS_MUXER`、`CONFIG_AAC_ENCODER`、`CONFIG_H264_MP4TOANNEXB_BSF` 均为 `1`。其他平台或历史本机 prefix 的记录不能替代该平台验证；产品中不得执行 FFmpeg/ffprobe 程序。

`GetProtocolInfo` 的 Source/Sink 含义与 CSV protocolInfo 格式依据 [UPnP ConnectionManager:3](https://www.upnp.org/specs/av/UPnP-av-ConnectionManager-v3-Service-20101231.pdf)。

### 普通 DLNA 模拟验证

Host 的“投屏设备 → 连接”弹窗接受纯 K 二维码链接或局域网 DLNA
设备描述 URL。普通 DLNA 输入完整的 HTTP(S) 描述地址，例如
`http://192.168.1.10:8200/description.xml`，点击“继续”，再明确点击
“连接设备”；无需二维码、微信授权或自动发现。连接后可在媒体输出中
启用实验性 DLNA。描述地址须使用内网 IPv4，不能包含账号、查询参数或片段。

仅运行普通 DLNA 模拟接收器（须先准备当前 L1 companion）：

```bash
BILIKARA_TEST_LIBAV_COMPANION=/absolute/prefix/bin/libbilikara_media_libav.so npm run test:dlna
```

`npm run test:purek-controller` 同时验证纯 K 和普通 DLNA 两种连接路径。
两者启动实际 Rust Host、独立 AppState 与当前 libav companion；Node 模拟器
提供设备描述、ConnectionManager 和 AVTransport，并实际拉取、检查输出 TS。
普通 DLNA 分支没有二维码或私有授权接口，收到 `SetDeviceAuthorization`
即失败。检查包含 SOAP namespace、`InstanceID=0`、`Speed=1`、
Stop → SetAVTransportURI → Play、DIDL 被 SOAP Fault 拒绝后的空元数据重试、
暂停/恢复/跳转时的 URI 生命周期、切歌、故障保持及接收器 EOF。
不依赖接收器 Pause 或 Seek；暂停使用 Stop，恢复和跳转重建媒体 URI。
服务版本 1/2 与 GetPositionInfo 另由 Rust 的实际 HTTP 单元测试覆盖。

可设置绝对路径 `BILIKARA_TEST_DLNA_EVIDENCE` 保存脱敏的动作计数、
TS 字节数和检查项 JSON。报告不包含媒体 URI、设备地址或授权信息。
这是控制与拉流模拟，不是完整 UPnP 认证，也不替代物理设备的 G2/G3 验收；
模拟成功不会将 `qualified` 或任何实机能力标记改为 true。
