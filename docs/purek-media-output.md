# 纯 K 媒体输出

原生 Host 提供 P0 能力探测、P1 L0 直通、P2 L1 音频处理及 P3 共享播放控制的实验性 MPEG-TS 输出，Android 使用同一 libav/companion。授权、协议探测、实际发送与实机资格是不同的条件；协议声明及模拟房台不能使 `supports_*` 变为真。软件检查和 APK 构建不代替 G0–G4 房台与设备验收。

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
弹窗，断开操作仍在弹窗内；桌面保留原断开快捷入口和双屏菜单内的管理入口。
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
设备验收，均不得用软件通过标为已验证。现有 /api/purek/prepare、decode、
connect、disconnect、probe 和 Rust QR 解析器保留供可信 Host/原有实验使用。

## 状态与接口

普通 DLNA MediaRenderer 在 Remote 的 KTV 房间高级入口输入完整 HTTP(S)
设备描述地址，例如 `http://192.168.1.20:8200/renderer/device.xml`。
`POST /api/purek/prepare` 接受 `{ "url":"设备描述地址或纯 K 二维码链接" }`；
原有 `qr_url` 与二维码图片接口继续只解析纯 K 二维码。新输入返回
`connection_type=dlna/purek`；普通 DLNA 的 `authorization_url` 为 null。
可信 Host API 完成准备后仍需显式调用 `/api/purek/connect`；Remote 流程
则使用已批准的 `ktv.authorization.check`，不会自动连接设备。

普通 DLNA 连接只读取描述、复查设备/服务身份并调用标准 ConnectionManager
`GetProtocolInfo`；不发送纯 K 的 `SetDeviceAuthorization` 或接收器 SSDP
公告。纯 K 路径保留官方授权、登记和撤销。两种方式共用 Rust AppState、
媒体管线和 AVTransport 控制，均不把模拟器通过当作实机认证。描述地址只
接受数值型私有 IPv4，同源服务校验、禁止重定向、响应上限及凭据隔离保持
一致；地址、描述和授权不持久化。缺少 ConnectionManager、AVTransport 或
兼容媒体格式时明确失败或报告不支持，不猜测设备能力。

状态由 Rust `AppState.native_session.purek.output` 独占。`GET /api/purek/state` 同时返回房间连接与输出状态，仅允许 Host。Remote 不能直接调用房间接口；经批准的一次性协助可要求 Host 验证已暂存房间，登记、身份复查与能力查询始终由 Host 执行。

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

`GetProtocolInfo` 是能力声明查询，不是播放前的授权门槛。已连接且有 AVTransport 的设备返回空 Sink 或查询失败时为 `unverified`，保留空声明与查询失败的区别，允许用户通过现有 DLNA 开关明确发起实验性 H.264/AAC MPEG-TS 试播；不会填入虚构的 `sink_formats` 或把 `supports_*` 改为 true。缺少 AVTransport 仍对应 `unsupported / purek_output_no_av_transport`。非空声明未包含兼容 MPEG-TS（例如只列出 MP4、RTSP 或音频）时同样为 `unverified`：声明照常投影到 `sink_formats`，但不阻止用户明确试播 `video/MP2T`。参照实现 Kirakara 对纯 K 房台不按 Sink 过滤，接收端常常漏报其实际可播放的格式。通配 `*` / `video/*` 按 UPnP 匹配规则可选用实际 MPEG-TS，但不证明设备能播放。

188-byte TS 支持 `video/MP2T` 和 `video/mpeg`（包括 AVC_TS_*_AAC_*_ISO 声明）。不将 192-byte `video/vnd.dlna.mpeg-tts` 冒充成 188-byte TS。DIDL 与 HEAD/GET 使用相同 MIME；接收器声明中的 profile 不会原样反射为本机资源的认证结论。媒体元数据、AVTransport 命令、真实接收端拉流和中断监测继续执行，只有 Play 成功且实际交付媒体后才进入 `streaming`；`qualified` 仍为 false。

