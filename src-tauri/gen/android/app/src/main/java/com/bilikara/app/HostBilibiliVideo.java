package com.bilikara.app;

/** Video-only OS handoff. Deliberately independent of account/login URLs. */
final class HostBilibiliVideo {
  static String validated(String value) {
    if (value == null || value.length() > 128 || !value.matches(
        "https://www\\.bilibili\\.com/video/BV[A-Za-z0-9]{10}(?:\\?p=[1-9][0-9]{0,9})?")) return null;
    int query = value.indexOf("?p=");
    if (query >= 0 && Long.parseLong(value.substring(query + 3)) > Integer.MAX_VALUE) return null;
    return value;
  }
}
