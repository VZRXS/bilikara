package com.bilikara.app

import org.junit.Assert.*
import org.junit.Test

class HostWebViewAdmissionTest {
  @Test fun huaweiPackageVersionIsSeparateFromEngineAndRequiredFeatures() {
    val provider = "14.0.2.319"
    val ua = "Mozilla/5.0 Chrome/99.0.4844.88"
    assertEquals(99, HostWebViewAdmission.chromiumHint(ua))
    assertFalse(provider.startsWith("99"))
    assertTrue(HostWebViewAdmission.legacy(ua, true, true, true, true, 0))
    assertFalse(HostWebViewAdmission.legacy(ua, false, true, true, true, 0))
    assertFalse(HostWebViewAdmission.legacy(ua, true, false, true, true, 0))
    assertFalse(HostWebViewAdmission.legacy(ua, true, true, false, true, 0))
    assertFalse(HostWebViewAdmission.legacy(ua, true, true, true, false, 0))
    assertFalse(HostWebViewAdmission.legacy(ua, true, true, true, true, 1))
    assertFalse(HostWebViewAdmission.legacy(ua, true, true, true, true, null))
    assertTrue(HostWebViewAdmission.legacy("Unknown OEM", true, true, true, true, 0))
    assertFalse(HostWebViewAdmission.legacy("Chrome/82.0", true, true, true, true, 0))
    assertTrue(HostWebViewAdmission.standard(true, true, 0))
    assertFalse(HostWebViewAdmission.standard(true, true, 4))
  }
}