探测错误不撤销已成功的房台授权；用户可以试播、重试查询或断开。尚未开始播放的查询失败不显示为“电视输出已中断”。普通 DLNA 可使用经过同源及身份复查的 AVTransport-only 描述；纯 K 仍必须提供 ConnectionManager 并成功完成官方设备登记。连接存活检查每 20 秒复查路由和接收器描述，失败计数绑定当前连接身份及操作代次。没有实际传输进度时，超时或暂时不可达后每秒重试，连续五次失败才视为失联。如果仍有未取消的 HTTP 消费者，且最近 15 秒内确有 TS 字节成功写入，则维持正常检查间隔，并只在首次描述失败后的 120 秒内容忍描述接口暂时不可用；打开的 GET 或历史字节计数不能无限延续授权。恢复成功会重置计数；路由或接收器身份改变立即失联，旧代次的探测不能撤销新连接。纯 K 的 SSDP 代公告仅服务第三方控制点，发送失败不影响登记、连接或存活判断。断开或确认失联会清除输出能力与房间标识。输出状态不持久化。所有新业务均由 Rust 实现，Python 源码 Host 不提供此接口的媒体能力。

## 共享输出控制

在 Remote 完成扫码和官方授权、由 Host 验证设备连接后，可明确开启“DLNA”开关试用实验性输出；关闭开关返回本地播放。DLNA 模式复用双屏控制台：播放器区域显示后续歌曲报幕，下面沿用同一套播放/暂停、前后 15 秒、进度条、重唱和下一首控件；网络操作进入 Rust 命令 FIFO，不操作已保留的本地媒体节点。Host 的设置、房间弹窗和播放控制台共用此开关，Remote 不管理输出目标。标题后的 i 按钮收纳实验性说明、发送端估计进度的含义和错误详情，简短状态常驻。原有音轨、AV delay、变调和音量控件继续生效。延迟调节模式位于共享输出控件；本地/公网 Remote 将其并入播放设置面板，与音画延迟、音量等模块共用外框、标题样式和分隔线。桌面 Host 使用 Remote 代扫码，移动 Host 也可直接本机扫码；整个房间设置只有一层底框，没有自动发现选项或嵌套底框。已启用双屏时需先关闭双屏；返回本地后可继续使用双屏。房间弹窗的长引导与排障收纳在标题 i 内，简短能力状态跟随房间名；Escape 先关闭说明，再关闭弹窗。卡片保留错误重试；不将授权或软件封装成功显示为实机认证。

`POST /api/player/output` 的 Host 请求 `{ "target":"purek", "experimental":true }` 明确选择实验性 L1 电视输出，`{ "target":"local" }` 明确返回本地。授权与 MPEG-TS 格式检查不构成实机认证。选择保存在当前 Rust AppState 会话，不持久化房台凭据。`/api/state`、SSE 与公网 Remote 的 `media_output` 是共享脱敏投影：目标、状态、待播放意图、发送端估计进度、offset 模式与错误；不包含设备地址、名称、URI 或令牌。`position_source=sender_estimate` 不表示接收端实际出声位置。

输出控制器消费既有经过歌曲/代次验证的播放命令 FIFO。Host/Remote 的播放、暂停、跳转、下一首及既有音轨、变调、音量、AV delay 操作复用当前接口；网络输出接管期间不允许本地播放器认领、发布观测或 ACK 网络命令。本地媒体节点可保留；返回本地通过既有 FIFO 恢复位置和播放意图。旧代次命令被丢弃，旧流回调不影响新流。

未取得 G2/G2b 实机证据时采用 Stop＋新 URI：暂停停止并保存位置；恢复、跳转、重唱及切歌重新准备 IDR 对齐的 L1 流。音轨、变调、增益及 offset 调节继续在原 URI 内处理。沿用歌曲间隔设置；未缓存歌曲和空队列等待，不发送虚构画面或编码视频。生产结束、HTTP 队列排空且消费者退出后，按有界的接收端收尾策略完成发送端交付并自动下一首，保留 Rust 历史/评分规则；接收端持续报告 PLAYING 不会无限阻塞。发送端 EOF 不表示电视已实际播完。网络或管线失败锁定网络输出并显示错误；只有明确操作才重试或返回本地。

本地 Remote 可 POST `{ "offset_mode":"splice" }` 或 `gradual` 到 `/api/player/output`。公网 Remote 使用经过 typed 协议权限校验的 `output.set_offset_mode`；不提供远程登记、探测或目标选择。Host 独占 `/api/purek/*` 的原有受控实验接口，默认 L0 行为保留；共享输出活动期间拒绝并行手动 start。

## P1 / P2 实验接口

以下 POST 接口沿用 Host 身份与请求保护，Remote 不可调用。请求和响应不接受或暴露媒体文件路径、接收端控制地址或 capability URI。

