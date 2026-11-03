# FLAC-in-MP4 → native FLAC 契约

`CopyProfile::Flac` 复用同一 C packet loop 和 Rust staging/publisher。
Rust 入口为
`LibavMetadataProbe::copy_profile(&CopyRemuxRequest, CopyProfile::Flac, &AtomicBool)`。
原 `copy_remux_mp4` 仍选 `CopyProfile::Mp4`，默认启动、Pure Rust 和生产 CLI 路由不变。

支持可信、稳定、本地、只读、自包含 MP4-family 文件中**恰好一个 FLAC audio stream**。
格式由 demuxer/codec 确定，扩展名不授予权限；video、额外 audio、artwork 等任一额外
stream 都违反契约。源 `moov`/`mdat` envelope 使用 normalization 的结构检查：metadata probe 成功
不能覆盖 missing-mdat 失败。输入仍是 fd-only，禁止 subordinate open 和网络。

输出是独立实验目标中的 native `.flac`，含 `fLaC`、正常 metadata header 和完整
34-byte STREAMINFO。没有编码、重采样、remix、gain、插入/删除样本或 AAC 转换。
源、production artifact/cache-ready/media URL、AppState 和 cache-attempt 不参与此操作。

**时间语义**：按原顺序保留完整编码样本，保留 sample rate/channels/precision。
本 profile 支持从零开始、连续、无裁剪的样本序列。用 9.0.1 demuxer 提供的
`start_time`、initial/trailing padding、seek preroll、packet PTS/DTS/duration、skip/discard
side data、stream duration 和已知 STREAMINFO sample count 检查可见偏移、
间隙、裁剪、重复和配置改变；不兼容时返回 `unsupported_container_layout`。
DASH 封装可能产生时间戳量化。FLAC 帧头解析器提供真实 block sample count；
逐帧边界与时长允许最多 **200 ms** 的容器时间差（包含边界）。
这是兼容阈值，不代表典型舍入误差。
已知 STREAMINFO 总采样数与实际帧累计总数也采用同一 200 ms 容差；范围内的
非零错误总数在输出头部修正为实际帧累计值，未知零值原样保留。`nb_frames` 仅作
容器提示，不再因它与遍历包数不符单独拒绝；包遍历、payload 和实际帧时长检查仍保留。
demux PTS/DTS 仍须从零严格连续，不把实际偏移、裁剪或间隙当成舍入差。
不会累积容差、重采样或按容器时长删减样本；超过 200 ms 的差异仍拒绝。
这一策略容忍源端元数据不准确，不是完整下载或完整音频的证明；若源端缺失本身
仍形成连续可读流、差异又在阈值内，不能单凭此窗口识别。
这不是任意 MP4 edit list 的证明/解析器；无法表达为该样本序列的 presentation timeline
不在支持范围，raw FLAC 不保留容器 edit lists、gaps、trims 或 presentation offsets。
不会通过改变音频样本修复时间。fixture 演示的是这个连续、未裁剪的常见 profile。

**实现依据和 metadata 政策**：以固定 9.0.1 `avformat.h`、
`codec_par.h`、`packet.h` 及 `flacenc.c`、`flacenc_header.c`、`flacdec.c`、`mov.c`。
`mov_read_dfla` 导出完整 STREAMINFO；`avcodec_parameters_copy` 深拷贝配置；
FLAC muxer 用 `write_header=1` 写正常头，音频 packet 原样写入。输出重开后逐字节检查
预期 extradata 和解码配置，包含 bit depth；仅允许上面明确修正的总采样数字段
变化，其余 STREAMINFO 字节（包括已有 MD5）保持不变。新增协商 exports 为 `bm_flac_info_v1`、
`bm_copy_flac_v1`，使用共享 remux request/result layout/release；旧 companion 的 FLAC 请求
显式 `unavailable`，其原有 MP4/probe/scan 仍可用。

STREAMINFO 的 rate/channels/bits 和 mandatory block bounds 只做窄检查，已知 total samples
与实际样本时间相差不得超过 200 ms。min/max frame size、total samples、MD5 的合法零值表示 unknown，
原样保留，不补造、不以 unknown 判坏；已有 MD5 也不替代实际 PCM 校验。
不复制输入 tags/chapters/artwork，允许 muxer 自己的 vendor comment、默认 padding，以及
必要的 channel-mask metadata。CLI 使用 `-map 0:0 -c copy -map_metadata -1
-map_metadata:s -1 -map_chapters -1 -fflags -autobsf -avoid_negative_ts disabled
-write_header 1 -f flac -n`。CLI 的自动 encoder comment 可比 companion 多几个字节；
Pure Rust 的既有输出只含 STREAMINFO 和 frames。comments/padding/order/container bitrate
和文件大小不同不构成音频差异，不要求 file-byte identity。

