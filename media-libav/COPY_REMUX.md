# M5 first slice：显式 libav MP4 copy-remux

本地 `work/v0.8.0`、HEAD `1d30d24`，在工作区已接受的 M2/M3 上追加；不重新开始 M0–M3。
Rust 入口是 `LibavMetadataProbe::copy_remux_mp4(&CopyRemuxRequest, &AtomicBool)`，
实现位于 `rust-runtime/src/experimental_libav/remux.rs`。`media-libav/remux.c`
作为 `probe.c` 的私有实现单元复用 discovery、fd 限制、M3 packet accounting 和释放规则。
只有 developer driver 的 `compare --copy-remux audio|video` 显式调用它。

固定 profile：`mp4_single_h264_or_aac_faststart_v1`。输入必须是受信任、稳定、
本地 regular file、自包含 MP4-family，有 `ftyp`、`moov`、`mdat`，且**总共恰好一个**
符合 expected kind 的 H.264 video 或 AAC audio stream。多轨不会通过挑选/丢弃变成单轨。
已验证 fragmented AAC 输入转普通 MP4；本 profile 不输出 fragments。
FLAC-in-MP4、raw FLAC、其他 codec/container、加密和动态 decoder configuration
不属于本 profile。没有转码、encoder、DSP、混音、分离音视频合并或应用 A/V 对齐。

## 运行

从仓库根目录复用现存、已接受的 FFmpeg **9.0.1** prefix；不重建/下载 FFmpeg：

```bash
M5_PREFIX="$PWD/.tmp/m1-libav-9/ffmpeg-prefix"
M5_OUT=/tmp/bilikara-m5
python media-libav/build.py --prefix "$M5_PREFIX" --out "$M5_OUT/companion" --test
cargo build --manifest-path rust-runtime/Cargo.toml --locked --example libav_metadata
rust-runtime/target/debug/examples/libav_metadata compare \
  "$M5_OUT/companion/libbilikara_media_libav.so" "$M5_PREFIX" \
  "$PWD/.tmp/m1-libav-9/fixtures/aac.m4a" synthetic-aac \
  --copy-remux audio > "$M5_OUT/comparison.json" 2>/dev/null
```

默认每次实验创建私有目录，分别生成 `companion.mp4` / `reference.mp4`，返回后清理。
要保留一次有界输出，显式加 `--keep-outputs /absolute/NEW-directory`；该目录必须不存在，
且 `--repeat` 必须为 1。普通比较仍支持 1–10 次。库入口的 destination 始终是调用方
要求保留的独立实验文件；默认清理属于 developer harness 的实验范围。

沿用 M2/M3 的完整 build/configuration/library-version 协商与 child-only
`LD_LIBRARY_PATH=PREFIX/lib`，先验证两种 CLI identity 才执行 reference。
报告仅保留版本、allowlisted build flags、公用 fixture label、操作/检查摘要、差异、
耗时与文件大小。有效 CLI 参数完整记录，路径位置用固定占位符；不保存源路径、
任意 tags、media bytes 或 native/CLI stderr。默认 M1 invocation、M2 metadata
comparison、M3 packet comparison 均保留。

## ABI、所有权和失败

M1/M3 的结构尺寸不变。新增 `bm_remux_info_v1` / `bm_copy_remux_mp4_v1` /
`bm_remux_release_v1`，独立协商 request、result 和嵌入的 M3 scan 尺寸。
旧 companion 缺少 capability 时本操作 `Unavailable`，不会调用 CLI 代替它。
AV 对象、enum 和 decoder bytes 留在 C；Rust 验证结果并由分配它的 companion 释放。

Rust 先以 read-only fd 打开输入；初次 destination 检查使用 `symlink_metadata`，
也拒绝 dangling symlink、source 的 hard-link/symlink alias。随后在 destination
文件系统创建随机命名的独占 `0700` staging 目录及空文件。C 只收到这个私有路径，
永远拿不到公开 destination。输入的所有 subordinate `io_open` 仍被拒绝。
fast-start 的输出 context 仅允许对**这个 staging 路径**的 read reopen，禁止其他路径
和 write reopen。没有全局 callback、协议或 M1 权限放宽。

