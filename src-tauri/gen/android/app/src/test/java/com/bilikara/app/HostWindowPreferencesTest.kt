package com.bilikara.app

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.*
import org.junit.Test

class HostWindowPreferencesTest {
  /** SharedPreferencesImpl.commitToMemory runs BEFORE the disk result. Each
   * write serializes the whole memory map, not just the editor's changed field.
   * No Android stub method, real user storage or JS mock is used in these tests. */
  private class Storage(vararg outcomes: Boolean) {
    val memory = mutableMapOf("layout" to "auto", "orientation" to "system")
    var disk = memory.toMap()
    val payloads = mutableListOf<Map<String, String>>()
    private val results = ArrayDeque(outcomes.toList())
    var throwNextCommit = false

    val preferences = proxy(SharedPreferences::class.java) { method, args ->
      when (method) {
        "getString" -> memory[args[0]] ?: args[1]
        "edit" -> editor()
        else -> error("Unexpected SharedPreferences method: $method")
      }
    }

    private fun editor(): SharedPreferences.Editor {
      val pending = mutableMapOf<String, String>()
      lateinit var editor: SharedPreferences.Editor
      editor = proxy(SharedPreferences.Editor::class.java) { method, args ->
        when (method) {
          "putString" -> { pending[args[0] as String] = args[1] as String; editor }
          "commit" -> {
            memory.putAll(pending)
            payloads.add(memory.toMap())
            if (throwNextCommit) {
              throwNextCommit = false
              throw IllegalStateException("injected write failure after memory mutation")
            }
            val success = if (results.isEmpty()) true else results.removeFirst()
            if (success) disk = memory.toMap()
            success
          }
          else -> error("Unexpected Editor method: $method")
        }
      }
      return editor
    }

    private fun <T> proxy(type: Class<T>, call: (String, Array<out Any?>) -> Any?): T =
      type.cast(Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, args ->
        call(method.name, args ?: emptyArray())
      })
  }

  private fun assertPair(prefs: HostWindowPreferences, layout: String, orientation: String) {
    assertEquals(HostWindowPreferences.Values(layout, orientation), prefs.confirmed)
    assertEquals(mapOf("layout" to layout, "orientation" to orientation), prefs.snapshot())
  }

  private fun expectFailure(action: () -> Unit): String {
    try { action() } catch (error: IllegalStateException) { return error.message.orEmpty() }
    throw AssertionError("An unconfirmed save must fail")
  }

  @Test fun failedLayoutThenSuccessfulOrientationCannotCarryPhoneForward() {
    val storage = Storage(false, true, true)
    val prefs = HostWindowPreferences(storage.preferences)
    expectFailure { prefs.setLayout("phone") }
    val failedSnapshot = prefs.snapshot()
    val recreatedSnapshot = HostWindowPreferences(storage.preferences).snapshot()
    prefs.setOrientation("landscape")
    assertEquals(listOf("auto", "auto", "auto", "auto"), listOf(
      failedSnapshot["layout"], recreatedSnapshot["layout"],
      storage.disk["layout"], storage.payloads.last()["layout"]))
    assertPair(prefs, "auto", "landscape")
    assertEquals(mapOf("layout" to "auto", "orientation" to "landscape"), storage.disk)
    assertEquals(storage.disk, storage.payloads.last())
    assertEquals(mapOf("layout" to "phone", "orientation" to "system"), storage.payloads.first())
  }

  @Test fun failedOrientationThenSuccessfulLayoutCannotCarryPortraitForward() {
    val storage = Storage(false, true, true)
    val prefs = HostWindowPreferences(storage.preferences)
    expectFailure { prefs.setOrientation("portrait") }
    val failedSnapshot = prefs.snapshot()
    prefs.setLayout("desktop")
    assertEquals(listOf("system", "system", "system"), listOf(
      failedSnapshot["orientation"], storage.disk["orientation"], storage.payloads.last()["orientation"]))
    assertPair(prefs, "desktop", "system")
    assertEquals(mapOf("layout" to "desktop", "orientation" to "system"), storage.disk)
    assertEquals(storage.disk, storage.payloads.last())
  }

  @Test fun failedRecoveryRemainsVisibleAndLaterWriteUsesConfirmedPair() {
    for (layoutFails in listOf(true, false)) {
      val storage = Storage(false, false, true)
      val prefs = HostWindowPreferences(storage.preferences)
      assertEquals("window_preferences_recovery_failed", expectFailure {
        if (layoutFails) prefs.setLayout("phone") else prefs.setOrientation("portrait")
      })
      assertPair(prefs, "auto", "system")
      // A failed rollback still updates Android memory before returning false.
      assertPair(HostWindowPreferences(storage.preferences), "auto", "system")
      if (layoutFails) prefs.setOrientation("landscape") else prefs.setLayout("desktop")
      val expected = if (layoutFails) mapOf("layout" to "auto", "orientation" to "landscape")
        else mapOf("layout" to "desktop", "orientation" to "system")
      assertEquals(expected, storage.disk)
      assertEquals(expected, storage.payloads.last())
    }
  }

  @Test fun writeExceptionAlsoRestoresTheLastSuccessfulPair() {
    val storage = Storage()
    val prefs = HostWindowPreferences(storage.preferences)
    prefs.setLayout("desktop")
    prefs.setOrientation("portrait")
    storage.throwNextCommit = true
    expectFailure { prefs.setLayout("phone") }
    assertPair(prefs, "desktop", "portrait")
    assertEquals(mapOf("layout" to "desktop", "orientation" to "portrait"), storage.disk)
    prefs.setOrientation("system")
    assertEquals(mapOf("layout" to "desktop", "orientation" to "system"), storage.payloads.last())
  }
}
