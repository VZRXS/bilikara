"""Small deterministic M1 fixtures using the selected same-build CLI.

The M0 preview has no H.264 encoder. Reuse its existing synthetic H.264 source
with stream copy; do not read application caches or use authenticated media.
"""
import argparse
import math
import os
from pathlib import Path
import subprocess
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--h264-source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    for path in (args.prefix, args.h264_source, args.out):
        if not path.is_absolute():
            parser.error("all paths must be absolute")
    args.out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, LD_LIBRARY_PATH=str(args.prefix / "lib"))
    ffmpeg = str(args.prefix / "bin/ffmpeg")

    def run(*options):
        subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-y", *map(str, options)], env=env, check=True)

    run("-i", args.h264_source, "-map", "0:v:0", "-t", "1", "-c", "copy", args.out / "video.mp4")
    # M0 disables avdevice (including lavfi input). Generate a tiny PCM WAV in
    # the test helper, then use only the pinned CLI for encoding/remuxing.
    pcm = args.out / "synthetic.wav"
    with wave.open(str(pcm), "wb") as output:
        output.setparams((2, 3, 96000, 96000, "NONE", "not compressed"))
        output.writeframes(b"".join(
            int(1_000_000 * math.sin(2 * math.pi * 997 * n / 96000)).to_bytes(3, "little", signed=True) * 2
            for n in range(96000)))
    run("-i", pcm, "-ar", "48000", "-c:a", "aac", args.out / "aac.m4a")
    run("-i", args.out / "video.mp4", "-i", args.out / "aac.m4a", "-map", "0:v:0", "-map", "1:a:0",
        "-c", "copy", args.out / "av.mp4")
    run("-i", pcm, "-c:a", "flac", args.out / "audio.flac")
    run("-i", args.out / "audio.flac", "-c", "copy", "-strict", "-2", args.out / "flac.mp4")
    run("-i", args.out / "audio.flac", "-c:a", "pcm_s16le", args.out / "outside.wav")
    (args.out / "truncated.mp4").write_bytes((args.out / "aac.m4a").read_bytes()[:64])
    (args.out / "unknown.bin").write_bytes(b"not a media container\n")
    # Remove STREAMINFO's 36-bit total sample count, retaining rate/channels/bits.
    raw = bytearray((args.out / "audio.flac").read_bytes())
    packed = int.from_bytes(raw[18:26], "big") & ~((1 << 36) - 1)
    raw[18:26] = packed.to_bytes(8, "big")
    (args.out / "unknown-duration.flac").write_bytes(raw)
    # Same S3 missing-mdat mutation: preserve offsets and payload, change type.
    damaged = bytearray((args.out / "aac.m4a").read_bytes())
    offset = 0
    while offset + 8 <= len(damaged):
        size = int.from_bytes(damaged[offset:offset + 4], "big")
        if damaged[offset + 4:offset + 8] == b"mdat":
            damaged[offset + 4:offset + 8] = b"free"
            break
        if size < 8:
            raise RuntimeError("unexpected generated MP4 layout")
        offset += size
    else:
        raise RuntimeError("generated AAC fixture lacks mdat")
    (args.out / "missing-mdat.m4a").write_bytes(damaged)
    (args.out / "local.ffconcat").write_text("ffconcat version 1.0\nfile 'audio.flac'\n")
    (args.out / "network.m3u8").write_text("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/forbidden\n#EXT-X-ENDLIST\n")
    print(args.out)


if __name__ == "__main__":
    main()
