"""Replace raw debug prints with encoding-safe _debug_print in cache.py"""
import pathlib

p = pathlib.Path(r"c:\bilikaradev\bilikara\bilikara\cache.py")
content = p.read_text(encoding="utf-8")

# 1. Add the _debug_print helper function before CacheManager class
old_class = "class CacheManager:"
new_class = '''def _debug_print(msg: str) -> None:
    """Print debug message to console, replacing unencodable characters."""
    import sys
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        encoded = msg.encode(sys.stdout.encoding or "utf-8", errors="replace")
        sys.stdout.buffer.write(encoded + b"\\n")
        sys.stdout.buffer.flush()


class CacheManager:'''

count = content.count(old_class)
print(f"Found {count} occurrences of class CacheManager")
if count == 1:
    content = content.replace(old_class, new_class)
else:
    print("ERROR: unexpected count")
    exit(1)

# 2. Replace all debug print calls
replacements = [
    (
        'print(f"[bilikara-cache] item={item_id} download_source={download_source} FAILED: {last_message}", flush=True)',
        '_debug_print(f"[bilikara-cache] item={item_id} download_source={download_source} FAILED: {last_message}")',
    ),
    (
        'print(f"[bilikara-cache] [{stage_label}] command: {json.dumps(command, ensure_ascii=False)}", flush=True)',
        '_debug_print(f"[bilikara-cache] [{stage_label}] command: {json.dumps(command, ensure_ascii=False)}")',
    ),
    (
        'print(f"[bilikara-cache] [{stage_label}] {line}", flush=True)',
        '_debug_print(f"[bilikara-cache] [{stage_label}] {line}")',
    ),
    (
        'print(f"[bilikara-cache] [{stage_label}] FAILED exit_code={return_code} last_message={last_message}", flush=True)',
        '_debug_print(f"[bilikara-cache] [{stage_label}] FAILED exit_code={return_code} last_message={last_message}")',
    ),
]

for old, new in replacements:
    count = content.count(old)
    if count != 1:
        print(f"ERROR: found {count} occurrences of: {old[:60]}...")
        exit(1)
    content = content.replace(old, new)
    print(f"Replaced: {old[:60]}...")

p.write_text(content, encoding="utf-8")
print("All replacements done")
"""

p = pathlib.Path(r"c:\bilikaradev\bilikara\bilikara\cache.py")
content = p.read_text(encoding="utf-8")
"""
