package com.bilikara.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.IBinder
import android.os.PowerManager
import androidx.annotation.Keep

/** Native resources only; Rust AppState owns output and Pure K registration. */
@Keep
object HostMediaPlayback {
  @Volatile var foreground = false
  @Volatile internal var service: HostMediaPlaybackService? = null
  internal val gate = CastOutputGate()
  private val main = Handler(Looper.getMainLooper())
  private var startPending = false
  @Volatile internal var lastStopReason: Int? = null
    private set

  // Stop reasons passed to nativeStopped. Same table as Rust
  // cast_platform::stop_reason and docs/android-host-beta.md.
  const val STOP_NOTIFICATION = 1
  const val STOP_TASK_REMOVED = 2
  const val STOP_SERVICE_FAILURE = 3
  const val STOP_THERMAL_CRITICAL = 4

  // Same next operation/result codes: 0 stopped, 1 paused, 2 playing;
  // result 0 success, 1 platform failure, 2 foreground required.
  // The lease fences delayed intents and callbacks across rapid reconnects.
  @JvmStatic @Keep fun update(context: Context, mode: Int, lease: Long): Int =
    gate.update(lease, mode, foreground, start = {
      val running = service
      if (running != null) {
        // An existing foreground service can apply the newest resource mode
        // without asking Android to start a service from the background.
        check(main.post { running.applyLease() })
      } else if (!startPending) {
        val intent = Intent(context, HostMediaPlaybackService::class.java)
        try {
          if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
          startPending = true
        } catch (error: RuntimeException) {
          if (Build.VERSION.SDK_INT >= 31 && error is android.app.ForegroundServiceStartNotAllowedException) throw CastForegroundRequired()
          throw error
        }
      }
    }, stop = { stopService(context) })

  internal fun clearPendingStart() { startPending = false }

  private fun stopService(context: Context) {
    clearPendingStart()
    service = null
    context.stopService(Intent(context, HostMediaPlaybackService::class.java))
  }
  internal fun reportStopped(reason: Int, lease: Long) {
    // Rust admission may hold AppState while waiting for a platform call.
    // Never call back synchronously on Android's UI/service thread.
    lastStopReason = reason
    Thread({ try { nativeStopped(reason, lease) } catch (_: UnsatisfiedLinkError) { } }, "cast-stopped").start()
  }
  internal fun reportThermal(status: Int, headroom: Float, lease: Long) {
    // As with stop, never synchronously re-enter AppState from a service thread.
    Thread({ try { nativeThermal(status, headroom, lease) } catch (_: UnsatisfiedLinkError) { } }, "cast-thermal").start()
  }
  @JvmStatic @Keep external fun nativeThermal(status: Int, headroom: Float, lease: Long)
  @JvmStatic @Keep external fun nativeStopped(reason: Int, lease: Long)
}

@Keep
class HostMediaPlaybackService : Service() {
  companion object {
    private const val CHANNEL = "network-playback"
    private const val NOTIFICATION = 41
    private const val STOP = "com.bilikara.app.STOP_NETWORK_OUTPUT"
  }
  private var expectedStop = false
  private var servedLease = 0L
  internal var appliedMode = 0
    private set
  @Volatile private var wake: PowerManager.WakeLock? = null
  @Volatile private var wifi: WifiManager.WifiLock? = null

  private val handler = Handler(Looper.getMainLooper())
  private var thermalRunning = false
  private val thermal = object : Runnable {
    override fun run() {
      if (HostMediaPlayback.service !== this@HostMediaPlaybackService) {
        thermalRunning = false
        return
      }
      val power = getSystemService(POWER_SERVICE) as PowerManager
      val status = if (Build.VERSION.SDK_INT >= 29) power.currentThermalStatus else -1
      // Android requires >= 10 seconds between headroom samples. NaN is unknown.
      val headroom = if (Build.VERSION.SDK_INT >= 30) power.getThermalHeadroom(0) else Float.NaN
      HostMediaPlayback.reportThermal(status, headroom, servedLease)
      if (status >= PowerManager.THERMAL_STATUS_CRITICAL && Build.VERSION.SDK_INT >= 29) {
        stopOutput(HostMediaPlayback.STOP_THERMAL_CRITICAL, servedLease)
      } else handler.postDelayed(this, 15_000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
        NotificationChannel(CHANNEL, getString(R.string.network_output_channel), NotificationManager.IMPORTANCE_LOW))
    }
  }
  internal fun heldLocks(): List<Boolean> = listOf(wake?.isHeld == true, wifi?.isHeld == true)

