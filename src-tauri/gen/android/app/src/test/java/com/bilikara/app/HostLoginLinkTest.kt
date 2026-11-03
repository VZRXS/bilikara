package com.bilikara.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostLoginLinkTest {
  @Test fun onlyTheTwoNativeLoginQrOriginsCanLeaveTheHost() {
    for (url in listOf("https://account.bilibili.com/h5/account-h5/auth/scan-web?fixture=1",
      "https://passport.bilibili.com:443/scan?fixture=1")) assertEquals(url, HostLoginLink.validated(url))
    for (url in listOf("http://account.bilibili.com/", "https://account.bilibili.com.evil.test/",
      "https://account.bilibili.com@evil.test/", "https://user@account.bilibili.com/",
      "https://account.bilibili.com:8443/", "intent://account.bilibili.com/", "javascript:alert(1)",
      "file:///data/data/com.bilikara.app.alpha/", "https://www.bilibili.com/", "https://account.bilibili.com/"+"a".repeat(4096))) {
      assertNull(url, HostLoginLink.validated(url))
    }
  }
}
