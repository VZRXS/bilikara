package com.bilikara.app

import java.net.URI
import java.util.Locale

/** Only uncredentialed web destinations may reach Android's system resolver. */
internal object HostQrWebLink {
  fun validated(raw: String): String? {
    if (raw.length !in 1..4096 || raw.any { it <= ' ' || it == '\u007f' || it in "\\<>\"`" }) return null
    val uri = try { URI(raw) } catch (_: java.net.URISyntaxException) { return null }
    val scheme = uri.scheme?.lowercase(Locale.ROOT)
    val host = uri.host?.lowercase(Locale.ROOT)?.trimEnd('.') ?: return null
    if (scheme !in listOf("http", "https") || uri.rawUserInfo != null || uri.port == 0 || uri.port > 65535) return null
    if (host in listOf("wx.chunk.cn", "conn.dolphinstar.cn")) return null
    if (listOf(uri.path, uri.query, uri.fragment).any { value ->
      value?.any { it < ' ' || it == '\u007f' || it == '\\' } == true
    }) return null
    return uri.toASCIIString()
  }
}
