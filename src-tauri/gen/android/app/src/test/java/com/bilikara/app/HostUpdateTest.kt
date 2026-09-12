package com.bilikara.app

import org.junit.Assert.*
import org.junit.Test

class HostUpdateTest {
  @Test fun apkSourcesAreFixedHttpsReleasePaths() {
    val name = "v0.8.0-preview.1/bilikara-v0.8.0-preview.1-android-arm64.apk"
    for (base in listOf("https://github.com/VZRXS/bilikara/releases/download/", "https://api.kevinx96.icu/bilikara/releases/download/")) {
      assertTrue(HostUpdate.allowedSource(base + name))
      for (bad in listOf("?token=secret", "#fragment", "/extra")) assertFalse(HostUpdate.allowedSource(base + name + bad))
      assertFalse(HostUpdate.allowedSource(base + "../" + name))
      assertFalse(HostUpdate.allowedSource(base.replace("https:", "http:") + name))
    }
    for (url in listOf("file:///private.apk", "https://127.0.0.1/file.apk", "https://github.com.evil.test/$name", "https://user@github.com/VZRXS/bilikara/releases/download/$name", "https://github.com:123/VZRXS/bilikara/releases/download/$name", "https://github.com/VZRXS/bilikara/releases/download/" + name.replace("/", "%2f"), "invalid url")) {
      assertFalse(url, HostUpdate.allowedSource(url))
    }
  }
}
