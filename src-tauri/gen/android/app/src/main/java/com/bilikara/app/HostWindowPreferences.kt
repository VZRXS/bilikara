package com.bilikara.app

import android.content.SharedPreferences

/** Only the two device-local window preferences. All access is on the UI thread. */
internal class HostWindowPreferences(private val storage: SharedPreferences) {
  data class Values(val layout: String, val orientation: String)

  var confirmed = Values(
    storage.getString("layout", "auto").takeIf { it in setOf("auto", "desktop", "phone") } ?: "auto",
    storage.getString("orientation", "system").takeIf { it in setOf("system", "landscape", "portrait") } ?: "system"
  )
    private set
  fun snapshot(): Map<String, Any> = mapOf(
    "layout" to confirmed.layout, "orientation" to confirmed.orientation
  )

  fun setLayout(mode: String) = save(confirmed.copy(layout = mode))
  fun setOrientation(mode: String) = save(confirmed.copy(orientation = mode))

  private fun write(values: Values): Boolean = try {
    // commit() mutates SharedPreferences memory even when disk persistence fails.
    // Always replace BOTH fields, never carry its unconfirmed other field forward.
    storage.edit().putString("layout", values.layout)
      .putString("orientation", values.orientation).commit()
  } catch (_: Exception) { false }

  private fun save(values: Values) {
    if (!write(values)) {
      // Restore Android's cached pair too, including for Activity recreation.
      // Failure to confirm this recovery cannot promise durability on restart.
      val recoveryFailed = !write(confirmed)
      error(if (recoveryFailed) "window_preferences_recovery_failed" else "window_preferences_failed")
    }
    confirmed = values
  }
}