C 按顺序检查 header → 每包写入 → interleave flush → trailer/fast-start →
AVIO flush/error → close，再用原有 fd-only discovery 重开并逐字节核对完整 extradata、
codec、尺寸、sample rate、channel layout。9.0.1 的 fast-start helper 未传播的
read AVIO error 也在该 read handle 的 close callback 中保留。
Rust 在发布前复用 S3 `read_box_header` 做最多 4096 个顶层 box 的检查，
确认普通 leading-moov 输出，并用 M1/M3 复核单轨、codec、可读 EOF、包数、payload
总字节数及准确重标后的 PTS/DTS bounds。没有新通用 MP4 validator 或 full decode。
源文件缺 `mdat` 仍是 `InvalidMedia`，即使旧 probe/scan 能成功。

最后一次 cancellation 检查后，以 `fs::hard_link(staging, destination)` 做同文件系统
原子 no-replace 发布，使用与 S2 相同的原语，避免耦合其 normalization-specific test hook。
发生任何此前的错误/取消，都只清理 owned scratch，不删除竞争方 destination。
链接成功即 committed；此后的晚取消不改写成功结果，scratch 清理失败返回固定
`owned_scratch_cleanup_incomplete` warning。不增加 crash/power-loss durability 保证。

保持 `Unavailable`、`InvalidRequest`、`SourceMissing`、`UnsupportedFormat`、
`UnsupportedCodec`、`UnsupportedContainerLayout`、`MediaContractViolation`、
`InvalidMedia`、`Io`、`Cancelled`、backend failure 的区别。错误消息只含固定原因和
数字阶段；corrupt flag、empty EOF、read 阶段与 write/trailer/close 阶段有明确区别。
可用结果包含原 M3 input/output scan、原 M1 output metadata、profile、finalized/published、
layout/configuration checks 和输出大小；不携带内部路径。

## 时间戳与内容

保留输入媒体时间线，允许 muxer 的 time-base/container 表示变化。复制完整
`AVCodecParameters`（包括全部 AAC ASC / H.264 avcC 和 coded side data），只重置
输出 muxer 应选择的 codec tag；不照搬输入 tags、track IDs、container duration/start。
校验基准另存为初始配置的完整副本，避免 demuxer 在读包时更新 `codecpar` 改写基准。
每包原样交给 muxer，包括它支持的相关 side data；不是从两个 AAC bytes 重建配置。
`AV_PKT_DATA_NEW_EXTRADATA` 改变配置、encryption 或 parameter change 明确拒绝。

在 `avformat_write_header` 后，才按**实际** `AVStream.time_base` 使用
`av_packet_rescale_ts`。保留负数；PTS/DTS 缺失、duration 未知/非正、非递增 DTS、
PTS < DTS 或超出本 profile 支持的 mux timing 范围，返回 `UnsupportedContainerLayout`。
不将未知值补零，不使用 `genpts`，不独立归零每个 timestamp。输出固定
`avoid_negative_ts=disabled`、`use_editlist=1`、`movflags=+faststart`，关闭自动 BSF。
读取直接延续 find-stream-info 的缓冲前缀，无 seek/flush/reopen，也不保留整份输入。
`av_interleaved_write_frame` 在 9.0.1 中即使失败也消费/清空 packet；所有退出路径释放
末包和 contexts。取消在读包、写包前后及发布前观察；不声称 native trailer 每段都能立即中断。

同构建 CLI 使用 `-copyts -map 0:0 -c copy -copytb 1 -map_metadata -1
-map_metadata:s -1 -map_chapters -1 -fflags -autobsf -avoid_negative_ts disabled
-movflags +faststart -use_editlist 1 -f mp4 -n`，并保留既有 discovery/fd 限制。
它不等同于 DownKyi 全部参数的实现。

比较除 M2 metadata 和 M3 scan 外，还在小样本内直接比较有序 demuxed payload、
完整 extradata、每包 PTS/DTS/duration 及 skip-samples。每文件上限 4 MiB、256 包、
24 MiB 的临时 ffprobe JSON，足以容纳已有约 3.47 MB / 60 包的 H.264 fixture；
packet bytes/JSON 只存在内存，不能序列化为报告。长 M3 fixture 不进入此内容比较。
时间仅允许到实际目标 tick 的精确 nearest/ties-away rescale；不使用百分比/大时间容差。
未知不能当作零或已证实相等。文件字节、metadata 顺序和容器 padding 不要求一致。

