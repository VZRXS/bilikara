# 纯 K 媒体输出

原生 Host 的实验性 DLNA／纯 K 投屏以移植自 bilikara R1/R2 的 Rust 投屏会话为唯一权威：发现与控制、文件／直播两种交付、纯 K 登记、诊断和门店自检都在其中；next 的 L1 音频处理通过它的直播模式向接收端供流，独立管线测试保留。Android 使用同一 libav/companion。授权、协议探测、实际发送与实机资格是不同的条件；协议声明及模拟房台不能使 `supports_*` 变为真。软件检查、模拟接收端和 APK 构建不代替 G0–G4 房台与设备验收。

## 本机扫码与 Remote 房间协助

桌面 Host 提供“请求 Remote 扫码”和现有连接管理/媒体输出。Android、iOS
Host 使用本机实时相机或图片导入，复用同一个
`ktv-scanner.js` 解码器；图片、文件名和像素不发送到服务端。只有解码后的
文本提交到已有的 Host-only `/api/purek/prepare`，由 Rust `Room::from_input`
验证。扫码仅暂存候选，用户仍须在微信完成纯 K 官方授权，并明确检查连接；
普通 DLNA 不使用该授权。Host 是当前可信业务客户端，此路径不复用或绕过
Remote 的一次性协助许可。已认证、已登记身份的本地局域网 Remote 可通过
下述窄协助协议提交解码文本，仍不能调用 Host-only 接口。

实时相机需要安全上下文和系统许可；iOS 声明扫码用途，未申请麦克风。
Android 主清单声明 `android.permission.CAMERA`，由 WebView 的视频采集权限
请求触发运行时授权；相机硬件声明为非必需，无摄像头设备仍可安装。
debug 清单继承主清单，无需重复声明。与 iOS 一样，仅在用户扫码时使用相机，
不申请录音或存储权限；拒绝相机时保留权限提示和图片导入，图片在本机解码，
不上传图片或文件名。
各端图库／拍照输入保留 `accept="image/*"` 和原有 `Image → canvas` 解码路径，
Android 系统选择器也允许 GIF；有效 GIF 已在模拟器验证可原样导入，不做 GIF
专用拒绝或提示。不可读文件仍走现有图片／唯一二维码错误处理。
Android Host 等待 `getUserMedia` 权限结果时，权限 Activity 引起的短暂隐藏
不取消请求：恢复可见后允许即可预览，拒绝则保留原权限提示。若结果回来时
仍在后台，新轨道立即停止且不挂载预览；已运行相机的后台事件及 `pagehide`
仍立即取消并释放资源。沿用原请求期限，不另用延时猜测权限框是否结束。
iOS、桌面和 Remote 的隐藏停止策略不变。
移动 Host 的外层“扫描二维码”直接打开共用扫码画面，图库导入入口位于
画面内，以 44px 圆角方形图库图标显示，不再重复展示扫描/拍照按钮。
解码覆盖整幅输入画面，不按中央取景框裁剪；预览显示完整视频。识别仍受
清晰度、二维码大小及既有图片上限影响。相机只在明确扫描操作后启动，不在
页面加载或收到 Remote 邀请时开启；取消、后台或页面退休会停止采集和丢弃
迟到的回调。授权链接只用于当前页面的明确复制操作，不存入浏览器存储。
真实 UIKit/WebView 相机许可和外部微信返回仍须对应设备验证。

设置页的扫码入口复用 `settings-tool-button`：30px 高、12px 粗体、999px
圆角和普通设置工具的配色/留白。外层保留独立 44px 命中区域，按钮不铺满
整行。桌面和移动端都将扫码入口和现有 DLNA 开关放在同一行，分别
左、右对齐；状态、失败重试和延迟模式在需要时另起一行。弹窗内的连接、
授权等实际操作继续使用普通操作控件。

两种 Host 的设置卡片都不保留常驻扫码说明；桌面入口为“请求 Remote 扫码”，
操作差异收纳在 i 帮助中。移动 Host 直接进入共享扫码画面，
不展示 Remote 选择、邀请或公网配对提示，也不为打开弹窗读取 Remote 列表。
授权和房台网络条件收纳在现有 i 说明中；识别到纯 K 房间后才显示微信授权
步骤，连接后设置入口改为“管理设备”。
R8 §14.3 将设备入口与播放输出开关分开，AGENTS §5.3 的职责边界不变。
未连接设备时，输出组复用原有 `#purek-open` 扫码动作作为独立入口：
桌面请求 Remote 协助，Android／iOS 使用本机扫码；后续官方授权和普通 DLNA
地址流程仍由原有弹窗负责。入口不因缺少 companion 而禁用，保留原操作的
进行中守卫。连接后该节点恢复原有移动端管理／桌面断开角色，不额外显示
一个未连接设备入口。组件用 `data-media-output-add-device` 标识未连接角色。
未连接设备且当前本地播放时，DLNA 开关关闭并禁用，显示“未连接设备”，
无论 companion 是否存在；开关从不打开 Scan/Manage，也不自动尝试独立管线。
已连接设备仍通过现有请求由 Rust 检查资格、能力和格式，缺少真实 companion
时返回明确不可用，保持 Web 播放；不伪造设备或房台授权。
独立管线通过输出组单独的“管线测试”动作启动：仅在未连接设备、当前本地
播放、companion 和本地解码器均可用时显示。按钮沿用异步操作守卫，明确发送
`{target:"native",experimental:true}`，复用真实 Rust L1 管线及本机／Audience
接收，不需要纯 K 授权或接收端。启动前 DLNA 开关仍关闭、禁用并显示
“未连接设备”；测试成功后反映实际 native 输出，可通过开关返回本地。
缺少 companion 或解码器时隐藏测试动作，并在现有帮助中说明不可用原因；
普通本地 Web 播放保持可用。连接设备后不显示独立测试动作。
`tests/media_output.test.mjs` 覆盖入口可操作、开关不打开扫描、复用现有处理、
连接后入口角色切换，以及独立管线返回本地；跨平台渲染和真实扫码由浏览器验收。
IOS-R2-04b：操作失败保留现有 toast 归属和组内具体错误；无关快照、进度、
延迟更新与语言切换不清除它。重试成功、相关输出状态变化或关闭／离开该组
后清理临时“操作未完成”；数据使组隐藏也会失效当前操作的提示归属。
离开期间返回的失败仍交给 toast，但不在重入后复活
旧提示。后端仍报告的实际输出错误继续显示，不随组的关闭而被抹除。
`tests/media_output.test.mjs` 覆盖生命周期，`tests/media_output_browser.test.mjs`
补充真实导航与渲染状态验证。
已选中的普通 DLNA 端点经实际 AVTransport 和兼容 TS 声明确认后，每次连接默认
启用一次；能力未知、声明不兼容及 AirPlay 屏幕不触发默认开启。用户随后手动关闭
不会被刷新／重新探测覆盖。这里描述所选协议端点，不声称物理电视没有其他协议。移动端连接后的“管理设备”打开已有管理
弹窗，断开操作仍在弹窗内；桌面保留原断开快捷入口。双屏菜单不再提供投屏入口，设备管理只在设置输出组和
Scan/Manage 弹窗中（见“Manage 弹窗与设备行”）。
扫码弹窗使用共用 20px 内容边距与 12px 标题／内容间距。IOS-09-04：取景框
上方有标题栏，下方有设备连接和协助操作，不是贴近外框角的相邻内框，
因此不与弹窗外框同心，不能只从水平 inset 推导圆角。Host 和本地／公网
Remote 均保持共享扫码组件已批准的 14px 取景框圆角。
弹窗继续按排除 safe area、键盘和 dock 后的可用区域居中，正文独立滚动，
不压缩取景区或 44px 操作目标。`tests/ktv_assistance_browser.test.mjs` 对实际
边距、圆角和可用区域进行断言，涵盖短屏、横屏、平板与权限失败状态；
原有照片导入／授权用例继续保留。浏览器标记不替代 iOS 实机验收。
“手动连接其他 DLNA 设备”有明确展开箭头，技术地址输入仅在展开后出现。