参考：[FFmpeg FLAC muxer 文档](https://ffmpeg.org/ffmpeg-formats.html#flac-2)、
[RFC 9639 STREAMINFO](https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2)、
[RFC 9639 frame 语义](https://www.rfc-editor.org/rfc/rfc9639.html#section-9)。
这些说明用于核对语义；执行/ABI 依据固定的本地 **9.0.1**，没有复制 trunk 实现。

**检查深度与 ownership**：继续实际 `av_read_frame`/write loop，区别 EOF、非 EOF demux
错误、corrupt packet、取消、write/trailer/flush/close 错误；不声称 streamcopy 能发现每个
codec-level 损坏。C 只收到 Rust 在独占私有目录中创建的空 staging file。finalize/close、
窄输出检查后，Rust 仍以同一 `hard_link` no-replace publisher 提交；错误只清理 owned
scratch。已存在目标、初检后竞态目标、源的 hardlink/symlink 均不能被覆盖。
发布成功后的晚取消/清理失败继续返回成功及窄 cleanup warning，不删除 published file，
没有新 crash-durability 声明。

从仓库根目录运行（使用同构建测试 FFmpeg prefix）：

```bash
FLAC_PREFIX="/absolute/test-prefix"
FLAC_OUT=/tmp/bilikara-flac
cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-companion --prefix "$FLAC_PREFIX" --out "$FLAC_OUT/companion" --test
cargo build --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
rust-runtime/target/debug/examples/libav_metadata compare \
  "$FLAC_OUT/companion/libbilikara_media_libav.so" "$FLAC_PREFIX" \
  "/absolute/fixtures/flac.mp4" synthetic-flac-96k24 \
  --flac audio
```

默认 experiment outputs 自动清理。需要保留时显式添加 `--keep-outputs /absolute/NEW-directory`，
其中 `companion.flac`、`reference.flac`、`pure-rust.flac` 是独立 owned 文件；目录不得已存在。
比较器先完成 companion 契约，再做独立 CLI/Pure Rust 对照；失败不授权 fallback。
Pure Rust 无法处理的输入记录 `not_comparable`，不扩展其实现。

比较使用 metadata 和 packet-scan summaries。FLAC 编码内容逐字节按顺序比较，忽略 packet
分组和 MP4 容器 PTS；packet-count equality 不是跨 demuxer 音频等价规则。
PCM oracle 仅在 `examples/libav_metadata/flac.rs` 的 TEST/DIAGNOSTIC driver 中，采用同构建
`-map 0:0 -c:a pcm_s32le -f s32le pipe:1`，无 `-ar`/`-ac`/filters。它必须完整到 EOF，
source/output 直接字节比较，并检查精确 interchannel sample count。16/24-bit PCM 在
FFmpeg 的 s32 中 MSB-aligned；Claxon 返回实际 signed precision 的整数，先扩展到 i64
再乘 `2^(32-bits)` 后逐样本比较，保留 channel order 和每一位精度。
Claxon 沿用现有 dev dependency，按 frame 迭代；其已有 unsupported 能力（包括当前不支持的
32-bit frame code）标为 independent `not_comparable`，不宣称验证，也不变成音频转换规则。
三路 FFmpeg 仍共享 libav，独立证据来自 Claxon。

本比较命令沿用 4 MiB compressed media / 256 packet / 24 MiB content JSON 上限，PCM
捕获另限 16 MiB，超限失败而非只比前缀。只保留 source 与当前输出两份有界 PCM buffer；
Claxon 使用 frame buffer。报告只含 allowlisted summaries，不存 PCM、encoded payload、
tags、私有输入路径、stderr 或凭证，也没有 file/diff/PCM hash ledger。

有限 live suite（包含 metadata/scan、MP4/extended HE-AAC 和共享 lifecycle 检查）：

```bash
npm run test:media -- \
  --companion "$FLAC_OUT/companion/libbilikara_media_libav.so" \
  --prefix "$FLAC_PREFIX" --fixtures "/absolute/fixtures" \
  --long-fixture /absolute/fixtures/synthetic_hires_large.mp4 \
  --out "$FLAC_OUT/live" --flac \
  --old-companion "/absolute/previous-metadata-companion.so" \
  --shim-test "$FLAC_OUT/companion/test_shim" \
  --remux-old-companion /absolute/previous-scan-companion.so \
  --fault-companion "$FLAC_OUT/companion/libbilikara_media_libav_test.so" \
  --fragmented-fixture /absolute/fixtures/fragmented.m4a \
  --flac-old-companion /absolute/previous-remux-companion.so
```

验证要求：保留 16/24-bit stereo、未知 STREAMINFO 总数和已知 WAV PCM 的完整
PCM/Claxon 对照；单 bit 改动、丢失 sample 和声道交换负控必须失败。覆盖错误
codec/kind、多轨、raw 输入、missing-mdat、错误 STREAMINFO 和 edit-list 裁剪。
时间与总采样数检查必须覆盖正负 200 ms 边界、超出一个采样点和中途超界；
放行时仍需保持完整 PCM、实际采样总数及源文件不变，未知总数保持未知。
通过实际 publisher 检查取消、读写及 trailer 错误、竞争目标、配置变化、
晚取消和 cleanup warning，并验证无 owned scratch 或描述符泄漏。
