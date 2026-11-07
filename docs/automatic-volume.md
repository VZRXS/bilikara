# 自动音量（实验性功能）

自动音量是可选的全音轨响度分析，**默认关闭**。它根据 Host 明确设定的基准，调整现有播放音量；不会修改音频文件、转码、改变系统音量，也不是均衡器、压缩器或持续自动增益。

## 第一次使用

1. 在 Host 播放一首熟悉的歌曲。
2. 点击「播放音量」的百分比，打开原有音量调整弹窗，在「自动音量」行启用开关。
3. 歌曲缓存完成后，将音量调到合适水平（建议 50～75%）。没有歌曲或分析尚未完成时，「设为基准」按钮置灰，完成后自动可用。开启后当前音量、静音状态保持原样，**单纯开启不会建立基准**。
4. 点击「设为基准」，以当前歌曲和音量建立基准。设置成功后，当前百分比和静音状态仍保持原样，后续歌曲才会按这个基准自动调整。

Host 始终显示当前状态，包括关闭、待设基准和本曲手动；活动状态使用主题色，关闭和不可用使用普通次要文字色，与 Remote 一致。未设基准时显示「设为基准」按钮；鼠标悬浮按钮或点击「i」可查看说明。设置后按钮变为「更新基准」。

约 **50～75%** 是预留向上调整空间的建议，并非要求。如果更低的音量已经舒服，不必提高；任何 1～100% 的有效音量都可以作为基准。输入音量后先按 Enter 保存，再设定基准。软件分析的是整条音轨，而不是点击按钮时听到的那个片段。

| 弹窗状态 | 含义与操作 |
| --- | --- |
| 尚未设定基准 / 待设基准 | 尚未自动调整。播放已缓存歌曲，等分析完成，再由 Host 明确设为基准。 |
| 正在分析当前音轨 | 播放继续，音量暂时保持原值。完整分析需要时间。 |
| 自动音量 / 自动 | 已使用保存的基准和当前音轨的测量值。 |
| 本曲已手动调节 / 本曲手动 | 本次播放由手动设置优先，基准没有改变。 |
| 当前音轨分析不可用 | 保留音量，可继续手动播放和调节；可以换一首歌设定基准。 |

自动调整最高为 **100%**。特别轻的音轨即使达到 100%，仍可能低于基准。原有显式手动放大至 500% 的操作继续可用。自动输出使用现有的整数百分比，最小非零值为 1%；不会把微小的正值量化成静音。100% 上限并不保证所有音源的峰值不失真。

## 手动调节与更新基准

Host 或 Remote 的手动音量操作，包括手动重置到 100%、0% 和放大，只覆盖**本次播放**。暂停、继续、跳转、刷新页面或同一次播放中切换原声/伴奏都不会取消覆盖；真正换到下一首歌曲后重新自动调整。原声和伴奏分别分析。静音独立保留，自动音量不会取消静音。

Host 保留正在提交的本地音量意图，直到请求完成；不会因固定等待窗口到期而被旧 SSE 状态覆盖。音量、静音、音调及延迟命令依序提交，连续滑块变更合并为最后一个待提交值；切曲时不再发送旧曲排队命令。原生 Host 在同一状态锁内验证歌曲 incarnation，拒绝延迟到达的旧曲命令。音画延迟回包携带版本化状态，按与 SSE 相同的规则接受。iOS 的元素音量读数可能固定为 100%，该读数不替代 Web Audio gain 保存的用户意图；桌面可写的原生音量控制继续有效。

Host 有两个不同的操作：

- **更新基准**：把当前歌曲和已确认的当前音量作为新的全局基准，影响后续歌曲，不改变当前听到的音量。
- **恢复本曲自动**：使用已经保存的基准重新计算本曲音量，取消本次手动覆盖，基准不变。需要当前音轨分析完成并取消静音。

例如，先用熟悉的歌曲在 50% 设为基准。后来某一首只想临时轻一点，就手动调节这首，下一首恢复自动。如果希望后续所有歌曲都更轻，则在 Host 用舒服的当前音量「更新基准」。想撤销某首的临时调整，则用「恢复本曲自动」。

基准动作在静音、0% 或超过 100%、没有可用当前音轨、分析未完成或失败时不可用，弹窗会说明原因。歌曲、音轨或音量在操作期间变化时，服务器拒绝过时请求；按当前状态重试。保存失败会显示错误，原有基准继续有效。

## Remote 的权限

