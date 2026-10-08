# bilikara

`bilikara` 是一个支持 Bilibili 与 YouTube 视频的卡拉 OK 点歌平台。主要由 OpenAI Codex 协助设计与实现，并经过人工整理、验证与迭代。

[下载桌面版](https://github.com/VZRXS/bilikara/releases) · [开始使用](#开始使用) · [快速说明与常见问题](docs/quick-start.md) · [开发文档](#开发)

> [!IMPORTANT]
> **从 v0.8.0-preview.2 及更早版本升级时，请下载对应系统与架构的完整包，并保留旧数据。** 简要步骤见 [升级说明](docs/upgrading.md)。

<p align="center">
  <img src="images/host.png" alt="Host 主界面：左侧播放，右侧点歌队列与工作区导航" width="1000"><br>
  <sub>电脑播放与管理，手机参与点歌</sub>
</p>

## 开始使用

1. 从 [Releases](https://github.com/VZRXS/bilikara/releases) 下载并解压对应平台的完整包，Windows 打开 `bilikara-desktop.exe`，macOS 打开 `bilikara-desktop.app`。
2. 在「本场用户」添加参与者，选择点歌人，再粘贴 Bilibili / YouTube 视频链接或 BV / av 号；也可搜索和浏览曲库。缓存完成后开始播放。
3. 手机与电脑连接同一网络，打开电脑右上角「手机点歌」并扫码。异地使用时，先创建公网房间，再通过公网入口和房间密码连接。

> [!NOTE]
> **macOS 首次打开被系统拦截时**，先尝试打开 App，再前往「系统设置 → 隐私与安全性 → 安全性」，找到 bilikara 并点击「仍要打开」，按系统提示确认。完成一次授权后即可正常启动。

手机连接、来源拉取、轮转排序和旧场次导出等具体用法见 [快速说明与常见问题](docs/quick-start.md)。
公网网页能打开仍不保证设备间可连接；连接阶段、网络限制和管理员可选 TURN 见 [公网 Remote 网络说明](docs/internet-remote-network.md)。

## 找歌与点歌

- **快速点歌**：支持 Bilibili 链接、BV / av 号、b23.tv 分享文案及常见 YouTube 单视频链接；可点歌或顶到下一首。
- **搜索与发现**：搜索共享曲库或本地曲库，按类别、作品名、歌手浏览；点击封面查看歌曲详情。
- **来源与试试运气**：按 UID 拉取 UP 主稿件、收藏夹等元数据，供来源、本地搜索与试试运气共用；共享曲库、类别和歌手浏览使用在线共享数据库。拉取任务排队处理，失败可重试。
- **分 P 与音轨**：选择视频画面和音频轨道，播放时随时切换原唱、伴奏等音轨。

<p align="center">
  <img src="images/remote_search.png" alt="手机搜索共享曲库，点击封面查看详情并点歌" width="280"><br>
  <sub>搜索共享曲库</sub>
</p>

<p align="center">
  <img src="images/host_categories.png" alt="Host 发现页：类别封面列表可向下滚动" width="460"><br>
  <sub>发现 → 类别：向下滚动浏览更多主题</sub>
</p>

## 手机控制

扫码并选择本场身份后，手机可以点歌、调整队列和控制播放。轻点编号可查看拖动提示，按住编号或手柄上下拖动，松手后提交；也可使用歌曲右侧菜单移除或顶歌。队列被其他设备改动时会提示重新拖动。

<p align="center">
  <img src="images/remote_top.png" alt="手机快速点歌与队列" width="280"><br>
  <sub>点歌与管理队列</sub>
</p>

点击底部播放栏展开控制抽屉，可暂停、切歌、前后跳转 15 秒、切换音轨，或调整音量、音画延迟和升降调。**从抽屉右上角「评价」进入视频打分**，为已播放的歌曲选择 1～5 星。

<p align="center">
  <img src="images/remote_control_panel.png" alt="播放控制抽屉：音轨、进度、音量、音画延迟与升降调" width="280"><br>
  <sub>播放控制</sub>
</p>

## 组织一场点歌

电脑的「本场用户」定义轮转顺序，支持多选、批量拖动和删除，以及改名。改名同步到绑定同一身份的手机；已有歌曲、历史与导出保留点歌时的名字，之后点的歌使用新名字。Remote 可以修改自己的名字，整场名单由电脑管理，避免多人误操作。

普通点歌按用户轮转；「顶歌」放到下一首，「立即播放」会替换当前节目，拖动排序保留人工安排。需要恢复轮转时使用「重新排序」。重新打开软件时，选择继续上一场可保留队列；关闭提示或等待倒计时结束会开新一场，旧场次记录仍保留。

## 历史与歌单导出

历史记录保留点过的歌曲，方便重新点歌。Host 和已登记身份的本地 Remote 可在 **「历史记录 → 导出」** 选择本场已播放记录、按日期归档的指定场次，或累计点歌历史，保存为 CSV 或歌单图片；多页图片打包为 ZIP。结束一场并重新打开后仍可选择旧场次。指定场次只包含该场的记录，不混入更早场次。公网 Remote 不支持歌单导出。

<p align="center">
  <img src="images/playlist_export.png" alt="仅导出所选场次的示例歌单" width="600">
</p>

## 全屏与双屏播放

单屏可直接全屏播放；连接电视或投影仪后，在右上角「双屏显示」中选择观众屏，电脑保留点歌与播放控制。可点击「识别屏幕」查看各屏编号。观众屏和全屏画面均可显示手机点歌二维码，其他人随时扫码加入；收到新点歌时，左上角会显示歌曲提示。

**双屏模式需在系统显示设置中选择「扩展」，不能使用「复制」或镜像模式。** Windows 可按 `Win + P` 选择「扩展」。

<p align="center">
  <img src="images/fullscreen.png" alt="全屏播放与右上角手机点歌二维码" width="960"><br>
  <sub>全屏播放与扫码入口；双屏的连接与设置见快速说明</sub>
</p>

## 设置与维护

「运行设置」可扫码登录 Bilibili、选择清晰度与下载器、调整缓存数量和切歌延迟；「设置」可切换中英日语言、三种主题，以及检查更新、查看公告和导出诊断信息。

<table>
  <tr>
    <td align="center" valign="top" width="40%">
      <img src="images/server_settings.png" alt="运行设置：Bilibili 登录二维码与 1080P 高帧率清晰度" width="360"><br>
      <sub>运行设置与扫码登录</sub>
    </td>
    <td align="center" valign="top" width="60%">
      <img src="images/ui_settings.png" alt="Host 设置页：语言、主题、更新与维护" width="600"><br>
      <sub>语言、外观与维护</sub>
    </td>
  </tr>
</table>

- 歌曲会提前缓存，失败后可重试；退出后清理播放缓存，歌单和播放器设置会保留。
- 默认使用内置 Rust Native，也可选择 BBDown 或 DownKyi / aria2c。Bilibili 登录二维码过期后自动刷新，凭据保存在本机，请勿分享登录凭据或完整数据目录。
- 遇到播放或启动问题，可在设置中导出诊断包。Windows 数据位于应用旁的 `runtime/data/`；macOS 位于 `~/Library/Application Support/bilikara/data/`。

## 开发

桌面版使用 Rust 后端与 Tauri 窗口，Host / Remote 共用网页界面。构建步骤、依赖和运行参数集中在以下文档：

- [原生桌面与本地构建](docs/native-desktop.md) · [macOS 开发包验收](docs/macos_testing.md)
- [媒体依赖与打包](media-libav/PACKAGING.md) · [构建工作流](.github/workflows/ci-bundle.yml)
- [版本路线图](docs/version-roadmap.md) · [共享曲库](docs/shared-catalog.md)
- [Source 开发与兼容边界](docs/source-compatibility.md)

## 致谢

- [BBDown](https://github.com/nilaoda/BBDown)
- [FFmpeg](https://github.com/FFmpeg/FFmpeg)

## License 与使用边界

本项目采用 [MIT License](LICENSE)。该许可仅适用于本项目自身的源代码和文档，不授予任何 B 站内容、音乐、视频、歌词、封面、字幕、公开播放、下载缓存、商业使用或第三方平台服务的授权。

`bilikara` 是用于本地 / 局域网卡拉 OK 点歌与播放管理的工具，不是 B 站下载器，也不应被作为视频、音频或其他平台内容的下载、保存、分发工具使用。

本地缓存仅服务于当前播放流程。服务退出后会自动清理已缓存内容；缓存媒体不属于本项目授权范围，相关权利仍归原权利人或对应平台所有。

使用者应自行确保使用场景符合相关法律法规、平台规则、版权要求，以及公开播放 / 商业使用所需的许可。请勿将本项目用于未经授权的下载、缓存、传播、公开播放、商业放映、规避访问限制、批量抓取或其他可能侵犯第三方权益或违反平台规则的用途。

更完整的法律边界、第三方工具说明和责任说明请阅读 [LEGAL.md](LEGAL.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