桌面 Host 保留 Remote 扫码引导和协助流程。设备选择平等列出已认证、已登记
身份且当前在线的本地局域网及 Internet Remote，不要求创建公网房间。没有
合格连接时可打开现有手机连接菜单。用户名可以重复，路由使用服务端随机
连接 ID；设备行只显示登记用户名和本地/公网连接方式，不保存离线邀请，
不采集浏览器或机型信息。

Remote 顶部菜单在“外观”后提供“投屏设备”。Host 可指定连接发送邀请；
只有目标 Remote 收到接受/拒绝弹窗，收到邀请不会开启相机。Remote 也可
主动请求，此时 Host 自动打开设备弹窗，由 Host 允许或拒绝本次协助。Host
发出的邀请已经代表本次许可，手机接受即可扫描。连接设备后关闭 Remote
扫码入口，后端也拒绝新扫描许可；桌面 Host 的主按钮变为“断开连接”，明确断开
后两端通过状态更新恢复入口，不提供静默替换。
Remote 不重复显示“已批准”等状态或常驻相机说明，底部按“取消本次协助｜
扫描二维码”排列，图库入口整合在同一扫码画面内，高级区保留链接/普通 DLNA
地址输入。安全上下文可直接预览相机；HTTP 的扫描操作打开系统图片/拍摄
选择器，不再单列“拍照识别”按钮。没有 BarcodeDetector 时使用随包 jsQR；最多 12 MiB、
24 MP 的图片在本机缩至 1024px 解码，整张照片、像素和文件名不经过协议。
不把 capture 属性当作跨浏览器的相机保证。

一次性许可由 Rust AppState 的 transient native session 持有：256-bit 随机
请求 ID、准确的认证连接、Host epoch、稳定用户 ID、场次代次、房间代次和
单调截止时间共同验证。最多一个活动协助，邀请接受/Host 批准限时 60 秒，
接受后扫描与授权另限时 5 分钟。关闭邀请等同拒绝，取消、超时、断线、
身份删除/场次变化和 Host 重启撤销旧许可。检查中的网络结果回锁后重新
验证；取消后完成撤销登记才释放 I/O 租约，不能让旧回调登记新房间。
连接检查先确认已接收并返回 connecting，再在锁外执行房台 I/O，由私有
状态通知最终结果；控制通道不会等待 SOAP，取消因此不会排在检查后面。

暂存候选也有独立的服务端记录，绑定原始请求、准确连接、Host epoch、
稳定用户/场次代次、房间代次和原始截止时间。检查必须拥有当前候选；
新扫描许可不继承非空的 purek.room。取消、过期和新扫描替换会清理所拥有
的未连接候选；代次不匹配时只撤销旧记录，不清除其他房间或已连接接收器。
取消检查不会提前释放正在登记/回滚的 I/O 租约。

Internet Remote 无 I/O 的安全暂存候选在断线时可转为 Host 拥有的限时恢复记录，旧授权
能力立即撤销，界面不再称其为等待授权。恢复使用单独的请求和 Host 的
approve_resume；批准后绑定新的请求/连接并推进房间代次，不延长原始期限。
同名用户、重复标签页或普通扫描批准都不授予恢复权限。检查中的断线、
取消、过期、身份/场次变化、房间替换及 Host 重启不能恢复该候选。
本地局域网不提供跨断线恢复：LAN 断线清除其未连接候选，界面不显示
恢复入口；必须重新请求、获得 Host 批准并扫描。新连接不能接管旧许可。

授权生命周期的受控对照如下；微信和真实房台均须另做设备验收，浏览器后台事件夹具不等于系统后台策略。

| 对照 | 软件回归观察 | 物理验收 |
| --- | --- | --- |
| 扫码后保持 Remote 连接 | 当前 request/connection 不变；Host 显式取链、检查成功/失败及重试 | 微信/真实房台未验 |
| 暂时后台或 BFCache 后返回 | 连接仍有效时保留原请求；不自动复开相机、不自动登记 | Safari/微信 WebView 卸载和网络策略未验 |
| 电脑版微信授权，手机 Remote 保持连接 | Host 主动读取链接，Desktop 检查使用原候选绑定；没有自动续期 | 电脑版微信官方授权未验 |
| 真正断线后重连 | LAN 撤销，旧请求/Host 取链均拒绝；Internet 只能经单独 Host 恢复批准重绑，不延长期限 | 两类实际网络断线待验 |

| 接口/操作 | 权限与内容 |
| --- | --- |
| GET/POST /api/ktv/host | Host 独占；在线连接、invite/approve/approve_resume/decline/cancel；authorization_link/check 必须携带当前 request_id 与 host_epoch，并重验当前候选；替换已连接房间须显式 replace_connected，先执行现有安全 disconnect |
| POST /api/ktv/remote | 本地局域网窄协助封套；按认证 cookie 再校验准确 SSE 连接和登记身份，支持下列普通协助操作，不支持跨断线恢复 |
| GET /api/ktv/internet-events | Host 独占的每 peer 私有事件；Host 仅转发至对应已认证 DataChannel，不进入公共 state 或信令 |
| ktv.status.get / ktv.scan.request | 读取本连接的许可状态，或请求 Host 批准；无房间凭据 |
| ktv.scan.accept / decline / cancel | 绑定请求 ID、Host epoch 与连接；不能选用户名或代替其他连接操作 |
| ktv.scan.submit | 仅已批准的本地局域网或 Internet Remote 连接提交解码文本，Host 严格复用 Room::from_input |
| ktv.authorization.check | 仅有效许可可请求 Host 真实登记、重读接收器身份、查询 GetProtocolInfo；不能调用任意管理/输出接口 |
| ktv.authorization.resume.request | 安全公网连接单独申请恢复限时候选，必须经 Host approve_resume，不按用户名继承 |
| ktv.authorization.link.get | 当前候选所有者在其已认证连接中显式获取官方链接；结果不进入事件或公共状态，LAN HTTP 响应仍是明文 |

LAN 的每条 SSE 流获得独立服务端连接 ID，私有 ktv 事件不进入共享缓存帧；
原有设备计数仍合并多标签页。公网 endpoint ID 改为每个页面独立，重连的
peer epoch 也参与撤销；Viewer 不进入扫描设备列表，也无协助写权限。
公共 LAN/Internet state 的 ktv_room 只含固定状态与连接类型，不含接收器
地址、UDN、名称、房间令牌、官方授权 URL 或一次性许可 ID。

**协助权限、传输保密性和相机能力互相独立。** 本地局域网 HTTP 的已认证、
已登记身份连接可请求或接受邀请；经 Host 批准后，可提交 Pure K 二维码或
普通 DLNA 描述地址、获取本次授权链接、检查及取消。公网 Remote 是可选
替代方式。LAN 始终报告 `confidential=false`；客户端安全上下文或
`X-Forwarded-Proto` 不会改变此事实，也不会赋予协助权限。产品接受二维码中
设备授权信息经已认证 LAN HTTP 明文传输的保密性限制；这不等于保密通道。
说明收纳在扫码弹窗 i 帮助中，不重复阻断用户操作。

