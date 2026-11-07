package com.bilikara.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Feature admission, independent of OEM provider package numbering. */
final class HostWebViewAdmission {
  private static final Pattern CHROMIUM = Pattern.compile("(?:Chrome|Chromium)/(\\d{1,4})(?:\\.|\\s|$)");

  static Integer chromiumHint(String userAgent) {
    Matcher match = CHROMIUM.matcher(userAgent == null ? "" : userAgent);
    if (!match.find()) return null;
    int value = Integer.parseInt(match.group(1));
    return value > 0 && value < 1000 ? value : null;
  }

  static boolean legacy(String userAgent, boolean bridge, boolean entry, boolean resources,
      boolean secure, Integer missing) {
    Integer hint = chromiumHint(userAgent);
    return bridge && entry && resources && secure && missing != null && missing == 0
        && (hint == null || hint >= 83);
  }

  static boolean standard(boolean bridge, boolean secure, Integer missing) {
    return bridge && secure && missing != null && missing == 0;
  }
}
