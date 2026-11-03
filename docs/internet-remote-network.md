# 公网 Remote 的网络连接与 TURN

公网网页能打开、房间能创建，表示网页或信令服务可达。手机控制使用
WebRTC DataChannel：Host 和 Remote 先通过信令交换 offer、answer 与 ICE
候选，再由浏览器建立加密连接。队列、状态和控制命令不经过信令 Worker。
管理员配置 TURN 后，这些加密数据可以经过 TURN 中继；它仍不是 Worker
中的 HTTP / WebSocket 命令转发。

Host 在本机打开自己的公网链接，可能使用本机候选完成连接。这不能证明
另一台设备、另一网络或公共 Wi-Fi 可连接。同一 Wi-Fi 下局域网 HTTP
失败也不足以确定原因：AP / 客户端隔离、访客网络、防火墙、地址选择和
路由都可能影响访问。应分别确认网页、信令、ICE、应用认证和身份阶段，
再验证网络假设。仅有 ICE 失败不能诊断 AP 隔离。

## 连接阶段与诊断

连接按以下顺序完成：创建房间 → 信令注册 → offer / answer → ICE
候选与连通性检查 → DTLS 和两条有序 DataChannel → 房间密码 → Rust
Runtime 接纳 peer → 首次状态 → 身份登记或恢复 → 就绪。

| 页面阶段 | 含义与排查方向 |
| --- | --- |
| 连接信令 | 公网信令 socket 尚未完成建立；检查服务、房间和网络可达性。 |
| 等待 Host 连接提议 | 信令已连接，尚未收到当前 Host 的 offer；不能据此认为 peer 网络已连通。 |
| 建立传输连接 | 已开始 offer / answer、ICE 与 DataChannel；网络限制或中继不可达可能阻止这一步。 |
| 验证房间密码 | 两条 DataChannel 已可用，Host 正在验证密码并接纳 peer。 |
| 同步状态与身份 | 已认证，仍需获取首次状态并完成身份登记 / 恢复。 |
| 已连接 | 上述应用步骤已全部完成；ICE connected 或 auth.ok 本身不算就绪。 |
| 连接失败 | 保留固定错误代码和已到达阶段；传输失败、密码错误、认证限流、房间过期、Runtime 拒绝和身份冲突各自处理。 |

初始 SDP gathering 仍最多等待 8 秒。Host 发出 offer 后开始 20 秒传输
期限，两条通道打开后开始 10 秒密码 / Runtime 接纳期限；Remote 的
信令、等待 offer、传输、状态 / 身份同步各有 20 秒期限，密码阶段
10 秒。它们用于区分失败阶段，不用统一加长重试来掩盖连接故障。

Remote 邀请的有效期通知只在密码认证成功后启动；连接失败、断开或重连
会释放该计时器，旧连接的通知不能影响新连接。邀请到期会隐藏分享入口，
不会主动中断已就绪的健康会话，也不会触发信令请求或轮询。

隐私安全的连接诊断只保留相对阶段耗时、ICE / gathering / connection
状态、control / bulk 通道状态、选中的候选类型和浏览器提供的传输 /
relay 协议，以及固定失败代码。只有实际选中候选对包含 `relay` 才能
说此次连接使用了中继；配置 TURN 或 ICE gathering 收集到 relay 候选
都不能证明它被使用。浏览器未提供的统计记为 `unknown`。

诊断不保留 SDP、候选地址、房间链接 / token、密码、TURN 用户名 /
credential、个人名字或 provider secret。不要把完整浏览器控制台、带
二维码的截图或网络请求头当成可公开分享的诊断包。连接统计在阶段转换
和手动诊断时有限读取，不新增持续 `getStats` 轮询。

Host 的「设置 → 导出诊断信息」包含有界连接事件。需要查看 Remote
本次连接时，可在浏览器开发者工具读取
`BilikaraInternetRemoteDiagnostics.getSnapshot()`；它返回上述脱敏快照，
不会读取或上传密码。某些浏览器缺少候选统计时，不应推断连接使用了中继。

## 管理员可选 TURN 配置