普通本地和公网 Remote 在播放面板中点击音量百分比，可以查看状态和「i」说明，并照常调节本曲音量、重置、放大或静音。**Remote 没有开关、基准更新和恢复自动操作**；这些由 Host 管理，服务器也会拒绝 Remote 的直接或伪造管理请求。关闭或尚未设定基准时，Remote 不会显示正在自动调节。

## 关闭、保存与可用范围

关闭功能会立即取消分析，保留当前音量和保存的基准，不会跳到 100%。后续歌曲采用原有音量规则，包括切歌时取消超过 100% 的放大。重新开启会复用保存的基准，但保护当前播放的手动、静音与零音量意图；需要时由 Host「恢复本曲自动」，或在下一首歌曲使用自动音量。

开关和有效基准保存在 Host 的原生数据中，与单曲输出独立。修改队列、删除参考歌曲缓存、重连、重启和关闭再开启都不会重新推导基准。重启恢复的当前歌曲保留原有音量，需恢复自动或换下一首。只有 Host 明确设定/更新基准才会改变它。

当前扫描器使用原有进程内 libav 与 ebur128，适用于配有当前 PCM companion 的原生桌面 Host（Linux、Windows、macOS）。允许 MOV/MP4/M4A 或 FLAC 中的一条单声道/标准双声道音频，8～192 kHz、至少约 0.4 秒且不超过 6 小时；具体解码器是否存在由 Host 的库决定。AAC、FLAC 和 MP4 中的 Opus 可使用该边界。时间戳允许约 1 毫秒的量化误差（按采样精度取整），分析按实际解码的采样数连续推进，不插入静音或重复采样；仍需完整解码并通过尾部采样数检查。多声道、超出该边界的时间线缺口/重叠、静音、损坏/截断文件及旧 companion 会报告不可用。Android 和保留的 Python Source Host 当前没有此扫描能力，仍可正常手动播放；分析不调用外部 FFmpeg/ffprobe 程序。

iOS 使用静态链接的 Rust `portable-loudness` 分析后端（Symphonia 0.6.1 + 同一 EBU R128 算法），支持缓存 AAC-LC（MP4/M4A）和 FLAC 的单声道/双声道音轨。它仅解码分析文件，不替换 WebKit 播放器。首次开启必须先完整分析当前缓存音轨；此前只表示可以尝试验证，不报告扫描器可用。分析期间切歌、切轨或修改手动音量会取消开启，失败也保留手动音量。旧分析缓存和保存的开启偏好不能代替新进程的验证。单次扫描上限 120 秒；具体真机耗电、发热、后台和长时间播放仍需设备验收。尚无缓存歌曲时，先完成缓存再尝试开启。

对 MP4 声明缩短的最后一个 AAC 包，扫描器仅量测其有效采样，排除解码块尾部填充；内部包时长差异、时间轴间隙/重叠和总时长检查仍保留，不能以容错为由忽略坏流。诊断中的 `automatic-volume-analysis-failed` 记录失败阶段：`missing_artifact`、`unsupported_container`、`unsupported_codec_profile`、`packet_timeline`、`duration_mismatch`、`decoder_failure`、`analysis_timeout` 或 `cancelled`；扫描器未装载另记 `scanner_unavailable`。日志不包含媒体路径、解析器原始错误或媒体内容，用户仍看到简短提示并可继续手动播放。

只在开启时分析当前音频和最多两首临近已缓存歌曲，由一个后台工作线程逐块处理，结果随缓存文件复用和淘汰，不扫描整个曲库。完整解码有实际 CPU 和时间成本，不能保证瞬间完成，也不阻塞歌曲播放或将分析失败的歌曲标成缓存失败。关闭时不运行音频解码或定时扫描。这里校准的是数字音轨整体响度，不能代替房间声压测量或现场听音；浏览器界面验证也不代表所有原生设备上的音质验收。

### Scanner failure diagnostics (V7)

A first-enable failure includes bounded `analysis_phase` and `analysis_reason`
fields. The Host volume dialog translates supported reasons; cancellation keeps
its separate stale-context result. Native diagnostics retain numeric packet,
codec/profile, track-count and declared/decoded-duration observations, never
artifact paths, provider URLs or parser messages. Silent signal is distinct from
corrupt decoding. Verification still decodes current bytes and holds the existing
AppState artifact lease; a matching sidecar cannot qualify first enable.

To compare an explicitly supplied compressed artifact with an independent LUFS
reference, run the ignored `portable_external_artifact_reference` Rust test with
`BILIKARA_TEST_LOUDNESS_ARTIFACT` and `BILIKARA_TEST_LOUDNESS_REFERENCE`. Keep the
sample and run-specific evidence outside Git. A passing software reference does
not establish iPhone route, speaker or energy behavior.