测得 H.264 60 包、AAC 48 包、扩展 AAC 4 包、fragmented AAC 88 包及正起始 AAC
均保持 payload/configuration/每包时间；这些 fixtures 的时间 rounding 差均为 0。
普通 AAC 的首包 DTS/PTS `-1024/48000` 得以保留，正起始 fixture 不会归零。
扩展 fixture 复用 `media_backend::tests::write_he_aac_fixture`，完整配置
`2b 11 88 00` 保留；它的合成 packet 不是完整 decoder 样本，CLI diagnostics
被保留为 true，`clean_reference_execution=false`，只证明 streamcopy。

fragmented AAC 的末包 duration 为 136/44100 秒，转普通 MP4 后多出
`discard_padding=888`。本地 `mov.c` 的末包处理与 `demux.c` 的 skip-data 注入将
AAC-LC 的 1024-sample frame 表达为 `1024 - 136 = 888` 个尾部丢弃 samples。
比较器只认可与同一完整 AAC-LC ASC、已知精确 duration 匹配的这一末包表示；不推广到
HE-AAC、不调整时间、不容忍 padding 偏差。报告单独列出该 representation。
共有 libav 血统不构成独立 decoder/browser-playback 证据。

## 有限回归

```bash
python media-libav/test_comparison.py \
  --driver "$PWD/rust-runtime/target/debug/examples/libav_metadata" \
  --companion "$M5_OUT/companion/libbilikara_media_libav.so" \
  --prefix "$M5_PREFIX" --fixtures "$PWD/.tmp/m1-libav-9/fixtures" \
  --long-fixture /tmp/bilikara_media_native_research_20260901_ijcpsG/fixtures/synthetic_hires_large.mp4 \
  --out "$M5_OUT/live" --copy-remux \
  --old-companion "$PWD/.tmp/m1-libav-9/companion/libbilikara_media_libav.so" \
  --shim-test "$M5_OUT/companion/test_shim" \
  --remux-old-companion /tmp/bilikara-m3/companion/libbilikara_media_libav.so \
  --fault-companion "$M5_OUT/companion/libbilikara_media_libav_test.so" \
  --fragmented-fixture /tmp/bilikara-s3-rereview.00YXcZ/fragmented.m4a
```

继承全部 M2/M3 live assertions，新增真实 H.264/AAC/扩展 ASC/fragmented/正起始
比较、错误 kind/多轨/损坏/missing-mdat/不支持格式与 codec、旧 capability、默认清理、
显式保留与 privacy。复用已有工具链与 fixtures。
`--test` 额外构建私有 fault companion（不是生产 companion）；只在测试加载。
它在第三个真实写包后触发 flag，或真实 trailer 完成后返回 EIO，另有三次真实读取后
EIO/corrupt/unknown-DTS 注入，驱动真正 Rust staging/publisher/error cleanup。
另以同时修改输入 `codecpar` 和 `NEW_EXTRADATA` 的检查点验证动态配置在写包阶段被拒绝。
测试也真实创建初次检查之后出现的 destination、existing source aliases、dangling
symlink，验证源/竞争文件字节、零残留 scratch 和 descriptor 数稳定；发布后的晚取消
与清理失败保留成功。负控检测漏包、配置截短、payload、PTS 和 padding 改变。

参考资料：[上游 remuxing 示例](https://ffmpeg.org/doxygen/trunk/remuxing_8c-example.html)、
[MP4 muxer 文档](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)。
ABI/ownership 依据实际安装的 **9.0.1** `avformat.h`、`avio.h`、`codec_par.h`、
`packet.h`，以及同版本 `codec_par.c`、`packet.c`、`mux.c`、`movenc.c`、`mux_utils.c`、
`mov.c`、`demux.c`。没有照搬示例中未检查 trailer/close 的错误处理。

没有 AppState commit、cache-ready projection、media URL 替换、启动自动采样、fallback
router、队列或 UI setting。Python 改动只在 build/live-test orchestration；无 Python
业务实现/endpoint。本次只提交本地实现供独立评审，不推进其他 M5 profile 或生产 promotion。
