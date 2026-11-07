# 给 Worker 开发代理的 TURN 接入任务

需要修改独立的 `kevinx96/bilikara-internet-remote-worker`，不是在 Host 设置里添加一个 STUN/TURN 开关。
当前应用已经接收信令服务下发的 `ice.config`，并由 ICE 自动选择直连或中继。
Worker 目前负责房间和信令，缺少的是向 TURN 服务签发、下发有期限凭据的实现。
以下 prompt 可以直接交给在该 Worker 仓库工作的开发代理。

这份文档不是部署记录。修改 Worker 代码后，还需要管理员建立 TURN 服务、配置服务端 secret，并实际部署。
只改 Worker 而没有可用的 TURN 服务和凭据，仍不能穿过 AP 隔离。

## 可直接复制的 prompt

```text
请在当前 bilikara-internet-remote-worker 仓库实现可选的 Cloudflare Realtime TURN 凭据签发。
先阅读本仓库 AGENTS.md、src/index.ts、src/security.ts、src/room_lifetime.ts、现有测试和 Wrangler 配置。
保留现有房间创建/关闭、1–24 小时有效期、Host 断开宽限、WebSocket hibernation、限流和静态资源发布行为。
不要修改另一个 bilikara 应用仓库的业务逻辑，不要执行部署或写入真实 secret。

一、管理员配置与 provider

- 新增 TURN_ENABLED、TURN_KEY_ID、TURN_KEY_API_TOKEN 配置；API token 只能通过 Worker secret 提供。
  TURN_ENABLED=false/未配置时完全保留旧行为；启用却缺少/无效配置必须明确失败，不能静默退回 STUN。
- TURN provider 的 origin、路径、域名、端口和 TTL 由服务端代码/经过验证的管理员配置决定。
  不接受浏览器提交的 provider URL、TURN 地址、TTL 或额外请求头。
- 通过固定 HTTPS endpoint 调用：
  POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers
  Authorization: Bearer <TURN_KEY_API_TOKEN>
  Content-Type: application/json
  body: { "ttl": <服务端计算的秒数> }
- KEY_ID 必须作为单个安全路径段验证/编码。拒绝重定向；请求有总超时、响应大小和 JSON 形状限制。
  只接受成功状态及合法 iceServers；错误正文、token、username、credential 不进入日志/客户端错误。
- 白名单仅允许预期 Cloudflare STUN/TURN 主机和端口，保留 UDP、TCP 和 TLS/TCP 443 入口。
  例如 stun:stun.cloudflare.com:3478、turn:turn.cloudflare.com:3478?transport=udp、
  turn:turn.cloudflare.com:3478?transport=tcp、turns:turn.cloudflare.com:443?transport=tcp。
  过滤浏览器不支持的端口，不添加公共免鉴权 TURN。

二、在现有已鉴别 WebSocket 上下发，兼容应用当前协议

服务端消息必须严格为：
{
  "type": "ice.config",
  "payload": {
    "expires_at": <Unix 毫秒整数>,
    "ice_servers": [
      { "urls": ["stun:stun.cloudflare.com:3478"] },
      {
        "urls": [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp"
        ],
        "username": "<provider 签发的有限期用户名>",
        "credential": "<provider 签发的有限期密码>"
      }
    ]
  }
}

- 不带 from。payload 不得新增 ttl、iceServers、credentialType 等键。
  expires_at 是配置的保守缓存截止时刻：接收时剩余 30–600 秒，建议 300 秒，
  并且不晚于房间截止和底层凭据的保守截止时刻。
  payload 至多 16 KiB，至多 4 个 server、合计 8 个 URL；urls 必须为非空数组。
  STUN 条目不带 username/credential；TURN 的两个字段各 1–256 字符，不含空白或控制字符。
- 只有通过现有 role、room、bearer hash、Origin、peer 和容量检查的 socket 才能得到配置。
  Remote 的 bootstrap 使用现有 join bearer；不要把房间密码交给 Worker，也不要把 Host bearer 交给 Remote。
  密码是在 DataChannel 建立后验证的，因此 bearer 持有人在密码验证前可能消耗中继资源，必须限流。
- Host 必须先收到有效配置，才能收到会触发 createPeer 的 peer.join；Remote 必须先收到配置，才能收到 offer。
  特别覆盖 Remote 刚升级 socket 时 Host 立即发 offer、已有 Host 配置缓存过期后新 Remote 加入的竞态。
  在连接具备配置前，不要提前广播 presence 或向它转发 offer；必要的等待按 peer 有界管理。
- 不能把 peer 发来的 ice.config 当作服务配置。保持 parseSignal 白名单，服务端保留该 type 的唯一发送权。
- TURN 已启用但签发/验证失败时，向相关 socket 明确发送 {"type":"ice.config","payload":null}，
  阻止该次协商并有界关闭/失败；不能靠省略消息让新客户端悄悄使用默认 STUN。
  未启用 TURN 的旧部署不发送该消息；旧客户端可忽略新增服务消息，不改变旧 offer/candidate 格式。

三、缓存、生命周期与成本边界

- 缓存与并发合并作用域至少包含 roomId、role、peerId；配置发送前还要核对当前 connectionId/连接代次。
  同一作用域至多一个 provider 调用进行中。被替换的连接、已关闭/到期房间不能收到旧异步结果。
  房间关闭/过期后清理作用域；尊重 Host reconnect deadline，不复活旧房间。
- provider 网络调用不能放进 ctx.blockConcurrencyWhile，不能持有全房间串行锁等待网络。
  单个 peer 的慢签发不能阻塞已连接用户的信令或健康会话。
- 对 IP、房间、peer/socket 和全局设置明确的预算；重复连接不能绕过预算。
  provider 超时、429、错误结构均有界失败，不做无限重试、心跳签发或永久轮询。
  DO hibernation/wakeup 后仍维持预算；不要把明文长期 API token 或短期凭据存进 socket attachment/日志。
- 必须区分“配置缓存 300 秒”和“实际 TURN allocation 可以维持多久”。
  Cloudflare 可能在底层凭据过期后断开 allocation；只发 300 秒凭据会让长 KTV 会话几分钟后断开。
  当前房间最长 24 小时，小于 Cloudflare 的 48 小时凭据上限。计算 provider TTL 时覆盖房间剩余寿命，
  扣除有界网络/时钟余量，且不越过房间期限；对剩余不足客户端最小有效窗口的房间拒绝新签发。
  另以最多 300 秒的保守 expires_at 下发配置。有效底层凭据可在同一作用域内复用，
  不需要为了更新配置缓存时间重复调用 provider。管理员若限制更短 TTL，必须明确长会话的续期/重连设计，
  不能只调用 setConfiguration 就宣称现存 allocation 已续期。
- 房间关闭时，如果采用 provider revoke，须有界、可失败且不阻塞房间关闭；记录不含秘密的结果。
  即使支持 revoke，也不能宣称已证明立即回收所有已建立 allocation。给出泄露凭据和中继带宽的预算说明。

四、测试与交付

- 用本地 provider fixture 验证正常签发、TTL/单位/房间期限、白名单 URL、大小/数量/字段校验。
- 覆盖未启用、缺少 secret、错误 secret、provider 429/5xx、超时、重定向、畸形 JSON 和敏感信息脱敏。
- 覆盖 role/Origin/bearer 错误、过期/关闭/容量满房间，确保 provider 根本不被调用。
- 覆盖并发合并、预算耗尽、DO wakeup、旧 connectionId 的迟到结果和关闭中的签发。
- 验证 ice.config 在 peer.join/offer 之前；peer 伪造配置不能被转发；旧客户端兼容。
- 健康连接的状态/心跳不重新签发；长会话跨越配置缓存截止后继续可用；凭据真实期限另行验证。
- 运行本仓库完整类型检查和测试，更新 Env 类型、Wrangler 示例和部署 README。
  环境示例只包含占位符。提供 wrangler secret put 的操作步骤，不读取/打印/提交真实密钥。
- 提交可审阅代码和每项测试结果，列明没有实测的 provider/网络/长期 allocation 行为；不要自行 deploy。

验收：先 direct 允许时正常连接；再在两端无法互访、仅信令和 TURN 可达的网络中，
以 iceTransportPolicy=all 实际选中 nominated relay candidate pair，完成密码验证、状态、点歌和播放控制。
分别阻断 UDP、验证 TCP 与 TLS/TCP 443；错误凭据/不可达 TURN 必须有界失败。
只看到 relay candidate、只完成 WebSocket 或只在家庭同网成功，都不算 AP 隔离验收。
不要使用真实生产房间、收费 provider 或外部账号执行未经授权的验收。
```