| 路径 | 请求 | 行为 |
| --- | --- | --- |
| `/api/purek/output/start` | `{"experimental":true,"pipeline":"L1","framing":"close"}` | 从当前已缓存歌曲及播放器观测位置开始；`pipeline` 可省略（L0），`framing` 可省略或为 `chunked` |
| `/api/purek/output/stop` | `{}` | 取消管线、作废旧 URI，然后停止本会话的房台播放；空闲停止不控制房台 |
| `/api/purek/output/pause` | `{}` | 采用暂停方案 B：取消输出并发送 Stop；再次 start 创建新 URI，从当前本地观测位置开始 |
| `/api/purek/output/set_offset_mode` | `{"mode":"splice"}` | `splice` / `gradual`；L1 在原 URI 内生效；活动 L0 拒绝 `gradual` |

start 要求有效连接及对应授权、存在 AVTransport、用户显式选择实验性输出、当前歌曲缓存就绪且视频为 H.264。Sink 声明为空、查询失败或未列出兼容 MPEG-TS 时，仍可明确发起试播；原始声明、查询错误和 `unverified` 状态保留，不据此把 `supports_*` 或 `qualified` 改为 true。HEVC 显式拒绝。L0 要求选中音轨为 AAC-LC 单/双声道，offset=0、key shift=0、volume=100 且未静音。其他设置返回 `purek_output_l1_required`，不改写本地设置。L1 显式指定，不自动降级或转码视频；缺少当前 companion 能力时失败。

控制顺序是 Stop → SetAVTransportURI（转义后的 DIDL-Lite）→ Play；开始前的 Stop 只用于清除旧会话，仅在 HTTP 500 的有效 SOAP Fault 中存在唯一、格式正确的 UPnP 701 时容忍，并在安全诊断中标记该决定；网络、HTTP、畸形回复及其他 SOAP 错误保留真实 Stop 阶段并中止，不继续发送新 URI。只有实际 SOAP Fault 才允许空元数据重试一次，HTTP 错误、重定向或畸形 XML 不触发重试。两级管线均不发送 Pause。输出仅在 Play 接受且实际发送 TS 字节后进入 `streaming`。所有网络操作位于 AppState 锁外；busy 一直保持到 SOAP 操作或失败回滚完成，看到终态但 busy 仍为真时不能重启。

每次会话固定歌曲、缓存版本和节目生命周期。L0 另固定音轨、playback generation 和播放设置；它们变化会取消旧流并报告 `purek_output_context_changed`，需要显式重新 start。L1 接受现有 AppState 的音轨、AV delay、变调、音量/静音更新；音轨选择保留本地 playback generation 原有递增规则，独立的 Rust 输出节目代次仅排除该类选择。切歌、分P、跳转/重唱仍会使两级旧流失效，不自动重启。GetTransportInfo 每两秒检查，连续三次停止/网络失败会收尾；管线结束且房台报告停止为正常结束，其余为 `purek_output_interrupted`。接收端以 SOAP Fault 或非标准响应拒绝 GetTransportInfo 时停用状态查询，改由实际交付判断：管线结束且接收端读完队列为正常结束，接收端持续十五秒没有拉流连接为 `purek_output_interrupted`。没有拉流、封装失败或失联均显式报告错误，本地/双屏/HDMI 行为保留。

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

所有网络 XML（二维码或手填地址的设备描述、SSDP LOCATION 描述、授权 SOAP/Fault、能力查询与媒体控制/状态响应）统一经过 `protocol::xml()`。解析前按现有 HTTP 正文预算检查 1 MiB 字节上限，并以线性、固定空间预扫描限制元素嵌套至 64 层（根为第 1 层，自闭合元素也占一层），避免递归 XML 解析器栈溢出。扫描识别注释、CDATA、处理指令及属性引号，拒绝 DTD、未闭合或无法安全识别的标签；完整语法仍由 XML 解析器验证。超限返回现有结构化 `ApiError`，不截断后继续解析，也不在错误信息中回显原始 XML；调用方保留现有阶段错误分类。

媒体端点绑定接收端可达的本机 IPv4 和系统临时端口，每次 start 使用新的 128 bit 随机 capability。仅授权接收端源 IP 可访问；其他 IP 返回 403 并只累计计数，不记录 URL。URI 不出现在状态投影或日志中，取消后监听器和已连接发送线程结束。最多四条并发探测连接、一个 GET 消费者，请求头上限 8 KiB/两秒。

