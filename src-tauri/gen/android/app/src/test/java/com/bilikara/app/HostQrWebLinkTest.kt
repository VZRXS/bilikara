package com.bilikara.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostQrWebLinkTest {
  @Test fun admitsOnlyOrdinaryUncredentialedWebDestinations() {
    val link = "https://example.org/pair?fixture=one"
    assertEquals(link, HostQrWebLink.validated(link))
    assertEquals("http://[::1]:8080/read", HostQrWebLink.validated("http://[::1]:8080/read"))
    for (raw in listOf("https://wx.chunk.cn./projection/login", "https://wx.chunk.cn../projection/login", "https://conn.dolphinstar.cn/Remote",
      "https://@example.org", "https://u:p@example.org", "https://example.org/%0A", "https://example.org/%5c", "https://exam\tple.org/", "https://example.org:0",
      "https:///example.org", "javascript:alert(1)", "intent://host/#Intent;scheme=https;end", "file:///test")) {
      assertNull(raw, HostQrWebLink.validated(raw))
    }
    assertNull(HostQrWebLink.validated("https://example.org/" + "a".repeat(4096)))
  }
}
