# 更新公告

原生桌面 Host 与 Android Host 共用可滚动公告板。设置 → 高级与系统维护 → 应用更新旁的「更新公告」可随时手动打开。不向 Remote 推送弹窗，也不为旧 Python Host 增加业务逻辑副本。

## 展示规则

- 启动取得有效 Host 状态、完成上一场选择且没有其他模态框/全屏时，后台检查一次；不等待应用更新接口，不依赖「自动检查更新」开关。不做周期轮询，不暂停或重建播放器。
- **版本公告**：自动展示 `version` 与已安装应用版本一致、且本机没有展示过的条目。支持版本标签前的 `v`。不会因服务器发布更高版本而弹出其更新内容。无法确定安装版本的开发构建不自动弹版本公告。
- **限时公告**：`starts_at <= 当前时间 < ends_at` 才参与自动展示。时间必须为带时区的 RFC3339，按 Host 系统时钟判断。请保持设备时间准确；已结束的缓存通知不会因离线继续自动弹出。
- 合并一个窗口：仍有效的限时公告置顶，组内按发布时间倒序；其余按发布时间倒序。同时间用 ID 稳定排序。
- 至少有一条未展示的有效公告才自动弹窗，同时展示其他仍有效的限时通知。成功显示即记录整个批次，不要求逐条滚到底。右上角关闭、Escape、Android 返回均可随时退出。
- 手动查看包含已发布版本历史和已结束通知（标记「已结束」），不含尚未开始的限时通知或尚未发布的条目。可看到已发布新版本说明，但不把它当已安装版本自动弹出。
- `platforms: []` 为所有平台，可指定 `windows`、`macos`、`linux`、`android`。
- 展示记录在私有数据目录 `announcements.json`，独立于场次、歌曲缓存和 WebView 端口。重启、新建场次、清理歌曲缓存不重置。相同 ID 修正文案不重弹；需要再次通知时发布**新 ID**。卸载清除数据或手动删除数据目录会丢失记录。
- 本地记录损坏/不可写不阻止启动，也不覆盖损坏文件。停止自动弹出，允许手动阅读并显示存储提示。最多保存 4096 个已展示 ID，达到上限报错，不淘汰旧 ID 导致重弹。

## 内容与发布

线上入口：`https://download.kevinx96.icu/bilikara/announcements/index.json`。

在 `announcements/index.json` 编辑真实公告，格式参考 `announcements/example.json`。**示例不是实际服务异常，不要直接发布示例文件。** 当前 index 包含 v0.8.0-preview.3 公告（保留 preview.2 全部更新，并说明其双屏问题与撤回原因），并保留用户授权的公告板限时测试：2026-09-27 15:23:56 至当日 24:00（日本时间 UTC+9），不代表服务异常。过期后只在手动历史中显示。

字段为 `schema_version: 1`、`announcements` 数组、不可复用的 `id`、`kind`、`published_at`、`platforms`、`title`、`body_markdown`。后两项为 zh/en/ja 字典，至少一种语言。优先当前语言，缺失时按 en → zh → ja 回退。

- release 必须有 `version`，不带起止时间。
- notice 必须有 `starts_at`、`ends_at`，不带版本号，且开始早于结束。
- 文件不超过 512 KiB、128 条；单语正文不超过 16 KiB，标题 512 字节，ID 不超过 96 个 ASCII 字母/数字/点/下划线/连字符。历史满了可从服务端归档旧正文，但**不要回收 ID**。
- 正文支持段落、标题、列表、粗体、行内/围栏代码及 http(s) 链接，不支持原始 HTML、图片、iframe、脚本。不自动请求第三方资源；主动点击复用现有外链适配器。桌面打开系统浏览器，Android 当前仍提示在其他设备打开，不把 Host 导航离开播放页。

发布前用客户端的同一 Rust 校验器检查：

```powershell
cargo run --manifest-path rust-runtime/Cargo.toml --locked --features native-host --example validate_announcements -- announcements/index.json
```

