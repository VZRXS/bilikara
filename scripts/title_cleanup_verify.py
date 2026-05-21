import sys
import os

# Add project root to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bilikara.title_cleanup import clean_display_title

def test(text):
    print(f"Testing: {text}")
    result = clean_display_title(display_title=text)
    print(f"Result: '{result}'")

if __name__ == "__main__":
    # General verification test cases
    test("【纯K投屏】【卡拉OK字幕】歌名 Song Name")
    test("【纯k投屏 | ニコカラ | 主题】歌名 Song Name")
    test("[ニコカラ]歌名 Song Name")
    test("[ニコカラ] 歌名 Song Name")
    test("(On/Off Vocal) 歌名 Song Name")
    test("歌名 Song Name (On/Off)")
    test("【KTV字幕/主题】主题「歌名 Song Name」／歌手 [FLAC 48kHz]")
