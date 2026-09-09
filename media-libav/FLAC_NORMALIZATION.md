# M5 follow-on：FLAC-in-MP4 → native FLAC

增量起点是本地 `work/v0.8.0` HEAD `ed62ecb`（开始时干净、比 tracking ref 超前 7 个提交）。
已有 companion 只有 H.264/AAC → MP4，已有 Pure Rust FLAC normalization 保持原实现。
本次给同一 C packet loop 和 Rust staging/publisher 增加 `CopyProfile::Flac`；没有第二套
writer、loader、事务管理或 CLI 应用。Rust 入口为
`LibavMetadataProbe::copy_profile(&CopyRemuxRequest, CopyProfile::Flac, &AtomicBool)`。
原 `copy_remux_mp4` 仍选 `CopyProfile::Mp4`，默认启动、Pure Rust 和生产 CLI 路由不变。

支持可信、稳定、本地、只读、自包含 MP4-family 文件中**恰好一个 FLAC audio stream**。
格式由 demuxer/codec 确定，扩展名不授予权限；video、额外 audio、artwork 等任一额外
stream 都违反契约。源 `moov`/`mdat` envelope 使用既有 S3 检查：metadata probe 成功
不能覆盖 missing-mdat 失败。输入仍是 fd-only，禁止 subordinate open 和网络。

输出是独立实验目标中的 native `.flac`，含 `fLaC`、正常 metadata header 和完整
34-byte STREAMINFO。没有编码、重采样、remix、gain、插入/删除样本或 AAC 转换。
源、production artifact/cache-ready/media URL、AppState 和 cache-attempt 不参与此操作。

**时间语义**：按原顺序保留完整编码样本，保留 sample rate/channels/precision。
本 profile 支持从零开始、连续、无裁剪的样本序列。用 9.0.1 demuxer 提供的
`start_time`、initial/trailing padding、seek preroll、packet PTS/DTS/duration、skip/discard
side data、`nb_frames`、stream duration 和已知 STREAMINFO sample count 检查可见偏移、
间隙、裁剪、重复和配置改变；不兼容时返回 `unsupported_container_layout`。
这不是任意 MP4 edit list 的证明/解析器；无法表达为该样本序列的 presentation timeline
不在支持范围，raw FLAC 不保留容器 edit lists、gaps、trims 或 presentation offsets。
不会通过改变音频样本修复时间。fixture 演示的是这个连续、未裁剪的常见 profile。

**实现依据和 metadata 政策**：实际读取现存 prefix 对应的 9.0.1 `avformat.h`、
`codec_par.h`、`packet.h` 及 `flacenc.c`、`flacenc_header.c`、`flacdec.c`、`mov.c`。
`mov_read_dfla` 导出完整 STREAMINFO；`avcodec_parameters_copy` 深拷贝配置；
FLAC muxer 用 `write_header=1` 写正常头，音频 packet 原样写入。输出重开后逐字节检查
完整 extradata 和解码配置，包含 bit depth。新增协商 exports 为 `bm_flac_info_v1`、
`bm_copy_flac_v1`，使用原 M5 request/result layout/release；旧 companion 的 FLAC 请求
显式 `unavailable`，其原有 MP4/probe/scan 仍可用。

STREAMINFO 的 rate/channels/bits 和 mandatory block bounds 只做窄检查，已知 total samples
与可见样本时间一致。min/max frame size、total samples、MD5 的合法零值表示 unknown，
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

从仓库根目录运行（使用已存在的 FFmpeg prefix，不重建 M0）：

```bash
M5_FLAC_PREFIX="$PWD/.tmp/m1-libav-9/ffmpeg-prefix"
M5_FLAC_OUT=/tmp/bilikara-m5-flac
python media-libav/build.py --prefix "$M5_FLAC_PREFIX" --out "$M5_FLAC_OUT/companion" --test
cargo build --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
rust-runtime/target/debug/examples/libav_metadata compare \
  "$M5_FLAC_OUT/companion/libbilikara_media_libav.so" "$M5_FLAC_PREFIX" \
  "$PWD/.tmp/m1-libav-9/fixtures/flac.mp4" synthetic-flac-96k24 \
  --flac audio
```

默认 experiment outputs 自动清理。需要保留时显式添加 `--keep-outputs /absolute/NEW-directory`，
其中 `companion.flac`、`reference.flac`、`pure-rust.flac` 是独立 owned 文件；目录不得已存在。
比较器先完成 companion 契约，再做独立 CLI/Pure Rust 对照；失败不授权 fallback。
Pure Rust 无法处理的输入记录 `not_comparable`，不扩展其实现。

比较沿用 M2 metadata 和 M3 scan summaries。FLAC 编码内容逐字节按顺序比较，忽略 packet
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

有限 live suite（继承 M1/M2/M3、原 MP4/extended HE-AAC 测试，复用 M5 lifecycle helper）：

```bash
python media-libav/test_comparison.py \
  --driver "$PWD/rust-runtime/target/debug/examples/libav_metadata" \
  --companion "$M5_FLAC_OUT/companion/libbilikara_media_libav.so" \
  --prefix "$M5_FLAC_PREFIX" --fixtures "$PWD/.tmp/m1-libav-9/fixtures" \
  --long-fixture /tmp/bilikara_media_native_research_20260901_ijcpsG/fixtures/synthetic_hires_large.mp4 \
  --out "$M5_FLAC_OUT/live" --flac \
  --old-companion "$PWD/.tmp/m1-libav-9/companion/libbilikara_media_libav.so" \
  --shim-test "$M5_FLAC_OUT/companion/test_shim" \
  --remux-old-companion /tmp/bilikara-m3/companion/libbilikara_media_libav.so \
  --fault-companion "$M5_FLAC_OUT/companion/libbilikara_media_libav_test.so" \
  --fragmented-fixture /tmp/bilikara-s3-rereview.00YXcZ/fragmented.m4a \
  --flac-old-companion /tmp/bilikara-m5/companion/libbilikara_media_libav.so
```

新增 fixture evidence：既有 96 kHz / 24-bit stereo（96,000 samples/channel）、一个
48 kHz / 16-bit stereo 控制（48,000 samples/channel、左右声道不同、含满幅正负值）、
合法 unknown STREAMINFO variant。所有小输出做完整 PCM/Claxon 对照，source decode
还与完整已知 WAV PCM 直接比较。比较器单 bit 修改、丢失 sample、左右声道交换负控均须失败。
不以 metadata/comments/padding 的差异代替 PCM 比较。
FLAC-specific 拒绝集包括 wrong codec/kind、audio+video、两 audio、raw 输入、missing-mdat、
mandatory STREAMINFO length 错误，以及有实际 edit list 的 offset/trim fixture。
同一个实际 publisher/lifecycle helper 以 `CopyProfile::Flac` 再运行，覆盖 collision、
第三次真实写包后的取消、真实 trailer 后注入 EIO、非 EOF read error/corrupt/配置变化、
晚取消、cleanup warning、源字节不变、零 owned scratch 和 fd 数稳定。

最终 Linux gate 在稳定 patch 上运行 runtime fmt/clippy/test/release build、Python 强制 native
suite/compilation 和 diff check。未修改的 `rust/`、`src-tauri/` 和 frontend build 复用已接受
M5 handoff 所引用的 `.tmp/m1-libav-9/gate-{rust,src-tauri,frontend}-*.log`，作用域仅限未改层。
不重复打包 UI/Tauri，不要求 Windows/macOS/WebView。真实 Hi-Res 历史问题、DownKyi policy、
其他 codec profile、backend promotion 和 CLI removal 均不在本次结论内。