工作流 `.github/workflows/announcements.yml`：PR 只校验；手动运行默认也只校验。选中 `publish` 才上传**当前所选分支**的 index.json，须先核对分支和内容。复用现有 `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` 和可选 `R2_BUCKET`（默认 bilikara-releases）。只覆盖 `bilikara/announcements/index.json` 一个对象，不会 sync/delete 整桶，不会随版本发布自动制造公告。内容回滚使用 Git 历史。

GitHub 的手动工作流需要先进入仓库默认分支；仅推送到 `dev` 不会使它立即可手动触发。首次发布已在本机通过上述 Rust 校验，再使用具有该 R2 桶权限的 Wrangler 登录上传同一个文件：

```powershell
wrangler r2 object put bilikara-releases/bilikara/announcements/index.json --remote --file announcements/index.json --content-type 'application/json; charset=utf-8' --cache-control 'public, max-age=300, must-revalidate'
```

2026-09-27 已完成首次发布及下述精确路径 Cache Rule，实测公网响应从 MISS 转为 HIT；部署与本机环境验证详见 [验证记录](announcements-validation.md)。以后沿用规则，不要重复创建。

首次上线前确认 download.kevinx96.icu 已绑定这个 R2 bucket，为**精确路径** `/bilikara/announcements/index.json` 设置 Cache Rule：Eligible for cache，尊重 `Cache-Control: public, max-age=300, must-revalidate`（或固定 Edge TTL 300 秒）。JSON 默认不一定进入 CDN 缓存。不要使用开发用途的 r2.dev 或依赖目录列表。本功能不自动改 Cloudflare 账号配置，不新增 Worker 路由或 D1 表。

上传成功与公网可读是两件事：部署后检查 HTTP 200、JSON Content-Type、ETag、Cache-Control，并确认 If-None-Match 可返回 304，再验收真实桌面/Android 安装。首次未上传时 404 为静默非阻塞失败，可以稍后从设置重试。

## 请求量与失效策略

- 每次启动至多一次正常检查；并发检查合并。成功结果跨重启缓存 5 分钟，失败在本进程也冷却 5 分钟。5 分钟内反复打开只读本机数据。不是后台每 5 分钟轮询。
- 过期后的下一次启动/手动查看最多 **1 次外部 HTTP GET**，带保存的 ETag；304 不下载正文。正文内联，不逐条下载 .md、不列举 bucket、无 GitHub/Sheets 回源或额外重试链。
- **D1：0 查询、0 rows read、0 rows written。Worker 业务 API：0 次。** R2/CDN 读取仍可能有费用：CDN 命中不读源站，未命中/重验证可能产生 R2 Class B 操作。ETag 节省响应体，不消除请求计费。
- 展示确认只写本机 JSON，不访问 R2/D1。网络失败仍可使用旧缓存并提示；没有缓存时自动检查静默，手动入口显示错误。
- CDN 5 分钟与本机 5 分钟缓存叠加，在线检查最坏约 10 分钟才能看到新内容；已打开且不再次检查的 Host 不会主动得知后续公告。紧急通知须预留时间或手动打开；实时推送不在本版范围。

参考：[R2 公共存储桶与缓存](https://developers.cloudflare.com/r2/buckets/public-buckets/)、[R2 计费](https://developers.cloudflare.com/r2/pricing/)。

## 验证

```powershell
cargo test --manifest-path rust/Cargo.toml --locked announcement_policy
cargo test --manifest-path rust-runtime/Cargo.toml --locked --features native-host announcements
node --check static/announcements.js
node tests/announcements_browser.cjs
python -m unittest discover -s tests -p test_copy_i18n.py -v
```

浏览器检查需要 Playwright/Chromium。测试使用离线样例和回环 HTTP，不发布测试通知、不请求线上公告或数据库。Android 返回键和包版本来源仍需 APK 实机验收。