## 管理员需要准备什么

在 Cloudflare Realtime TURN 创建自己的 TURN key，取得 key ID 和对应的 API token。
长期 token 留在 Worker secret；浏览器接收的是该 token 签发的短期凭据。
具体创建与调用说明见 [Cloudflare 官方凭据文档](https://developers.cloudflare.com/realtime/turn/generate-credentials/)。

代码准备并测试完成后，在正确的 Worker 环境执行 `wrangler secret put TURN_KEY_API_TOKEN`，
填写自己的 token；在对应环境配置 `TURN_KEY_ID` 和 `TURN_ENABLED`，再按仓库原有发布流程部署。
不要把 secret 放进 git、公共静态资源、Host 设置或房间链接。

Cloudflare 的凭据返回值不包含 TTL 字段，Worker 需要自己记录保守期限。
其凭据期限上限与 allocation 到期行为见 [Cloudflare TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)。
中继带宽计费与 Worker 的信令请求不是同一项成本；启用前应按自己的账户配置预算。

填写用户名、密码后一直等待并超时，可能发生在设备连接或后续认证阶段。
客户端诊断中的 `transport_timeout` / `transport_failed` 加上没有已选 candidate pair，支持“传输未建立”的判断；
`auth_timeout` / `wrong_password` 则表示应继续检查认证，不能一律归因于缺少 TURN。
不必先探测出“AP 隔离”再决定启用中继；提供受信任的 ICE 配置后，浏览器自动选路。

完整客户端合同、诊断字段和隔离测试命令见 [网络与 TURN 说明](internet-remote-network.md)。