普通非回环 HTTP 页面通常不能打开实时相机，但不妨碍申请许可、接受邀请、
打开弹窗、拍照/导入图片、本机解码、粘贴房间链接、提交和检查授权。实时
相机仅在浏览器提供安全上下文与 getUserMedia 时可用，并仍须系统许可。
统一扫描入口在实时相机不可用时使用带 `capture="environment"` 的图片输入；系统可能提供拍照或
选图，不保证直接启动相机。不通过新协议或安全配置绕过浏览器限制。
不在 URL 片段、历史、localStorage、信令或诊断中转存扫描内容以便跨页搬运。
Internet 提交继续复用已认证的加密 DataChannel。Host 仍须在能实际访问房台
的网络，两类 Remote 均不提供房台网络隧道。

Pure K 暂存成功后，只有有效提交、当前候选所有者或可信 Host 主动获取链接的私有响应携带严格限定为
wx.chunk.cn/projection/login 的官方授权 URL。微信 WebView 可明确打开该
官方页；其他浏览器提供复制、手动在微信打开的指引和浏览器支持的分享
选单，不承诺能直接启动微信，也不创建 bilikara OAuth/callback。Desktop Host 的授权区与
移动端本机扫码区独立；用户先点击“获取官方授权链接”，再点击“复制微信授权链接”，可在电脑版
微信中完成官方授权。两步操作保留浏览器剪贴板所需的直接用户手势；打开弹窗、恢复页面及 SSE 更新
都不会自动取链。链接只保留在当前弹窗内存，关闭、取消、断线失效、候选变更或开始连接检查时清空；
迟到的取链响应不得回填已失效的候选。取链不更新期限、不执行房台 I/O，也不向公共状态、SSE、
诊断、历史或持久化文件写入链接。已连接房台、过期/撤销候选和待批准的公网恢复均不可取链。
Remote 协助时应保持原 Remote 页面连接；Desktop 的“检查连接”复用当前请求绑定的异步协助管线，
保留注册失败重试、取消及回滚租约。返回后由
用户点击“我已完成授权 — 检查连接”。普通 DLNA 没有微信步骤。若微信
暂时切后台只停止相机；连接及期限仍有效时，返回后读取许可，用户可以明确
继续。页面进入 BFCache 不提前断开仍有效的连接，也不强制重载；恢复时
重新核对现有连接，失效则由原传输重连。实际离开页面关闭连接并撤销许可。
Internet Remote 若仍有安全暂存候选，返回后选择“请求恢复上次授权”，等待 Host 单独批准，
再明确检查；需要重开官方页时显式获取链接。无法恢复时直接重新扫码。
所有路径都不自动启动相机、重发二维码或检查授权，也不存储恢复 bearer。
生命周期分支参考 [pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)
及 [pageshow](https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event)；
persisted 标记不替代连接、候选所有权和过期校验，手机行为仍需实测。

模拟器只证明协议及本地浏览器闭环。iPhone/Android 浏览器的相机、后台
恢复、微信页面/分享选单、真实照片与房台授权、网络可达性和媒体输出仍需
设备验收，均不得用软件通过标为已验证。`/api/purek/prepare`、`/api/purek/decode`
和 Rust QR 解析器保留为扫码合同；连接、断开和探测改用 `/api/cast/*`（见“接口”）。

## 投屏会话与状态投影

接收端投屏只有一个状态权威：Rust `AppState` 原生会话中的投屏会话
（`rust-runtime/src/native_host/cast_session/`，状态位于 `native_session.cast`）。
它负责发现、连接、纯 K 登记与健康维护、起播和播放控制、HTTP 发布、诊断以及门店自检。
next 原有的快照字段保留名称、取值词汇和隐私边界，但只是从这份状态计算出的只读投影；
不得为它们另存第二份状态，也不得由前端、Python 或平台层自行推算。

| 快照字段 | 来源与语义 |
| --- | --- |
| `media_output` | 目标（`local`／`purek`／`native`）、状态、待播放意图、发送端估计进度、`pipeline_level`、offset 模式、错误与失败阶段。本地 L1 独立管线占用播放时改由该管线投影。公网 Remote 收到同一份脱敏投影 |
| `player_control_command` | 投屏接管播放时由会话发布到既有 FIFO 的命令；本地播放器不认领、不发布观测、不 ACK |
| `purek` | Host 专用：房间连接与下表的 `output` schema 1，附带父级 native session 的 `revision`、`state_epoch` |
| `ktv_assistance`、`ktv_room` | Remote 协助挂在同一房间状态上，协议与公开字段不变 |
| `cast` | Host 专用：`phase`、`busy`、设备行与偏好、`pipeline_running`／`pipeline_result`、`self_test`；有活动会话或已保存偏好时才出现 |
| `diagnostics.purek` | 由投屏会话生成的兼容摘要；完整轨迹在 `diagnostics.cast` 与 `diagnostics.cast_self_test` |

`purek.output` schema version 1：

| 字段 | 当前语义 |
| --- | --- |
| `schema_version` | `1` |
| `target_room_id` | 每次连接生成的随机标识；不是房间名称、设备 UDN 或凭据 |
| `generation` | 房间操作代次；重试、断开和失联使旧结果失效 |
| `status` | `stopped`、`authorized`、`waiting`、`probing`、`unverified`、`unsupported`、`starting`、`streaming`、`pausing`、`paused`、`stopping` 或 `error` |
| `capabilities.has_*`、`sink_formats` | 已校验描述中的服务存在性和 GetProtocolInfo 声明的 MIME／profile，不输出原始 vendor 参数 |
| `capabilities.protocol_info_state / protocol_info_error` | `not_checked`、`reported`、`empty` 或 `unavailable`；查询失败保留固定错误码，不改写为空声明 |
| `capabilities.supports_*`、`qualified` | 始终为 `false`；协议声明、模拟接收端或试播成功都不能把它们改为真 |
| `pipeline_level` | 见“投屏中的 L1”；不是旧 L0 直通管线的标记 |
| `offset_mode` | `splice`（默认）或 `gradual`，仅 L1 生效 |
| `last_error` | 可本地化的固定错误码，无远端错误正文 |
| `measured_adjust_latency_ms` | `null`，无 G3 实机测量 |

错误词汇：会话内部保留 R1 的 `cast_*` 原始码（`cast.error_code`、诊断），投影映射回 next 的
`purek_*` 词汇和 `route`／`description`／`authorization`／`revalidation`／`health_check` 阶段。
只影响输出的失败（例如 companion 不可用、准备或发布失败）不写入 `purek.error_code`，
而是在 `purek.output`／`media_output` 报告 `status=error` 和 `purek_output_backend_unavailable`
或 `purek_output_pipeline`，失败阶段为 `media_preparation` 或 `media_pipeline`。
缺少 AVTransport 投影为 `unsupported / purek_output_no_av_transport`；
GetProtocolInfo 为空、失败或未列出兼容 MPEG-TS 时为 `unverified`，仍允许用户显式试播。
自检占用播放（交接前）时投影为 `status=probing`、`busy=true`、`target` 与
`requested_target` 为 `purek`、`desired_playing=false`，不出现 `stopping`。

## 接口

Host 管理接收端只使用 `/api/cast/*`；除下表注明的播放控制外均为 Host 专用。`/api/purek/prepare`、`/api/purek/decode`（扫码合同）
和全部 `/api/ktv/*`（Remote 协助）保留不变。其他 `/api/purek/*`
（`connect`、`disconnect`、`probe`、`output/*`、`state`、`preferences` 等）已退役：
Host 收到 `410 purek_retired`，Remote 仍为 403。静态 Host、本地 Remote 和公网 Remote
都不调用退役接口。

