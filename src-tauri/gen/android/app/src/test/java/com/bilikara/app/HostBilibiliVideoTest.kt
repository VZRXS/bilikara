package com.bilikara.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostBilibiliVideoTest {
  @Test fun canonicalVideosRemainSeparateFromLoginAndRoomAuthorization() {
    val base = "https://www.bilibili.com/video/BV1yyjzzCEQn"
    for (value in listOf(base, "$base?p=2", "$base?p=2147483647")) {
      assertEquals(value, HostBilibiliVideo.validated(value))
      assertNull(HostLoginLink.validated(value))
      assertNull(HostLoginLink.roomAuthorization(value))
    }
    for (value in listOf("http://www.bilibili.com/video/BV1yyjzzCEQn",
      "https://www.bilibili.com:443/video/BV1yyjzzCEQn", "https://user@www.bilibili.com/video/BV1yyjzzCEQn",
      "https://www.bilibili.com.evil.test/video/BV1yyjzzCEQn", "javascript:alert(1)", "file:///video/BV1yyjzzCEQn",
      "https://account.bilibili.com/login", "$base/", "$base#x", "$base?p=0", "$base?p=-1", "$base?p=01",
      "$base?p=1.5", "$base?p=2147483648", "$base?p=2&p=3", "$base?redirect=x", "$base?p=2&redirect=x", "$base${"x".repeat(200)}")) {
      assertNull(value, HostBilibiliVideo.validated(value))
    }
  }
}
