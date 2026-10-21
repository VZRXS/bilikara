package com.bilikara.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.annotation.Keep

/** Native resources only. Rust AppState owns output selection and playback. */
@Keep
object HostMediaPlayback {
  @Volatile var foreground = false
  @Volatile internal var service: HostMediaPlaybackService? = null
  // Fixed JNI operation codes: 0 stopped, 1 paused, 2 playing.
  @JvmStatic @Keep
  fun update(context: Context, mode: Int): Int {
    if (mode !in 0..2) return 1
    val current = service
    if (mode == 0) {
      current?.expectedStop = true
      context.stopService(Intent(context, HostMediaPlaybackService::class.java))
      return 0
    }
    if (current?.expectedStop == true) return if (mode == 1) 0 else 1
    if (mode == 1 && current == null) return 0
    if (current == null && !foreground) return 2
    return try {
      val intent = Intent(context, HostMediaPlaybackService::class.java).putExtra("mode", mode)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      0
    } catch (_: RuntimeException) { 1 }
  }

  // A stale notification may outlive the process that loaded the native Host.
  internal fun reportStopped(reason: Int) { try { nativeStopped(reason) } catch (_: UnsatisfiedLinkError) { } }
  internal fun reportThermal(status: Int, headroom: Float) { try { nativeThermal(status, headroom) } catch (_: UnsatisfiedLinkError) { } }
  @JvmStatic @Keep external fun nativeStopped(reason: Int)
  @JvmStatic @Keep external fun nativeThermal(status: Int, headroom: Float)
}

@Keep
class HostMediaPlaybackService : Service() {
  companion object {
    private const val CHANNEL = "network-playback"
    private const val NOTIFICATION = 41
    private const val STOP = "com.bilikara.app.STOP_NETWORK_OUTPUT"
  }
  @Volatile internal var expectedStop = false
  private var wake: PowerManager.WakeLock? = null
  private var wifi: WifiManager.WifiLock? = null
  private var multicast: WifiManager.MulticastLock? = null
  internal fun heldLocks(): List<Boolean> = listOf(wake?.isHeld == true, wifi?.isHeld == true, multicast?.isHeld == true)
  private val handler = Handler(Looper.getMainLooper())
  private val thermal = object : Runnable {
    override fun run() {
      if (HostMediaPlayback.service !== this@HostMediaPlaybackService) return
      val power = getSystemService(POWER_SERVICE) as PowerManager
      val status = if (Build.VERSION.SDK_INT >= 29) power.currentThermalStatus else -1
      // Android requires >= 10 seconds between headroom samples. NaN is unknown.
      val headroom = if (Build.VERSION.SDK_INT >= 30) power.getThermalHeadroom(0) else Float.NaN
      HostMediaPlayback.reportThermal(status, headroom)
      if (status >= PowerManager.THERMAL_STATUS_CRITICAL && Build.VERSION.SDK_INT >= 29) {
        stopOutput(3)
      } else handler.postDelayed(this, 15_000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    HostMediaPlayback.service = this
    if (Build.VERSION.SDK_INT >= 26) {
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
        NotificationChannel(CHANNEL, getString(R.string.network_output_channel), NotificationManager.IMPORTANCE_LOW)
      )
    }
    handler.post(thermal)
  }

  private fun notification(playing: Boolean): Notification {
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val stop = PendingIntent.getService(this, 1, Intent(this, HostMediaPlaybackService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    return builder.setSmallIcon(android.R.drawable.ic_media_play).setContentTitle("bilikara")
      .setContentText(getString(if (playing) R.string.network_output_playing else R.string.network_output_paused))
      .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_TRANSPORT)
      .addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause, getString(R.string.network_output_stop), stop).build()).build()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) { stopOutput(1); return START_NOT_STICKY }
    val playing = intent?.getIntExtra("mode", 0) == 2
    expectedStop = false
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification(playing), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      else startForeground(NOTIFICATION, notification(playing))
      if (playing) acquireLocks() else releaseLocks()
    } catch (_: RuntimeException) { stopOutput(2) }
    return START_NOT_STICKY
  }

  private fun acquireLocks() {
    if (wake?.isHeld != true) {
      wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bilikara:network-output").apply { setReferenceCounted(false); acquire() }
    }
    val manager = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
    if (wifi?.isHeld != true) {
      @Suppress("DEPRECATION")
      val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifi = manager.createWifiLock(mode, "bilikara:network-output").apply { setReferenceCounted(false); acquire() }
    }
    if (multicast?.isHeld != true) multicast = manager.createMulticastLock("bilikara:network-output").apply { setReferenceCounted(false); acquire() }
  }
  private fun releaseLocks() {
    multicast?.let { if (it.isHeld) it.release() }; multicast = null
    wifi?.let { if (it.isHeld) it.release() }; wifi = null
    wake?.let { if (it.isHeld) it.release() }; wake = null
  }
  private fun stopOutput(reason: Int) {
    expectedStop = true
    HostMediaPlayback.reportStopped(reason)
    releaseLocks()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }
  override fun onTaskRemoved(rootIntent: Intent?) { stopOutput(2); super.onTaskRemoved(rootIntent) }
  override fun onDestroy() {
    handler.removeCallbacks(thermal)
    releaseLocks()
    if (HostMediaPlayback.service === this) {
      HostMediaPlayback.service = null
      if (!expectedStop) HostMediaPlayback.reportStopped(2)
    }
    super.onDestroy()
  }
  override fun onBind(intent: Intent?): IBinder? = null
}