| 路径 | 请求与行为 |
| --- | --- |
| `POST /api/cast/discover` | 逐网卡发现；可选 `description_url`（局域网 IPv4 描述地址）。已连接或会话占用播放时 409 |
| `POST /api/cast/connect` | `device_key`（发现得到的设备行），或使用 `/api/purek/prepare` 已准备的房间（纯 K 二维码或普通 DLNA 描述地址）。接受后异步执行，返回操作 ID；结果经快照发布 |
| `POST /api/cast/disconnect` | 撤销纯 K 登记并等待 release 后才结束会话；可选布尔 `retain_room`，见“门店自检” |
| `POST /api/cast/output` | `{"enabled":bool}`，只切换输出、保留连接和登记 |
| `POST /api/cast/probe` | `{}`，对已连接设备重新查询 GetProtocolInfo；不接受客户端提供的地址 |
| `POST /api/cast/preferences` | `{"auto_discovery":bool}` |
| `POST /api/cast/command` | 投屏中的播放控制（带 `item_id`、`playback_generation`，下一首另带 `expected_queue_version`），与本地播放命令一样允许已登记的 Remote；`cast.set_device_mode`／`cast.set_device_learning` 仅 Host |
| `GET /api/cast/capabilities` | `pipeline_available`：companion 是否具备投屏合流 |
| `GET /api/cast/report` | 当前投屏会话的脱敏报告 |
| `/api/cast/self-test/{start,answer,cancel,handoff,report,download}` | 门店自检 |
| `POST /api/player/output` | 保留：`{"target":"purek","experimental":true}` 映射为投屏输出开关；`native` 启动独立管线测试；`local` 返回本地 |

网络 I/O 在 AppState 锁外执行，开始和结束在锁内提交；旧 generation 的回调不能修改新会话或
释放新操作的 busy。连接或纯 K 准备进行中时，独立 L1 的并发启动返回 busy。

## Manage 弹窗与设备行

设置里的输出组（DLNA 开关、添加设备、管线测试）是所有平台唯一的投屏入口；R1 的双屏菜单面板
和 R2 的 Android“我的”卡片不再存在。`#purek-modal`（Scan/Manage）在 next 原有的扫码、纯 K
授权和协助流程之外，增加发现得到的稳定设备行、临时／保存的偏好标签、`auto`／`file`／`live`
交付方式、取消发现，以及带展开箭头的手动地址输入。设备行按稳定 key 渲染；偏好修订冲突只重试一次，
重试前确认设备仍存在且操作仍可执行。异步操作立即 `disabled` 并设置 `aria-busy`，等待权威终态；
发现不会因超时而在前端自行解锁。关闭弹窗或设备、连接变化时清除瞬时错误。

暂停输出（开关关闭或本地管线错误）保留连接、平台 lease 和纯 K 登记，并通过既有 FIFO 恢复本地
播放位置和意图；只有显式断开才撤销登记。连接或授权本身不切换输出。切到 DLNA 前必须关闭物理
双屏输出；Tauri 的 `presentation` 以带 generation 的网络 renderer 互斥防止物理双屏与网络输出
并发，旧代次不能释放新占用。

快照包含 `cast.self_test` 时，设备行显示兼容性测试入口（见“门店自检”）。

## 投屏偏好

每台设备的交付方式（`auto`／`file`／`live`）、自检学到的方式与变体、厂商类别和最近使用时间，
以及“自动发现”开关，单独保存在原生数据目录的 `cast-devices.json`（与 `host-state.json` 同目录，
Windows 桌面为 `runtime/data/cast-devices.json`）。规则：

- 不进入主 checkpoint（`host-state.json`）；文件上限 256 KiB，按稳定设备 key（UDN 摘要）索引，
  有最近使用淘汰和修订校验。不保存设备地址、描述、房间凭据或授权链接。
- 原生启动（F2 `native_startup_pending`）完成、进入 Ready 之前不写盘；启动失败丢弃未提交的更改。
- 首次替换前保留 `cast-devices.v1.backup.json`；损坏的原文件不覆盖、不阻止 Host 启动，按无偏好处理。
- 桌面导入工具不转换、不校验、不合并它：复制原生数据目录时它作为普通文件原样随行，旧版记录转换不会生成它。
- `auto` 在自检学到“直播”时使用直播，否则使用文件模式。

## 交付模式与拉流

- **模式 F（文件）**：T3 合流（`media-libav/cast_mux.c`）生成定长 MPEG-TS（自检的追加格为 faststart MP4）。
  HEAD 返回长度；单段、开放和后缀 Range 返回 206 与 `Content-Range`，不可满足的有效范围 416，其他 Range
  忽略并返回 200 全量。暂停、恢复和跳转使用 SOAP Pause／Play／Seek，保持同一 URI。
- **模式 L（直播）**：无 Content-Length、忽略所有 Range、`Accept-Ranges: none`。每个读者从播放点之前最近的
  关键帧加入，按读者重写 continuity counter。暂停／恢复重建 URI；跳转（`/api/cast/command` 与
  `/api/player/control`）不向接收端发 SOAP Seek：播放中在目标位置重建生产者和 URI，从目标之前最近的关键帧开始，
  位置按新流的实际起点计；暂停中只记录目标，恢复时从该位置重建。
- **视频编码**：两种模式都只转发 H.264。HEVC／AV1 缓存在开播预检或合流时返回
  `cast_media_unsupported_codec`（不是笼统的 `cast_prepare_failed`），提示对该歌曲“重新下载缓存”。
  连接接收端期间（`cast.connected`），DownKyi 的新下载也只选 AVC（原生下载器本来只下 AVC）；
  手动重新缓存（`/api/cache/retry` 带 `force:true`）因此得到 AVC 版本。连接状态的变化按解码兼容性变化处理，
  替换仍在进行的下载；已完成的缓存不会被自动替换。
- 开播顺序 Stop → SetAVTransportURI（转义后的 DIDL-Lite；被 SOAP Fault 拒绝时空元数据重试一次）→ Play。
  **开播前的 Stop 任何错误都忽略**，只完整记录进诊断。GetProtocolInfo 失败、为空或未列出 MPEG-TS 都不阻止
  起播，默认按 `http-get:*:video/MP2T:*`。
- 拉流来源：私有、共享（100.64.0.0/10）、链路本地和回环来源一律接受；与描述地址不同只记
  `http.peer_mismatch` 诊断；**只有公网来源**在读完请求头后返回 403。**不返回 409**：每个端点（即每个能力
  令牌）同时最多 4 个 GET，第五个关闭最旧的连接。请求头须在 5 秒、8 KiB 内完整到达，否则不回应直接关闭。
- 背压：两种模式都等待 socket 背压；每次写入进展重置期限，**连续 15 秒没有写入进展**才断开该连接，
  不设短写超时。取消输出立即结束发送。
- 新 generation 发布后旧 URI 返回 404。
- 状态监测：GetTransportInfo 是参考信息；Fault、HTTP 404 或非标准回复停用轮询但不断开。只有真实连接失败
  持续 8 秒静默且 4 秒恢复窗口内没有成功响应才视为失联。发送端 EOF 而接收端仍报 PLAYING 不推进下一首；
  中途 STOPPED 不推进；接近结尾的 STOPPED 推进一次。下一首使用新 URI，保留接收端连接和纯 K 登记；
  未缓存的下一首明确失败，不连续跳歌。

`rust-runtime/src/dlna/cast_http/README.md` 记录 T4 的完整 HTTP 合同、缓冲上限和外部生产者接口。

## 共享输出控制

