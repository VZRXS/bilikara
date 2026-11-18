package com.bilikara.app

import java.net.URI

/** Match the native login service's two HTTPS QR origins. Never accept arbitrary app intents. */
internal object HostLoginLink {
  fun roomAuthorization(value: String): String? = try {
    val uri = URI(value)
    value.takeIf {
      value.length <= 4096 && uri.scheme?.lowercase() in setOf("http", "https") &&
        uri.host.equals("wx.chunk.cn", ignoreCase = true) && uri.rawPath.trimEnd('/').equals("/projection/login", ignoreCase = true) &&
        uri.rawUserInfo == null && uri.rawFragment == null &&
        (uri.port == -1 || uri.port == if (uri.scheme.equals("https", ignoreCase = true)) 443 else 80) &&
        !uri.rawQuery.isNullOrEmpty() && !value.any { it.isISOControl() }
    }
  } catch (_: Exception) { null }

  fun validated(value: String): String? = try {
    val uri = URI(value)
    value.takeIf {
      value.length <= 4096 && uri.scheme == "https" &&
        uri.host in setOf("account.bilibili.com", "passport.bilibili.com") &&
        uri.rawUserInfo == null && uri.port in setOf(-1, 443)
    }
  } catch (_: Exception) { null }
}