  private fun notification(lease: Long, playing: Boolean): Notification {
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val stop = PendingIntent.getService(this, 1, Intent(this, HostMediaPlaybackService::class.java)
      .setAction(STOP).setData(Uri.parse("bilikara-cast:stop/$lease")).putExtra("lease", lease),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    return builder.setSmallIcon(android.R.drawable.ic_media_play).setContentTitle("bilikara")
      .setContentText(getString(if (playing) R.string.network_output_playing else R.string.network_output_paused))
      .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_TRANSPORT)
      .addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause, getString(R.string.network_output_stop), stop).build()).build()
  }
  private fun promote(lease: Long, playing: Boolean) {
    if (Build.VERSION.SDK_INT >= 29) {
      val type = if (playing) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        else ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
      startForeground(NOTIFICATION, notification(lease, playing), type)
    } else startForeground(NOTIFICATION, notification(lease, playing))
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    HostMediaPlayback.gate.current { lease, mode ->
      if (intent?.action == STOP) {
        val requested = intent.getLongExtra("lease", 0)
        if (requested == lease && lease != 0L) stopOutput(HostMediaPlayback.STOP_NOTIFICATION, lease)
        else if (lease == 0L) stopSelfResult(startId)
        return@current
      }
      HostMediaPlayback.clearPendingStart()
      if (lease == 0L) {
        // An asynchronous start can arrive after release. Fulfil Android's
        // promotion deadline then immediately remove the obsolete service.
        try { promote(0, false) } catch (_: RuntimeException) { }
        finishExpected(); stopSelfResult(startId)
        return@current
      }
      applyMode(lease, mode)
    }
    return START_NOT_STICKY
  }
  internal fun applyLease() = HostMediaPlayback.gate.current { lease, mode ->
    if (HostMediaPlayback.service === this && lease != 0L) applyMode(lease, mode)
  }
  private fun applyMode(lease: Long, mode: Int) {
    servedLease = lease
    expectedStop = false
    try {
      promote(lease, mode == 2)
      if (mode == 2) acquireLocks() else releaseLocks()
      appliedMode = mode
      HostMediaPlayback.service = this
      // Changing resource mode does not reset the headroom sampling interval.
      if (!thermalRunning) {
        thermalRunning = true
        handler.post(thermal)
      }
    } catch (_: RuntimeException) {
      stopOutput(HostMediaPlayback.STOP_SERVICE_FAILURE, lease)
    }
  }
  private fun acquireLocks() {
    if (wake?.isHeld != true) {
      wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bilikara:network-output")
      wake!!.setReferenceCounted(false); wake!!.acquire()
    }
    if (wifi?.isHeld != true) {
      val manager = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
      // API 34 maps HIGH_PERF to LOW_LATENCY anyway. Older devices retain the
      // background-capable lock; new devices' screen/foreground limit is real.
      @Suppress("DEPRECATION")
      val mode = if (Build.VERSION.SDK_INT >= 34) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifi = manager.createWifiLock(mode, "bilikara:network-output")
      wifi!!.setReferenceCounted(false); wifi!!.acquire()
    }
  }
  private fun releaseLocks() {
    try { wifi?.let { if (it.isHeld) it.release() } } catch (_: RuntimeException) { }
    wifi = null
    try { wake?.let { if (it.isHeld) it.release() } } catch (_: RuntimeException) { }
    wake = null
  }
  internal fun finishExpected() {
    expectedStop = true
    appliedMode = 0
    handler.removeCallbacks(thermal)
    thermalRunning = false
    releaseLocks()
    stopForeground(STOP_FOREGROUND_REMOVE)
  }
  private fun stopOutput(reason: Int, lease: Long) {
    if (HostMediaPlayback.gate.end(lease) {
      finishExpected()
      if (HostMediaPlayback.service === this) HostMediaPlayback.service = null
      stopSelf()
    }) HostMediaPlayback.reportStopped(reason, lease)
  }
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopOutput(HostMediaPlayback.STOP_TASK_REMOVED, servedLease)
    super.onTaskRemoved(rootIntent)
  }
  override fun onDestroy() {
    handler.removeCallbacks(thermal)
    thermalRunning = false
    HostMediaPlayback.gate.current { _, _ ->
      releaseLocks()
      if (HostMediaPlayback.service === this) {
        HostMediaPlayback.service = null
        if (!expectedStop) stopOutput(HostMediaPlayback.STOP_SERVICE_FAILURE, servedLease)
      }
    }
    super.onDestroy()
  }
  override fun onBind(intent: Intent?): IBinder? = null
}