在设备连接后，用户通过输出组的 DLNA 开关明确开启实验性输出；关闭返回本地播放。投屏复用双屏控制台：
播放器区域显示后续歌曲报幕，沿用同一套播放／暂停、前后 15 秒、进度条、重唱和下一首控件；网络操作进入
Rust 命令 FIFO，本地媒体节点保留但不认领命令。`app.js` 继续使用 next 的 `media_output`、
`player_control_command`、ACK 和播放状态接管逻辑，没有另一层投屏播放控制。已选中的标准 DLNA 端点经实际
AVTransport 和兼容 TS 声明确认后，每次连接默认开启一次；能力未知、声明不兼容和 AirPlay 屏幕不触发默认
开启，用户随后的手动关闭保持关闭。标题后的 i 按钮收纳实验性说明、发送端估计进度的含义和错误详情。

`/api/state`、SSE 与公网 Remote 的 `media_output` 不包含设备地址、名称、URI 或令牌；
`position_source=sender_estimate` 不表示接收端实际出声位置。本地 Remote 可 POST
`{"offset_mode":"splice"}` 或 `gradual` 到 `/api/player/output`；公网 Remote 使用经过 typed 协议权限校验的
`output.set_offset_mode`，不提供远程登记、探测或目标选择。

## L1 音频处理

L1 在同一个 MPEG-TS muxer 中保留 H.264 视频包，音频解码后统一为 48 kHz、f32、stereo，再经过原生 Signalsmith Stretch、增益和 AAC-LC 编码。一个会话只建立一个 192 kbps AAC 编码器，PTS/DTS 由连续输出样本计数产生；参数调整不重建编码器或 URI。编码延迟参与共同时间轴起点计算，结尾仅补齐最后一个 AAC 帧。

每次开始固定并持有当前缓存组的最多两个音源读取租约，接受 AAC、FLAC、E-AC-3、AC-3、MP3、Opus 的本地 MOV/MP4 或 raw FLAC。输入限 8–192 kHz、1–8 声道且布局有效；实际解码、采样率转换、配置改变或损坏检查失败即停止。未缓存的新音轨不会通过客户端路径临时打开。音轨标签与业务选择仍来自 AppState。

- 拼接：在下个 1024 样本边界切换源位置，两个已预热 DSP 声部做 40ms 等功率交叉淡化。
- 渐进：从当前有效 offset 向目标移动，至少三秒，极端调整延长到源消耗速率处于 0.75–1.25；Signalsmith 保持音高。新的调节从当前映射继续。
- 原唱/伴奏切换：预热目标声部，80ms 等功率淡化。淡化期间的快速请求合并到最新 AppState 值，结束后继续处理。
- 变调复用现有 ±6 半音范围，以每秒最多 24 半音接近目标；音量复用现有 0–500% 与静音策略，逐样本斜坡并限制输出峰值。设备 RenderingControl 音量未启用，避免双重增益。

正 offset 表示音频滞后：可听源位置为 `videoSource − offset`，正向调节重复历史、负向调节前移。规格中“正差值跳过”与这个定义相反，故这里沿用现有播放器语义。DSP 的输入位置在可听位置上加 `inputLatency + outputLatency`，并用 outputSeek 预热，匹配 Host 的 `videoTime − offset + pitchDelay`；规格中的减延迟表达式不能直接用于解码输入游标。原生脉冲测试验证稳态补偿，实际房台缓冲另由 G3 测量。

每轨 PCM 历史使用固定 16 秒环形缓冲，覆盖最大正负 5 秒间的切换和解码预读；转换暂存、PCM 读取和每个 DSP 块另有限额。该历史不同于 T4 的 HTTP 环形缓冲，不随歌曲长度增长。资源在同步调用结束后由分配模块释放；取消、回调 panic、解码失败和网络停止均释放缓存读取租约、DSP 声部、编码器、解码器、resampler 与 descriptor。参数只从 Rust AppState 获取；这些缓冲不拥有第二套用户设置。

原生 Stretch 固定到与前端相同的 1.3.2 提交，Linear 固定为 0.6.6；源码、MIT 许可及逐文件 Git blob/SHA-256 位于 `media-libav/signalsmith/`。使用 C++17 编入 companion，无 Web Audio / AudioWorklet 移植，无新增 FFT 动态依赖。旧媒体 ABI 保留，L1 另按结构大小和 schema 协商。

### 投屏中的 L1

直播模式下，companion 具备 L1 且片源最长关键帧间隔不超过 4 秒时，L1 通过 T4 的唯一外部生产者
（`LiveStream::external` 与不可复制的 `LiveProducer`）向接收端供流；T4 继续负责 HTTP、环形缓冲、
关键帧加入和每个读者的 continuity 重写（`rust-runtime/src/native_host/cast_session/l1.rs`）。
开播前一次只读包预检（`cast_preflight`）决定是否走 L1，结果直接交给 L1 复用，不重复读取。
文件模式、companion 不具备 L1，或片源有超过 4 秒的关键帧间隔（`live_ts.c` 拒绝距关键帧 4 秒以上的包，
T3 没有此限制）时走 T3 合流；这两种直播情况仍可跳转，但不能实时调整。

- **音轨**：companion 的 L1 ABI 一次渲染至多两条音轨。会话送入当前音轨，以及按歌曲顺序的第一条
  其他已缓存音轨；未缓存的音轨被略过，不再使 L1 失败（当前音轨本身必须已缓存）。切到这两条之外的
  已缓存音轨时，会话在当前位置重建生产者和 URI，而不是从头播放。

- **节流预留：投屏中调整变调、音画延迟、音轨或音量，接收端约 1.9 秒后才听到变化。**
  生产者节流从 `producer.start()` 成功时起算，提前量为 `min(突发量, 2 s) − 100 ms`，默认 1.9 秒；
  超过“已播放时长 + 突发量”的写入是 T4 的终止性错误 `ProducerAhead`，负时间戳在等待前即被拒绝。
  这是交付缓冲的固有延迟，不是界面延迟；接收端自身的缓冲另外叠加，需要 G3 实测。
- 每个 DSP 控制回调都从同一 Rust AppState 读取变调、有效延迟、音轨、音量、静音和 splice／gradual，
  调整不重新发布 URI；换轨推进播放代次但保留输出代次，暂停时换轨保持暂停。切歌由会话回收旧生产者，
  复用接收端连接和纯 K 登记。
- **非 L1 时禁用**：投屏拥有播放、实际管线不是 L1（文件模式或 L1 不可用）时，AppState 拒绝变调、
  延迟和换轨且不改设置；Host 的变调和延迟控件禁用，信息气泡显示原因，控件经独立的
  `host-*-network-dsp` 描述节点关联原因。L1 时开放；本地和独立 native 输出不受影响。
  不从接收端声明推测 L1。原因见 `media_output.pipeline_reason`：`file_mode`（文件交付）、
  `long_gop`（片源关键帧间隔过长，T3 直播）或 `l1_unavailable`（companion 不具备 L1）；L1、未投屏和
  独立 native 输出时为 `null`。信息气泡对 `long_gop` 说明是片源原因（换交付方式无效），其余说明交付方式。

`pipeline_level`（`media_output` 与 `purek.output` 一致）：

| 状态 | 值 |
| --- | --- |
| 已启动并拥有播放的直播 L1，或其暂停状态 | `"L1"` |
| 拥有播放的文件模式，或 L1 不可用而走 T3 的直播 | `"L0"` |
| 本地播放、仅连接、输出已暂停、失败后回到本地、断开后 | `null` |

只有实际启动成功才标记 L1；准备新管线时的过渡快照可能暂报 `L0`，不能据此开放 L1 控件。

## Android

