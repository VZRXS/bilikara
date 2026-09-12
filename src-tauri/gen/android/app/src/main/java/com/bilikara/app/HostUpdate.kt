package com.bilikara.app

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URI
import java.security.MessageDigest

/** APK transport and Android package validation. Never bypass the OS installer.
 * Only an explicit Host update action can start this operation. */
internal class HostUpdate(private val activity: AppCompatActivity) {
  private var busy = false

  fun install(input: JSONObject, complete: (JSONObject?, String?) -> Unit) {
    if (busy) { complete(null, "更新正在进行，请稍候"); return }
    if (BuildConfig.DEBUG || !Build.SUPPORTED_ABIS.contains("arm64-v8a")) {
      complete(null, "当前测试签名或设备架构不支持正式包覆盖更新，请使用对应的测试 APK"); return
    }
    val bytes = input.optLong("bytes")
    val hash = input.optString("sha256")
    val urls = input.optJSONArray("urls")
    if (bytes !in 1..MAX_BYTES || !hash.matches(Regex("[a-f0-9]{64}")) || urls == null || urls.length() !in 1..2) {
      complete(null, "APK 发布元数据无效"); return
    }
    val sources = (0 until urls.length()).map { urls.optString(it) }
    if (sources.any { !allowedSource(it) }) { complete(null, "APK 下载地址无效"); return }
    busy = true
    Thread({
      val directory = File(activity.cacheDir, "updates")
      val partial = File(directory, "bilikara-update.partial")
      val apk = File(directory, "bilikara-update.apk")
      try {
        check(directory.mkdirs() || directory.isDirectory)
        check(directory.canonicalFile.parentFile == activity.cacheDir.canonicalFile)
        check(directory.usableSpace > bytes * 2)
        var downloaded = false
        for (source in sources) {
          try { download(source, partial, bytes, hash); downloaded = true; break }
          catch (_: Exception) { partial.delete() }
        }
        check(downloaded) { "APK download or digest failed" }
        validatePackage(partial)
        check(!apk.exists() || apk.delete())
        check(partial.renameTo(apk))
        activity.runOnUiThread {
          try {
            val result = if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
              activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
              "permission"
            } else {
              val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
              activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
              "installer"
            }
            busy = false; complete(JSONObject().put("result", result), null)
          } catch (_: Exception) { busy = false; complete(null, "无法打开系统安装器，请检查安装权限") }
        }
      } catch (_: Exception) {
        partial.delete()
        activity.runOnUiThread { busy = false; complete(null, "APK 下载或校验失败：请检查网络、空间，以及版本与签名是否匹配") }
      }
    }, "bilikara-apk-update").start()
  }

  @Suppress("DEPRECATION")
  private fun validatePackage(file: File) {
    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val candidate = activity.packageManager.getPackageArchiveInfo(file.path, flags) ?: error("Invalid APK")
    val installed = activity.packageManager.getPackageInfo(activity.packageName, flags)
    check(candidate.packageName == activity.packageName)
    val nextCode = if (Build.VERSION.SDK_INT >= 28) candidate.longVersionCode else candidate.versionCode.toLong()
    val oldCode = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
    check(nextCode > oldCode) { "Not an Android upgrade" }
    check((candidate.applicationInfo?.flags ?: ApplicationInfo.FLAG_DEBUGGABLE) and ApplicationInfo.FLAG_DEBUGGABLE == 0)
    fun signers(info: PackageInfo): Set<String> {
      val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
      return signatures.orEmpty().map { signature -> digestHex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())) }.toSet()
    }
    val expected = signers(installed)
    // Exact signer parity intentionally fails closed on unplanned key rotation.
    check(expected.isNotEmpty() && signers(candidate) == expected)
  }

  companion object {
    const val MAX_BYTES = 256L * 1024 * 1024
    internal fun allowedSource(value: String): Boolean {
      val uri = try { URI(value) } catch (_: Exception) { return false }
      val prefix = when (uri.host) {
        "github.com" -> "/VZRXS/bilikara/releases/download/"
        "api.kevinx96.icu" -> "/bilikara/releases/download/"
        else -> return false
      }
      if (uri.scheme != "https" || uri.port !in listOf(-1,443) || uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) return false
      val tail = uri.rawPath?.removePrefix(prefix) ?: return false
      val parts = tail.split('/')
      return uri.rawPath!!.startsWith(prefix) && parts.size == 2 && parts[0].matches(Regex("v[0-9A-Za-z.-]{1,79}")) &&
        parts[1] == "bilikara-${parts[0]}-android-arm64.apk"
    }
    private fun allowedRedirect(url: URL): Boolean = url.protocol == "https" && url.userInfo == null && url.port in listOf(-1,443) &&
      (allowedSource(url.toString()) || url.host in setOf("release-assets.githubusercontent.com", "objects.githubusercontent.com"))
    private fun digestHex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun download(source: String, destination: File, expectedBytes: Long, expectedHash: String) {
      var url = URL(source)
      val deadline = SystemClock.elapsedRealtime() + 240000
      repeat(6) {
        val connection = url.openConnection() as HttpURLConnection
        try {
          connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 15000
          connection.setRequestProperty("User-Agent", "bilikara-android-beta")
          if (connection.responseCode in setOf(301,302,303,307,308)) {
            url = URL(url, connection.getHeaderField("Location") ?: error("Missing redirect"))
            check(allowedRedirect(url)); check(SystemClock.elapsedRealtime() < deadline)
            return@repeat
          }
          check(connection.responseCode == 200)
          val digest = MessageDigest.getInstance("SHA-256")
          var total = 0L
          connection.inputStream.use { input -> destination.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              check(SystemClock.elapsedRealtime() < deadline)
              val count = input.read(buffer); if (count < 0) break
              total += count; check(total <= expectedBytes && total <= MAX_BYTES)
              digest.update(buffer, 0, count); output.write(buffer, 0, count)
            }
            output.fd.sync()
          } }
          check(total == expectedBytes && digestHex(digest.digest()) == expectedHash)
          return
        } finally { connection.disconnect() }
      }
      error("Too many redirects")
    }
  }
}
