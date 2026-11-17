package com.bilikara.app

import org.junit.Assert.*
import org.junit.Test

class CastResourceStateTest {
  private class Lock : CastResourceLock {
    override var held = false
    var acquisitions = 0
    var releases = 0
    var reject = false
    override fun acquire() { held = true; acquisitions++; if (reject) error("denied") }
    override fun release() { held = false; releases++ }
  }
  @Test fun overlappingDiscoveryDuplicateIdsAndStaleReleases() {
    val lock = Lock()
    val leases = MulticastLeases { lock }
    assertTrue(leases.acquire(1)); assertTrue(leases.acquire(1)); assertTrue(leases.acquire(2))
    assertEquals(1, lock.acquisitions)
    leases.release(1); assertTrue(lock.held)
    leases.release(1); assertTrue(lock.held)
    leases.release(2); assertFalse(lock.held)
    assertEquals(1, lock.releases)
    leases.release(2); assertEquals(1, lock.releases)
  }
  @Test fun partialFailureAndDestroyReleaseLocks() {
    val lock = Lock().apply { reject = true }
    val leases = MulticastLeases { lock }
    assertFalse(leases.acquire(1)); assertFalse(lock.held)
    assertEquals(false, leases.status())
    lock.reject = false
    assertTrue(leases.acquire(2)); assertTrue(leases.acquire(3))
    leases.releaseAll(); assertFalse(lock.held)
    leases.release(2); leases.release(3)
    assertEquals(2, lock.releases)
  }
  @Test fun backgroundAdmissionRejectedButExistingOutputContinues() {
    val gate = CastOutputGate()
    var starts = 0; var stops = 0
    assertEquals(2, gate.update(1, 2, false, { starts++ }, { stops++ }))
    assertEquals(0, starts)
    assertEquals(2, gate.update(1, 2, true, { throw CastForegroundRequired() }, { stops++ }))
    assertEquals(0, gate.update(1, 2, true, { starts++ }, { stops++ }))
    assertEquals(0, gate.update(1, 1, false, { starts++ }, { stops++ }))
    assertEquals(0, gate.update(1, 0, false, { starts++ }, { stops++ }))
    assertEquals(1, stops)
    assertEquals(2, gate.update(2, 2, false, { starts++ }, { stops++ }))
  }
  @Test fun oldReleaseAndNotificationCannotStopNewOutput() {
    val gate = CastOutputGate()
    var stops = 0
    gate.update(1, 2, true, {}, { stops++ })
    gate.update(2, 2, true, {}, { stops++ })
    gate.update(1, 0, true, {}, { stops++ })
    assertFalse(gate.end(1) { stops++ })
    assertEquals(0, stops)
    assertTrue(gate.end(2) { stops++ })
    assertEquals(1, stops)
    assertFalse(gate.end(2) { stops++ })
  }
  @Test fun failedStartRestoresPreviousOwnerAndRapidRestartStaysOwned() {
    val gate = CastOutputGate()
    assertEquals(1, gate.update(1, 2, true, { error("system refused") }, {}))
    gate.current { id, mode -> assertEquals(0L, id); assertEquals(0, mode) }
    gate.update(2, 2, true, {}, {})
    assertEquals(1, gate.update(3, 2, true, { error("system refused") }, {}))
    gate.current { id, mode -> assertEquals(2L, id); assertEquals(2, mode) }
    gate.update(2, 0, false, {}, {})
    gate.update(4, 2, true, {}, {})
    assertFalse(gate.end(2) { fail("old onDestroy must not stop new output") })
    gate.current { id, _ -> assertEquals(4L, id) }
  }
}