Android APK 使用 NDK 构建同一 libav/companion（R1 投屏合流、next 的 L0/L1 与原生 Signalsmith）。
启动只从系统提供的 `nativeLibraryDir` 加载，独立协商 ABI 与构建事实；投屏和独立管线需要投屏合流与 L1
同时可用。companion 缺失、加载失败、协商失败或 JNI 取路径失败**只让投屏与 libav 媒体能力不可用**
（`cast_backend_unavailable`），Host 照常启动；缓存规范化和媒体检查保留 Rust 兼容路径并记录原因。
桌面同样如此：已连接时本地管线失败只暂停输出、保留连接和登记，并恢复本地播放。
构建、16 KB 对齐、`libc++_shared.so` 的 RELRO 例外、源码包分发、样片开关、失败负缓存和音画起点变化
见 [android-libav.md](android-libav.md)；前台服务、Wi-Fi／多播锁和热状态见
[android-host-beta.md](android-host-beta.md)。AAC 软件编码与 DSP 的 CPU、发热、耗电以及后台行为需真机
对照，不能由桌面或交叉编译结果推断；能力标记继续保持实验状态。

## 网络与隐私边界

- 所有网络 XML（设备描述、SSDP、授权 SOAP／Fault、能力查询与媒体控制回复）只经过一个入口
  `rust/src/dlna_policy.rs` 的 `bounded_xml`：按类型限制字节数（描述 1 MiB、SOAP 64 KiB、SSDP 16 KiB），
  线性预扫描限制嵌套 64 层（根为第 1 层，自闭合元素也占一层），XML 节点上限 8192；识别注释、CDATA、
  处理指令和属性引号，引号内的 `<` 也视为无效，拒绝 DTD 和无法安全识别的标签。超限返回结构化错误，
  不截断后继续解析，也不回显原始 XML。
- 普通 DLNA 描述地址和纯 K 二维码地址只接受局域网 IPv4（私有、共享 100.64.0.0/10 等），公网 IPv4 一律拒绝。
  纯 K 二维码解析容忍大小写、端口、路径和编码变体，以及片段；描述路径只追加一次。不跟随 HTTP 重定向，
  URL 不得含凭据。
- 纯 K 登记前后只比较 UDN；授权后服务列表变化是预期情况，以授权后的描述为准。登记报文带 XML 声明。
  健康检查容忍暂时失败，连续五次失败或 UDN 改变才释放；近期有实际交付时延长容忍。SSDP 代公告尽力而为，
  失败不撤销登记。取消、断开、generation 替换和取消自检都等待撤销（`Enable=0`）完成，不依赖 Drop。
- 设备地址、控制地址、UDN、二维码内容、Token、授权链接、流 URL 和原始协议响应不进入公共状态、日志、
  诊断导出、验证记录或截图。设备型号、固件和经过脱敏的网络拓扑可记录；不要附带门店名称、房间编号或
  无关局域网地址。

### 诊断

投屏会话使用 `rust-runtime/src/dlna/diagnostics/` 的分阶段轨迹（最近六次连接，当前与上一次输出），
由“复制诊断报告”、诊断 ZIP 的 `diagnostics.cast`／`diagnostics.cast_self_test` 和 `/api/cast/report` 输出；
`diagnostics.purek` 只是兼容摘要。失败阶段区分媒体准备、控制命令、电视未拉流、拉流被拒绝或中断、
已写入但未确认播放、播放随后停止。“已写入”只表示数据进入本机套接字。

导出时所有设备 key、UDN 摘要和未知服务摘要用每次会话新盐的 HMAC-SHA256 重新散列；
`friendlyName` 只给摘要、长度和截断标记；品牌按白名单归类，型号经过净化。轨迹不包含接收端或本机地址、
流 URL 与能力令牌、房间标识、二维码内容、授权链接、Cookie、凭据、HTTP 正文或 SOAP 负载。
完整规则见 `rust-runtime/src/dlna/diagnostics/README.md`。

## 门店自检

门店里只有一次机会收集数据，因此兼容性测试在产品内一次跑完、生成脱敏报告。入口在 Manage 弹窗的设备行
（快照有 `cast.self_test` 时显示）；`POST /api/cast/self-test/start` 只接受 `{generation, device_key}`，
代次不符返回 `cast_self_test_stale`，`device_key` 为空表示由服务端自动发现。没有第二个纯 K 输入：
凭据只来自 `/api/purek/prepare` 已准备的房间，并且只挂到位置等于该房间描述地址的设备行上；
不匹配时照常按普通 DLNA 测试，同时在快照 `self_test.purek_room_unmatched`、报告
`environment.purek_room_unmatched` 和弹窗中明确提示。自检与本地 L1 管线、connect、纯 K prepare 和
待处理的投屏互斥。

| 阶段 | 内容 |
| --- | --- |
| S0 环境 | 平台、网卡与出口地址类别、是否同一 /24、Windows 网络类型、VPN/TUN、Android 网络事实、companion 能力、样片 B 校验；只记录，永远继续 |
| S1 授权前发现 | 逐网卡 M-SEARCH 和 NOTIFY，15 秒；记录设备数量、厂商类别和目标是否在列 |
| S2 纯 K 解析和路由 | 二维码字段是否存在（不记值）、地址类别、出口路由 |
| S3 纯 K 登记 | 授权前后描述、`SetDeviceAuthorization` 的 HTTP 状态和 Fault 码、UDN 是否相同、服务是否变化，再做 5 秒发现；登记失败照样继续 S4、S5，标为未登记试播 |
| S4 能力 | GetProtocolInfo 状态与 sink 类别、GetTransportInfo 基线、服务是否存在；失败只记录 |
| S5 媒体预检 | 样片 A（由缓存歌曲合流）与随包样片 B 的编码参数和校验 |
| S6 矩阵 | 文件／直播 × 样片 A／B 四格，每格 20 秒：Stop、Set、Play，记录拉流和传输状态，再问用户画面、声音和同步（60 秒内未回答记为未回答，不伪造）；四格都没有画面时追加 faststart MP4 × A |
| S7 收尾 | Stop；按用户选择交接或撤销纯 K 登记；写回学到的交付方式和变体；生成报告。取消时也执行 |

- 报告在交接前冻结（`finished_at`），之后的普通播放和取消不改变已完成的报告。
  报告经 `/api/cast/self-test/report` 读取、`/download` 下载，Android 通过系统分享发送；内容按“诊断”的规则脱敏。
- **`retain_room`**：界面的顺序是 prepare → `/api/cast/disconnect` → start。`disconnect` 的可选布尔
  `retain_room:true` 让普通会话照常被替换、登记照常撤销并等待 release，只保留已授权的纯 K 房间凭据供
  自检重新登记；普通 DLNA 描述地址不保留，非布尔值作为无效请求拒绝。其他断开均不带此参数。
- 交接（继续投屏）时 `cast.room` 改为实际接管的设备；准备好的房间正是该设备时保留其凭据。
- 样片 B 使用 Kirakara Show 投屏参数的合成测试片（`resources/cast-samples/SOURCE.md`），桌面随包资源目录分发
  （不进前端 dist），Android 作为 APK 资产；对比样片 A 可判断失败来自原片编码还是交付方式。

## 无接收设备的独立管线测试

`POST /api/player/output` 的 `target: "native", experimental: true` 是 Host-only
的明确操作；它复用 Rust AppState、L1 libav 音频处理、控制 generation、曲目／
设置签名和输出平台生命周期。无需建立 Pure K 候选，不发送 SOAP。音量、音调、
音轨、定位、暂停和切歌继续由同一权威控制器处理；回到 `local` 恢复保留的 Web
媒体节点。接收端输出 `purek` 由投屏会话负责，见上文。