HEAD 与 GET 返回相同媒体头；无 Content-Length，Range 统一返回 200 全流，`Content-Type` 使用本次选定的 `video/MP2T` 或 `video/mpeg`，DLNA Streaming 头。支持 close 和 chunked 两种分帧用于 G2 比较。发送按时间轴一倍速、每条连接开头最多两秒突发；队列同时受四秒跨度和 16 MiB 限制，满时可取消地暂停生产，单 GOP 同受 16 MiB 限制。重连只从下一个未发送的关键帧开始，丢弃此前非关键帧，不重放旧数据。接收端暂停读取（例如正在打开解码器）时按 TCP 背压等待，不因短时阻塞断开；连续 15 秒没有写入进展才断开该连接，取消输出则立即结束发送。Windows 接受的连接显式恢复为阻塞模式读取请求，媒体写入使用非阻塞循环，不依赖发送超时。

### 诊断轨迹

Rust 在 `RoomState` 内保留有界、仅 Host 可见的纯 K 诊断，由“复制诊断报告”与诊断 ZIP 的 `diagnostics.purek` 输出，不另建日志系统：

- 最近六次连接：路由、设备描述、登记接口、`SetDeviceAuthorization`、登记后复查、SSDP 与能力查询各阶段的结果、稳定错误码、安全 HTTP 状态、超时/连接失败类别、结构有效的 UPnP 错误码与耗时，以及是否建议重试。另记录本机地址类别（私有、回环、链路本地、共享、基准测试网段等）和与接收端是否同一 /24，不记录任一地址。存活检查释放连接时记录原因类别。
- 当前与上一次输出尝试：平台、管线级别、分帧、MIME、`GetProtocolInfo` 状态（未检查/已报告/空/不可用）及格式类别摘要、媒体预检与编码名称、监听就绪、TS 首包与结束状态、HEAD/GET/拉流次数、拒绝的来源（含同一 /24 的类别计数）、404/405/409/410/请求头不完整/超出连接数计数、成功写入的字节数与首字节时间、断开类别、`Stop`/`SetAVTransportURI`/`Play` 结果、`GetTransportInfo` 次数与最后状态，以及稳定错误码、失败阶段和耗时。所有时间使用单调时钟。

失败阶段区分媒体准备、播放中途的媒体管线失败、控制命令、电视未拉流、拉流被拒绝或中断、已写入数据但电视播放未确认、电视播放随后停止。“已写入”只表示数据进入本机套接字，不代表电视解码或出画。开始播放 10 秒仍未交付媒体时按接收端实际行为报告 `purek_output_not_requested`、`purek_output_request_rejected` 或 `purek_output_no_delivery`，只有管线结束才报告 `purek_output_pipeline`；均不推断根因。登记时 HTTP 500 的 SOAP Fault 报告为 `purek_authorization`，其他非 200 仍为 `purek_http`。

Host 的房间弹窗与媒体输出说明区显示本地化失败阶段和稳定错误码；Remote 仍只收到原有错误码。轨迹不包含接收端/本机地址、流 URL 与 capability、房间标识、UDN、二维码内容、授权链接、Cookie、凭据、HTTP 正文或 SOAP 负载。

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

1. G0：在目标桌面平台、真实房间 Wi-Fi 和官方授权完成后连接。检查输出投影中的服务存在性及 `sink_formats`，并与弹窗结果核对；记录型号、固件、平台、样本和测试时间。无 AVTransport 时停止 DLNA 路线。空声明、查询失败或非空声明未列出兼容 MPEG-TS 均保留各自的真实诊断；满足本地媒体及编码能力要求后，可由用户明确试播，不自动开始或切换本地输出，也不将试播成功直接当作设备资格认证。
2. G1：在独立受控的短文件试播实验中分别验证 H.264+AAC MP4 与 TS；记录电视画面/音响结果、GET/HEAD/Range 行为、MIME 和 DLNA 头。当前探测接口不执行此实验，需后续实机试播工作包完成。
3. P1 软件可用于受控实验，但不代替 G0/G1。G2 必须用单 URI 连续播放至少三十分钟，分别测试两种 HTTP 发送方式，记录首帧、缓冲、暂停方案 A 和断开重连。G2b 另测同 URI 切歌和跳转。未通过前保持实验性，采用显式停止和重建 URI。P2 软件实现保持显式 experimental，不视为通过 G2。G3 仍需对真实房台执行两种 offset 模式的 +150 → 0 → −150ms、音轨和变调操作，核对画面、音响、P50/P95 调节延迟、静音/卡顿次数与 TS 时间轴；没有实测值时保留 null 和 false。G4 决定正式支持范围。

