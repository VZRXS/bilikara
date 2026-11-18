package com.bilikara.app

/** System-resource bookkeeping only. Testable without an Android device. */
internal interface CastResourceLock {
  val held: Boolean
  fun acquire()
  fun release()
}

internal class MulticastLeases(private val create: () -> CastResourceLock) {
  private val ids = mutableSetOf<Long>()
  private var lock: CastResourceLock? = null
  var lastAcquired: Boolean? = null
    private set

  @Synchronized fun acquire(id: Long): Boolean {
    if (id <= 0) return false
    return try {
      val resource = lock ?: create().also { lock = it }
      if (!resource.held) resource.acquire()
      check(resource.held)
      ids.add(id)
      lastAcquired = true
      true
    } catch (_: RuntimeException) {
      lastAcquired = false
      if (ids.isEmpty()) releaseAll()
      false
    }
  }
  @Synchronized fun release(id: Long) {
    ids.remove(id)
    if (ids.isEmpty()) releaseAll()
  }
  @Synchronized fun releaseAll() {
    ids.clear()
    val resource = lock
    lock = null
    try { if (resource?.held == true) resource.release() } catch (_: RuntimeException) { }
  }
  @Synchronized fun status(): Boolean? = lastAcquired
}

/** A newer admission supersedes an older lease; stale stops cannot stop it. */
internal class CastForegroundRequired : RuntimeException()

internal class CastOutputGate {
  private var owner = 0L
  private var mode = 0
  @Synchronized fun update(id: Long, nextMode: Int, foreground: Boolean,
    start: () -> Unit, stop: () -> Unit): Int {
    if (id <= 0 || nextMode !in 0..2) return 1
    if (nextMode == 0) {
      if (owner == id) { owner = 0; mode = 0; stop() }
      return 0
    }
    if (owner == 0L && !foreground) return 2
    val previous = owner
    val previousMode = mode
    owner = id
    mode = nextMode
    return try { start(); 0 } catch (error: RuntimeException) {
      owner = previous
      mode = previousMode
      if (error is CastForegroundRequired) 2 else 1
    }
  }
  @Synchronized fun <T> current(action: (Long, Int) -> T): T = action(owner, mode)
  @Synchronized fun end(id: Long, stop: () -> Unit): Boolean {
    if (id == 0L || owner != id) return false
    owner = 0; mode = 0; stop()
    return true
  }
}
