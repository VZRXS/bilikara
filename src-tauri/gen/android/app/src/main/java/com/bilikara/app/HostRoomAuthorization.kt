package com.bilikara.app

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PersistableBundle
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/** System handoff only. The validated official URL stays out of Host WebViews. */
internal class HostRoomAuthorization(private val activity: AppCompatActivity) {
  class WeChatUnavailable : Exception()

  fun open(raw: String): JSONObject {
    val url = HostLoginLink.roomAuthorization(raw) ?: error("invalid_room_url")
    try {
      activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addCategory(Intent.CATEGORY_BROWSABLE).setPackage("com.tencent.mm"))
      return JSONObject().put("opened", true).put("mode", "wechat-link")
    } catch (_: ActivityNotFoundException) {
      // Some WeChat versions do not expose a web-URL handler. Use the same
      // official-link/chat workflow as ChunK-Helper, then open WeChat itself.
    }
    val launch = activity.packageManager.getLaunchIntentForPackage("com.tencent.mm")
      ?: throw WeChatUnavailable()
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("bilikara authorization", url)
    clip.description.extras = PersistableBundle().apply {
      putBoolean("android.content.extra.IS_SENSITIVE", true)
    }
    clipboard.setPrimaryClip(clip)
    activity.startActivity(launch)
    return JSONObject().put("opened", true).put("mode", "wechat-clipboard")
  }
}