libav 必须检查对应平台 CI 产物中的 `records/config_components.h`，确认 `CONFIG_MPEGTS_MUXER`、`CONFIG_AAC_ENCODER`、`CONFIG_H264_MP4TOANNEXB_BSF` 均为 `1`。其他平台或历史本机 prefix 的记录不能替代该平台验证；产品中不得执行 FFmpeg/ffprobe 程序。

`GetProtocolInfo` 的 Source/Sink 含义与 CSV protocolInfo 格式依据 [UPnP ConnectionManager:3](https://www.upnp.org/specs/av/UPnP-av-ConnectionManager-v3-Service-20101231.pdf)。

### 普通 DLNA 模拟验证

在 Remote 的“KTV 房间 → 扫描房间二维码”取得一次性 Host 批准后，
展开高级入口输入普通 DLNA 描述 URL，例如
`http://192.168.1.10:8200/description.xml`，点击“继续”和“检查连接”。
无需二维码、微信授权或自动发现。连接后仍由 Host 明确启用实验性 DLNA。
描述地址须使用内网 IPv4，不能包含账号、查询参数或片段。

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

### PUREK-P1-A transport reconciliation

GetTransportInfo is advisory when valid STOPPED/PAUSED_PLAYBACK/NO_MEDIA_PRESENT
or an unsupported endpoint contradicts current HTTP delivery. A consumer must
have actual recent byte progress, bounded by the existing 15-second writer stall
limit. An open GET alone is insufficient. Polls continue after unsupported
monitoring so a later definite HTTP/network control failure still terminates.
HTTP 404 is unsupported monitoring; other definite HTTP/network failures retain
the three-poll failure path. Explicit Stop and generation/context invalidation
remain immediate. Linux native TS receiver fixtures cover sustained contradictory
states, 404/nonstandard replies, disconnect and definite control failure for
both Pure K and ordinary DLNA. This is sender evidence, not TV decode acceptance.

### PUREK-P1-B sender completion

A successful producer EOF, empty queue and exited consumer, after actual Play
and delivered bytes, starts a two-second sender settlement. Any renewed queue
or consumer activity resets it. When control is reachable/advisory, sender
completion follows the existing generation-checked controller.finish -> Stop
and resource release -> next-song path even if SOAP stays PLAYING. Definite
control failure keeps precedence and cannot be relabeled normal completion.
This reports completed delivery by the sender, never proof of TV playback end.

Native Pure K/DLNA fixtures exercise permanent PLAYING and STOPPED, a brief
receiver read blockage, complete HTTP bodies, Stop-before-next publication, user
Next inside the second settle interval, and old-generation non-advancement of
an uncached item. Unit tests cover late packets resetting settlement; existing
controller/restart and real socket backpressure tests remain required.


## 无接收设备的独立管线测试

`POST /api/player/output` 的 `target: "native", experimental: true` 是 Host-only
的明确操作；它复用 Rust AppState、L1 libav 音频处理、控制 generation、曲目／
设置签名和输出平台生命周期。无需建立 Pure K 候选，不发送 SOAP。音量、音调、
音轨、定位、暂停和切歌继续由同一权威控制器处理；回到 `local` 恢复保留的 Web
媒体节点。实际接收端输出 `purek` 仍使用原有接收准入和每代流能力。

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
快速重试时保持非重叠的 PROGRAM-DATE-TIME；旧 generation 的播放列表/结束反馈失效。
失败的解码器资源可经明确重试重新加载；不延长防抖或用发送完成推断播完。
同一运行已经记录管线或解码错误时，预览取消／失联收尾保留该原始错误，
不会再用 `purek_output_preview_lost` 覆盖。只有此前没有失败时才记录预览失联；
明确重试创建新运行后，才清除旧错误。

连续输入回归使用连续 PCM 时间轴重新编码的 AAC 夹具；循环流复制产生的
priming 时间缺口不能冒充连续输入。另用实际解码的缺口输入验证 `InvalidMedia`，
不放宽连续性检查或自动插入静音。
