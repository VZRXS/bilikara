# Cast session regression fixture

`keyframes-30s.mp4` is synthetic black H.264 video (160x90, 30 fps, two B
frames, two-second closed GOPs). `audio-30s.m4a` is a stereo 440 Hz AAC tone.
Both are 30 seconds and are separate T3 inputs.
It contains no captured media. It exercises non-keyframe seeks and T3's
actual source start rather than the caller's requested seek position.
Tests consume the checked-in file; no FFmpeg executable is required at test time.

Generated using FFmpeg's lavfi color/sine sources, libx264 `-g 60 -keyint_min
60 -sc_threshold 0 -bf 2 -threads 1`, stereo AAC 64 kbit/s and `+faststart`.

`long-gop-12s.mp4` is synthetic black H.264 video (160x90, 30 fps, two B
frames, 12 seconds) with keyframes only at 0 s and 10 s. Its 10-second group
of pictures exercises copied video with L1 DSP through both the live HTTP
producer and file regeneration. Generated with
FFmpeg's lavfi color source and libx264 `-preset veryfast -g 300 -keyint_min
300 -sc_threshold 0 -bf 2 -threads 1 -pix_fmt yuv420p` and `+faststart`.
