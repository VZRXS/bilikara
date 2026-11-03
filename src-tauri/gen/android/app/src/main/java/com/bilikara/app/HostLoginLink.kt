package com.bilikara.app

import java.net.URI

/** Match the native login service's two HTTPS QR origins. Never accept arbitrary app intents. */
internal object HostLoginLink {
  fun validated(value: String): String? = try {
    val uri = URI(value)
    value.takeIf {
      value.length <= 4096 && uri.scheme == "https" &&
        uri.host in setOf("account.bilibili.com", "passport.bilibili.com") &&
        uri.rawUserInfo == null && uri.port in setOf(-1, 443)
    }
  } catch (_: Exception) { null }
}