未启用配置时保留现有 STUN / direct 路径。配置采用标准
`RTCPeerConnection` 的 `iceTransportPolicy: "all"`，浏览器选择可行候选；
`relay` policy 仅用于受控诊断。无需新增播放器、Runtime 或应用命令通道。
[WebRTC 的 TURN 说明](https://webrtc.org/getting-started/turn-server)
说明了 `iceServers` 与鉴权配置。

TURN 地址必须来自受信任信令服务的管理员配置。房间链接的 query /
fragment、Remote 普通请求、localStorage 和 peer 消息不能选择服务器或
提供 credentials。长期 provider API key 或 coturn shared secret 留在
服务端；浏览器只收到短期 allocation credentials，经 HTTPS / WSS
传送，不写入静态资源、桌面包、URL、日志或持久存储。

密码认证需要先有 DataChannel，所以短期凭据的 bootstrap 使用已有的
Host / join bearer capability。服务先核对现存房间、有效期、已注册
socket 的 role / peer、允许的 Origin 和请求形状，然后才能下发配置。
它不读取房间密码，也不把 Host token 交给 Remote。共享 join token
持有人可以在密码验证前请求建立传输；这是必须由服务端限流和 TURN
配额约束的成本边界，不是房间密码的安全替代。

### 独立 Worker 的最小兼容合同

部署仓库和归属见 [公网资源发布](internet-remote-deployment.md)。应用仓库
不包含该私有 Worker 源码；以下是其待实现的伴随合同，不表示线上已启用。

信令服务在已经鉴别的 WebSocket 上发送一个新增、可忽略的服务消息：

```json
{
  "type": "ice.config",
  "payload": {
    "expires_at": 1790000000000,
    "ice_servers": [
      {
        "urls": ["turn:relay.example.invalid:3478?transport=udp", "turns:relay.example.invalid:5349?transport=tcp"],
        "username": "short-lived-user",
        "credential": "short-lived-credential"
      }
    ]
  }
}
```

此例仅说明格式，不能用于连接。`expires_at` 是 Unix 毫秒；客户端接收时
有效期必须在 30～600 秒内。payload 至多 16 KiB、至多 4 个 server 和
8 个 URL，只允许标准 STUN / TURN scheme，TURN 必须包含有界用户名和
密码（各 1～256 字符，不含控制字符或空白）。服务端期限还必须不晚于
房间过期时间，房间剩余不足 30 秒时拒绝新签发。客户端只接收没有
`from` 的服务消息；不得转发 peer 发来的同名消息作为配置。服务只发送
管理员白名单地址，筛掉 provider 返回的不支持
端口 / 协议，不允许请求体指定 TURN URL 或 TTL。

配置必须在 Host 的 `peer.join` 及 Remote 的 `offer` 之前送达。未配置的
旧 Worker 可以完全不发送此消息，旧 / 新客户端继续使用现有信令、带候选
的 SDP 和 late-candidate 协议，不要求强制版本升级。旧客户端忽略新增
消息。启用 TURN 的新服务若 issuance 失败，不得宣称配置可用、返回匿名
中继或替换成公共免费 TURN；客户端区分配置错误与传输错误。
启用配置后，失败也必须明确发送 `ice.config`（`payload: null`），使新客户端
停止该次协商并提示配置不可用；不能靠省略消息悄悄恢复公共 STUN 默认。

服务必须合并同一作用域的并发 issuance，设置每个 socket / peer、房间、
来源 IP 和全局预算，并在房间关闭 / 过期后停止下发。配置按当前连接代次
使用，重建房间或重连后，旧异步结果不得改动新 peer。下一次连接使用仍
有效的配置或重新签发；健康会话不会因配置缓存过期被客户端主动拆除，
状态推送和心跳不触发签发或永久 Worker 轮询。

Origin 规则按 role 区分：Remote 为实际托管的精确 HTTPS origin，Host
为受支持的桌面 WebView / 本地 Host origin；不能用任意 `Origin: *`
替代审核。Origin 也不能替代 bearer 鉴权。客户端无需新增 credential
请求，服务在原有 socket admission / peer join 中下发配置；每个已鉴别
作用域至多一个进行中的签发，同一未过期结果复用，服务端预算超限必须
明确失败而不反复调用 provider。

**Allocation 寿命需单独验证。** 配置缓存有效期不等于 TURN allocation
可持续的时间；provider 可能在凭据过期后拒绝 allocation Refresh。管理员
必须测试其签发 / 刷新语义，明确长会话行为。不能仅靠浏览器
`setConfiguration()` 就声称已有 allocation 被无缝续期，也不能默认
声称关闭房间能立即撤销已经发出的 credentials。coturn REST 凭据通常
靠期限失效；provider 支持的撤销能力应由其独立服务实现和验证。

关闭房间或 Remote 正常退出时，客户端关闭信令、DataChannel 和 peer，
浏览器可向 TURN 发送 allocation 删除请求。进程被强制结束或网络突然
中断时，请求可能送不到服务器，已有 allocation 会保留到服务端 lifetime
届满。allocation 删除、浏览器资源清理和 credential 撤销是不同操作；
关闭本地测试 relay 进程能释放此次实验资源，不证明生产凭据立即失效。

用户名带房间 ID 并不会把 TURN 限制为该房间的应用数据。泄露的短期凭据
仍可能被用来申请其他 allocation。生产中保留 relay peer ACL，禁止向
loopback、私网、组播和其他保留地址转发，设置用户 / 总 allocation 数量、
带宽 / lifetime 限制与用量预算；本地 fixture 必需的私网许可不能复制
到生产。自建 [coturn](https://github.com/coturn/coturn) 是独立运维依赖，
不随 bilikara 打包。

### TCP / TLS 与费用

`turn:...?transport=tcp` 和 `turns:...?transport=tcp` 分别测试客户端到
TURN 的 TCP 和 TLS。TCP 连接并不表示浏览器使用 RFC 6062 的 TCP relay。
TURN / TLS 的证书必须经系统或隔离测试 CA 信任，不使用忽略证书错误。
443 端口上的 TURN / TLS 不是普通 HTTPS，HTTP 代理或深度协议过滤仍可能
阻止它；本地高端口测试通过不能证明场地允许 443。

Worker 的信令 / credential 签发请求成本和 TURN 的中继带宽成本分开计算。
配置的 `all` policy 会在 ICE gathering 阶段申请 relay 候选，即使最终
选中 direct；不能宣称 direct join 不消耗 TURN 流量。中继只承载小型
状态与控制数据，不包含歌曲媒体下载；仍需包含协议开销、重连和恶意
allocation 的预算。未配置时没有新增 credential fetch / polling；启用后
已有信令 socket 多一个小型配置消息，首次签发和 TURN gathering 可能
增加连接耗时。签发的 provider 调用次数由服务端合并 / 缓存 / 限流控制，
不能从 DataChannel 流量倒推出 Worker 请求费用。
Cloudflare 的 STUN 地址并不自动提供 TURN 凭据；若
选择其托管服务，按其
[短期凭据接口](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
和 [计费说明](https://developers.cloudflare.com/realtime/turn/faq/)
在伴随服务中单独实现。这里的文档链接不是授权开通或调用 provider。

严格只允许 HTTPS 代理的场地可能连 TURN / TLS 也不可用。HTTP /
WebSocket 应用数据中继是另一项架构选择，会增加 Worker 的连接、处理
和数据流量成本；本功能没有实现它。

## 零生产流量本地验证

普通配置、生命周期和同步检查不需要 coturn、容器或 Rust 重建：

```sh
node --test tests/internet_remote_provisioning.test.mjs
npm run test:remote-sync
```

真实浏览器 / 原生 Host 验证复用现有 runner 和已构建的 Host：

```sh
npm run test:native-transport
```

该既有命令需要由调用方置于无外网的测试网络内；不能用其历史 fixture
报告中的固定零转发字段证明 ICE 出口安全。仅做传输验证时，
`BILIKARA_TRANSPORT_HOST` 可显式选择已经构建的原生 Host 绝对路径；需记录
二进制来源和哈希。未设置时仍使用当前 Cargo artifact。

显式隔离 relay 矩阵单独运行，普通 frontend 检查不启动这些资源：

```sh
npm run test:native-relay
# 需要自选证据目录时：
node tests/run_native_relay.mjs --output .tmp/internet-remote-relay
```

前提是 Linux user / network `unshare`、`nsenter` 和 `ip` 可用，仓库固定
版本的 Playwright Chromium 及原生 Host 构建已缓存。测试依赖固定为
Ubuntu coturn `4.5.2-3.1~ubuntu22.04.1`（上游 4.5.2）、iptables-nft
1.8.7 和 NSS `certutil`。`BILIKARA_RELAY_TOOLS` 可指定已经解包的本地
工具目录，或分别设置 `BILIKARA_TEST_TURNSERVER`、
`BILIKARA_TEST_IPTABLES`、`BILIKARA_TEST_IP6TABLES` 和
`BILIKARA_TEST_CERTUTIL`。runner 不自动下载依赖，缺少前提明确报错，
不能跳过后显示 PASS。这些版本用于可重复的本地实验，不是生产 TURN
的版本建议或产品依赖。
默认工具目录为 `.tmp/internet-remote-relay-tools`。需要复用已构建的原生
Host 时设置 `BILIKARA_RELAY_HOST` 为其绝对路径并保留来源 / 哈希证据；
否则 runner 离线选择当前 Cargo 构建产物。

runner 创建一个拥有 user / network namespace 的隔离服务网络，仅有
veth 和 `10.77.0.1` 的第三网服务地址，没有外网接口或默认外网 route。
Host、信令、资源和本地 TURN 服务置于这个隔离资源内。两个浏览器 peer
分别位于不同 netns，地址为 `10.77.1.2` 与 `10.77.2.2`。A 允许两端
forward；B～E 用服务网络的双向 FORWARD DROP 禁止 peer direct。每个
namespace 的 loopback 独立，不能把同机 loopback 当作跨 peer 通路。
IPv6 OUTPUT / FORWARD 被禁，D 再禁止两个 peer 的全部 UDP OUTPUT。
服务网络只允许 loopback 和 `10.77.0.0/16` 的出口，其他目的地 DROP，
并通过 TEST-NET 探针与规则计数验证限制实际生效。规则只属于此次创建
的 namespace，不修改工作站防火墙。

本地 coturn 只监听 / relay 于 `10.77.0.1`：3478 为 UDP / TCP，5349
为 TLS，relay 端口为 49160～49175。每个测试用户最多 2 个 allocation，
总数最多 8 个，并限制带宽；所有 allocation 都使用本次生成的短期鉴权。
测试要求 relay 能转发到 `10.77.0.0/16` 中的 peer，保留禁止 loopback /
组播的限制。这项私网测试许可仅适用于隔离 fixture，生产仍须配置私网
peer ACL。

所有 signaling、asset、STUN、TURN、provider 地址均替换为本地目的地。
信令测试执行既有窄合同 fixture，**没有执行私有 Worker 源码**；fixture
不向外转发。WebRTC 的 ICE 包不受浏览器 fetch / WebSocket 拦截控制，
这里的网络栈 / 出口限制才承担 ICE 流量约束。禁止用公用 TURN 或远程
Worker preview 代替本地依赖。TLS 使用隔离 HOME / NSS profile 信任
本次生成的测试 CA，不更改系统信任、不使用全局证书错误绕过。

| 场景 | 网络与配置 | 必要证据 |
| --- | --- | --- |
| A | direct 允许，无 TURN | 认证、状态、身份和一个无害命令及其结果。 |
| B | peer 双向 direct 禁止，信令可达，无 TURN | 有界传输失败，真实失败 UI，无错误密码或虚假 ready。 |
| C | 同 B，本地鉴权 TURN，普通 `all` policy | 实际 nominated relay candidate pair，并完成 A 的应用交换。 |
| D | 同 C，再禁客户端 UDP | TCP / TLS 分别记录浏览器实际候选证据；TLS 必须信任隔离 CA。 |
| E | direct 禁止，relay 不可达或凭据无效 | 有界失败，socket / timer / peer / allocation 释放，Host 本地控制仍可用。 |

失败场景在终止后额外观察 4000ms 内是否继续建立信令连接，并检查有界
连接资源；这只验证该短窗口的重连行为。它不是长时间 soak、凭据过期 /
撤销测试，也不能证明所有 provider 都立即回收 allocation。正常清理需
先通过实际 Remote disconnect 和 Host 关房操作结束会话，再关闭浏览器，
并单独检查本地 relay 端口 / allocation 清理；不要仅强杀浏览器就报告
正常退出已验证。

完整 AP 隔离模型需要两端处于不同网络栈，二者分别能到达第三网络的信令
与 TURN，但不能互相发送 direct 包。IPv4、IPv6、loopback、mDNS、组播、
host-network 和 NAT hairpin 均不能绕过限制，并需要验证 deny 规则实际
生效。相同网络栈中的两个浏览器、或单独 `relay` policy 只能验证真实
relay，不能作为 AP 隔离复现。无 namespace / container 权限时仍可运行
独立 contract 和受限 forced-relay 检查，但必须标明隔离覆盖不可用。

检查出口目的地和 deny / request 计数，不能靠报告中的常量 `0` 证明
生产流量为零。失败时保留脱敏的诊断、计数和真实 UI 截图于 runner 的
外部 / ignored evidence 目录；默认输出的 `matrix.json` 和截图位于
`.tmp/internet-remote-relay/`。成功时清理自己创建的进程、listener、CA、
profile 和配置；失败时保留用于排查的证据。网络资源退出时释放，不修改
工作站防火墙、TLS 设置或其他会话的 namespace。测试结果以本次实际
输出为准，文档列出要求而不把尚未运行的平台或协议记作 PASS。

本地测试成功只证明该本地模型。应用代码就绪、伴随 Worker 就绪、本地
relay 已验证、公开部署和原场地已验证是五个不同状态。上线最小动作是
管理员在私有 Worker 实现上述短期 issuance 合同与限制，配置自建或托管
TURN 和可信 TLS，发布匹配的公共 Remote 资源并更新 Host。部署及原场地
复测需另行授权，不能由普通本地测试自动触发。
