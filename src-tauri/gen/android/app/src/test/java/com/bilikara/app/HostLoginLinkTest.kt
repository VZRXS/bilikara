package com.bilikara.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostLoginLinkTest {
  @Test fun roomAuthorizationNeverOpensArbitrarySchemesOrOrigins() {
    val valid = "https://wx.chunk.cn/projection/login?projection_url=fixture"
    assertEquals(valid, HostLoginLink.roomAuthorization(valid))
    for (url in listOf("https://wx.chunk.cn:443/projection/login/?x=1", "http://wx.chunk.cn:80/PROJECTION/Login///?x=1",
      "HTTPS://WX.CHUNK.CN/Projection/Login?x=1")) assertEquals(url, HostLoginLink.roomAuthorization(url))
    for (url in listOf("intent://wx.chunk.cn/projection/login?x=1", "https://wx.chunk.cn.evil.test/projection/login?x=1",
      "https://user@wx.chunk.cn/projection/login?x=1", "https://wx.chunk.cn:8443/projection/login?x=1",
      "https://wx.chunk.cn/projection/login", "$valid#fragment", "$valid\n", "https://wx.chunk.cn/other?x=1")) {
      assertNull(url, HostLoginLink.roomAuthorization(url))
    }
  }
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