`target: "native"` 同时运行一次无接收端的 R1 链路检查（R1 的链路检查并入 next 的管线测试，`cast_session/pipeline.rs`）：把当前缓存歌曲
经 T3 合流成文件 TS，由 T4 发布到回环端点，读取首个 TS 包（同步字节 0x47），并校验随包样片 B。结果在
`cast.pipeline_result`，由设置输出组的管线测试下方一行状态显示（检查中／通过／通过但样片 B 未校验／
未通过：原因）。它代替 R2 的“家里预检”，不需要接收端或房间授权；接收端兼容性由设备行上的门店自检负责。
companion 不具备投屏合流时报告 `cast_backend_unavailable`，没有缓存歌曲时报告 `cast_no_media`，
平台未集成样片时报告 `cast_sample_not_integrated`。

Host-only `/api/player/output-preview` 返回当前 generation、period 和私有 HLS 展示地址，
反馈必须绑定当前 generation；URI 不进入公共 SSE、Remote 状态或持久化。
`/media/native-output/` 同时要求 Host 身份，未启用该管线时拒绝读取。每个 Host
生命周期保留一个有界预览会话，暂停／定位／切歌以 discontinuity 换段，保留同一个
本地 MediaSource；退出模式时停止读取和停用端点。预览环形窗口至多 6 段、16 MiB，
并发响应至多 8 个，旧运行不能向新运行写入；不复制整首歌到内存。Host 退出会
取消等待响应。随包固定版本 hls.js 只负责浏览器展示，不替代 Rust 编码/DSP。
仅 producer EOF 不能推进队列；播放列表写入 ENDLIST 后，当前 generation 的实际 ended 观察才可推进。
双屏时 Host 画面静音，Audience 负责播放带处理音频的同一管线。

iOS 尚未打包 L1 companion，独立管线返回明确不可用并保留普通 Web 播放。
软件转码、浏览器或接收器夹具不能替代真实 DLNA／AirPlay 资格验收。

浏览器展示按能力和播放器实现准入：Safari/WKWebView 优先使用系统 HLS；
不提供原生 HLS 的 WebKit 移植不启用本机预览；报告明确不可用并保留原 Web 播放。
Android/Windows 等具备 AVC/AAC MSE 的播放器使用随包固定 hls.js；不按 WebView
版本或 Huawei 等 UA 名称排除。接收端 DLNA 发送不依赖浏览器预览能力。

MSE 展示保留同一媒体源，通过实际缓冲片段的 discontinuity/period 进入新运行，
不会把后端换流当成已经完成了浏览器定位；系统 HLS 使用仅含当前运行的私有播放列表。
MSE 窗口可能先于切换通知读到新周期的 ENDLIST。收到通知时保留该已对齐的列表，
用已缓冲的新周期片段进入播放；若 ENDLIST 属于旧周期，刷新时保留原序号和时间轴参考。
快速重试时保持非重叠的 PROGRAM-DATE-TIME；旧 generation 的播放列表/结束反馈失效。
失败的解码器资源可经明确重试重新加载；不延长防抖或用发送完成推断播完。
同一运行已经记录管线或解码错误时，预览取消／失联收尾保留该原始错误，
不会再用 `purek_output_preview_lost` 覆盖。只有此前没有失败时才记录预览失联；
明确重试创建新运行后，才清除旧错误。

连续输入回归使用连续 PCM 时间轴重新编码的 AAC 夹具；循环流复制产生的
priming 时间缺口不能冒充连续输入。另用实际解码的缺口输入验证 `InvalidMedia`，
不放宽连续性检查或自动插入静音。

## 验证

在仓库根目录执行。带 companion 的命令先用当前平台已准备的 libav prefix 构建测试 companion：

```sh
cargo test --manifest-path rust/Cargo.toml --locked dlna_policy
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --lib dlna::
cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --lib native_host::cast_session -- --test-threads=1
cargo clippy --manifest-path rust-runtime/Cargo.toml --features native-host --all-targets --locked -- -D warnings
npm run test:purek
npm run test:media-output
npm run test:cast-ui
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-companion --prefix /absolute/prefix --out /absolute/owned-companion --test
BILIKARA_TEST_CAST_COMPANION=/absolute/owned-companion/libbilikara_media_libav_test.so cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked --lib native_host::cast_session -- --ignored --test-threads=1
BILIKARA_TEST_LIBAV_COMPANION=/absolute/owned-companion/libbilikara_media_libav.so npm run test:purek-output
BILIKARA_TEST_LIBAV_COMPANION=/absolute/owned-companion/libbilikara_media_libav.so npm run test:purek-l1
BILIKARA_TEST_LIBAV_COMPANION=/absolute/owned-companion/libbilikara_media_libav.so npm run test:purek-controller
```

以上路径示例用于 Linux；macOS/Windows 使用当前平台的 dylib/DLL 绝对路径（Windows 另把 prefix 的 FFmpeg DLL
复制到 companion 旁）。缺少实际 companion 必须失败，不得跳过。`test:purek-output` 在未设置
`BILIKARA_TEST_CAST_COMPANION` 时使用产品库同目录的测试库；两者都不存在时明确失败。cast_session 的 ignored
测试依赖测试 companion 的进程级故障注入计数，须串行运行。Linux CI 的 desktop-checks 构建测试 companion 并导出
这两个变量。部分 DLNA 用例使用 `127.0.0.1` 以外的回环别名；macOS 本机须先按 [macOS 测试](macos_testing.md) 添加别名，
否则这些用例写明原因后跳过（`BILIKARA_REQUIRE_LOOPBACK_ALIAS=1` 时失败）。

Node 测试启动实际 Rust Host、独立 AppState 和真实 companion；Node 模拟接收端提供设备描述、ConnectionManager
和 AVTransport，并实际拉取、解析输出 TS（DTS/PCR、PAT/PMT、连续计数、ADTS 帧和音画时长）。
next 的浏览器测试只在 Linux 运行，Windows 上的跳过不算通过。

### 普通 DLNA 模拟验证

普通 DLNA 与纯 K 共用准备流程：在 Manage 弹窗或 Remote 协助的高级入口输入完整设备描述 URL，例如
`http://192.168.1.10:8200/description.xml`，经 `/api/purek/prepare` 准备后由 `/api/cast/connect` 连接；
也可以直接选发现得到的设备行。普通 DLNA 没有二维码、微信授权或 `SetDeviceAuthorization`。

```bash
BILIKARA_TEST_LIBAV_COMPANION=/absolute/prefix/bin/libbilikara_media_libav.so npm run test:dlna
```

`npm run test:purek-controller` 同时验证纯 K 与普通 DLNA 两种路径；普通 DLNA 分支收到
`SetDeviceAuthorization` 即失败。检查包含 SOAP namespace、`InstanceID=0`、`Speed=1`、
Stop → SetAVTransportURI → Play、DIDL 被拒后的空元数据重试、文件模式 Pause／Play／Seek 保持 URI、
下一首、接收端 EOF、本地恢复，以及 14 种能力声明的实际试播。可设置绝对路径
`BILIKARA_TEST_DLNA_EVIDENCE` 保存脱敏的动作计数、TS 字节数和检查项 JSON；报告不包含媒体 URI、
设备地址或授权信息。这是控制与拉流模拟，不是 UPnP 认证，也不替代物理设备的 G2/G3 验收；模拟通过
不会把 `qualified` 或任何实机能力标记改为 true。

### 实机验收

正式启用能力或进入下一产品化阶段前必须保存经过脱敏的实机记录，运行结果保存在忽略的 `.tmp/` 或仓库外。
门店自检报告是首选证据（见“门店自检”）。G0 检查服务存在性与 `sink_formats`；G1 比较文件与直播、样片 A 与 B；
G2 用单 URI 连续播放至少三十分钟并记录首帧、缓冲、暂停和重连；G2b 测切歌和跳转；G3 在真实房台执行两种
offset 模式的 +150 → 0 → −150ms、音轨和变调操作，核对画面、音响、P50/P95 调节延迟（含上述约 1.9 秒的
交付预留）；G4 决定正式支持范围。没有实测值时保留 `null` 和 `false`。

libav 必须检查对应平台 CI 产物中的 `records/config_components.h`，确认 `CONFIG_MPEGTS_MUXER`、
`CONFIG_AAC_ENCODER`、`CONFIG_H264_MP4TOANNEXB_BSF` 均为 `1`。产品中不得执行 FFmpeg/ffprobe 程序。

`GetProtocolInfo` 的 Source/Sink 含义与 CSV protocolInfo 格式依据
[UPnP ConnectionManager:3](https://www.upnp.org/specs/av/UPnP-av-ConnectionManager-v3-Service-20101231.pdf)。

## 移植来源与替换清单

本子系统由 bilikara R1（桌面，T1–T9）和 R2（Android，A1–A7）移植，源树 `b49e1ae`。原则：协议、合流、
HTTP 端点、会话、自检和诊断以 R1 为准；界面合同、Remote 协助、扫码、L1 变调和 Android 平台层以 next 为准。

| 模块 | 去向 |
| --- | --- |
| `rust/src/dlna_policy.rs`（R1 T1） | 新增；合入 next B8 的 XML 边界（节点 8192、引号内 `<` 无效），成为唯一网络 XML 入口 |
| `rust-runtime/src/dlna/{discovery,control}.rs`（T2） | 替换 next `purek.rs` 的单 socket 发现和 `purek/renderer.rs`；逐网卡发现、不按厂商过滤、开播前 Stop 错误一律忽略、GetProtocolInfo 不拦截 |
| `media-libav/cast_mux.c`、`cast_audio.c`（T3） | 新增；与 next 的 `live_ts.c`、`live_audio.c`、`stretch.cpp` 同在一个 companion，同名辅助函数改为 `cast_*`。普通投屏走 cast_mux，L1 保留 next 的管线 |
| `rust-runtime/src/dlna/cast_http/`（T4） | 替换 `purek/stream.rs`（403/409、写超时）；新增给 L1 用的外部生产者接口 |
| `native_host/cast_session/`、`app_state/cast*`（T5） | 替换 `purek/controller.rs` 和 `purek/output.rs` 的 L0 发送；`media_output`、`player_control_command`、`purek`、`ktv_assistance` 改为投影 |
| `dlna/diagnostics/`（T7a） | 替换 `purek/trace.rs`；`diagnostics.purek` 改为兼容摘要 |
| `cast_session/self_test/`、`resources/cast-samples/`（T8、A4） | 新增 |
| `rust-runtime/src/dlna/purek/`（T9） | 替换 `purek/protocol.rs`、`purek/health.rs` 和房间登记；`/api/purek/prepare`、`/decode` 与 `purek/assistance.rs` 改接它 |
| `purek/capabilities.rs` | 删除；sink 声明只作诊断参考 |
| `purek/output.rs`（L1 部分）、`purek/preview.rs` | 保留，独立 L1 移入 `native_output`；投屏中的 L1 经 `cast_session/l1.rs` 接 T4 |
| `static/purek-room.js/.css`、`index.html` | 保留并扩展：R1 设备行、发现、交付方式、手动地址、自检入口、链路检查行。R1 的 `cast.js` 拆入其中 |
| `static/cast-self-test.js` | 新增（T8），从设备行进入 |
| `static/media-output.js/.css`、`native-output.js`、`ktv-scanner.js`、`ktv-remote.js` | 原样保留（公网 Remote 同步 `media-output`） |
| `src-tauri/src/presentation.rs` | 加入网络 renderer 互斥（T6） |
| `xtask/src/android_libav.rs`（A1） | 以 R2 为底（固定 prefix、无路径泄漏、RELRO 检查），开启 Signalsmith，允许 `libc++_shared.so`；源码包改为 APK 旁单独分发 |
| `native_host/android_media.rs`、`experimental_libav/load_cache.rs`（A2） | 合并；companion 失败不再阻止启动，失败负缓存 |
| `HostMediaPlayback.kt`、`HostCastPlatform.kt`、`cast_platform`（A3） | 逐段合并到 next 文件；组播锁改为发现租约，lease 防旧通知 |
| `HostLoginLink.kt` | 保留 next，合入 R2 的授权链接放宽；`HostRoomAuthorization.kt` 用 next 版 |
| `scripts/android_media_check.mjs`（A7） | 新增；六库检查、外部源码包、样片哈希 |
| R2 的 `cast-android.js`、“我的”卡片、`HostCapture.kt`、`android_capture.rs`、`qr_capture.rs` | 不移植；扫码用 next 的 `ktv-scanner`，入口用 next 的输出组 |

## 测试映射

改写只把断言换成 R1 的行为，不放宽、不删除；被替换实现的旧 Rust 测试由 R1 对应层的测试覆盖。

| next 门禁 | 移植后断言 |
| --- | --- |
| `test:purek`（`purek_room`、`ktv_scanner`、`ktv_assistance`、`ktv_assistance_browser`） | `purek_room` 改调 `/api/cast/*` 并断言 R1 的放宽规则（大小写、端口、片段、100.64/10）、公网 IPv4 拒绝和只比 UDN，错误为对应的 `cast_purek_*` 分类；`ktv_assistance` 只把 state/probe/disconnect 的传输改为 `/api/state` 与 `/api/cast/*`，身份、邀请、授权、隐私断言不变；`ktv_scanner` 原样 |
| `test:purek-output`（`purek_output`、`purek_monitor`） | 不因来源与描述地址不同而拒绝（公网来源仍 403）、不 409（第五个 GET 关闭最旧的）、停读 3／10 秒可继续、15 秒无进展才断开；文件模式 HEAD 长度、Range 206/416；直播忽略 Range、从关键帧加入；监测改为 R1 规则（UPnP 错误不断开，真实断线 8 秒静默 + 4 秒恢复）；完整运行 T4 的真实 companion 用例 |
| `test:purek-controller`（`purek_controller`、`purek_compatibility`） | R1 的起播、文件模式 Pause／Play／Seek 保持 URI、下一首、自然结束、断开恢复；14 种能力声明逐项实际试播，查询结果不阻止试播，`qualified`／`supports_*` 仍为 false；SetURI 被拒时清理会话并恢复本地 |
| `test:purek-l1`（`purek_l1`、`native_output_browser`） | 独立 L1 原样保留；另经 T4 直播供流（`cast_l1_receiver.mjs`），断言调整不换 URI、换轨推进播放代次、频率和增益实际变化、迟加入读者从关键帧开始 |
| `test:media-output`、`ios_output_ui_browser` | 原样通过；投影层保证字段合同 |
| `test:cast-ui`（`cast_browser`、`cast_full_host_browser`、`cast_self_test_browser`，也在 `test:host-experience` 中） | 新增：Manage 设备行、偏好冲突、发现 busy、几何与三语、自检弹窗、`retain_room` 顺序、链路检查行、DSP 禁用原因 |
| `test:android-libav`（`android_libav`、`android_cast_samples`）、`android_media_check` | 新增或扩展：真实 NDK 构建、六库 ELF、外部源码包、样片哈希与 Gradle 开关 |
| Rust `dlna::`、`native_host::cast_session`（含 ignored） | 新增；`purek/tests.rs` 中 B8 的 XML 测试移到 `dlna_policy_xml_tests`，QR 解码与 Node 启动夹具保留原名 |
| R2 `cast_android_browser` | 不再适用（Android 卡片未移植），由 next 移动端输出组测试覆盖 |
