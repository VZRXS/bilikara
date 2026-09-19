package com.bilikara.app

import org.junit.Assert.*
import org.junit.Test

class HostDisplaySelectionTest {
  @Test fun defaultControllerKeepsOrdinaryExternalOutput() {
    assertFalse(isAudienceDisplay(0, 0))
    assertTrue(isAudienceDisplay(7, 0))
  }

  @Test fun nonzeroControllerCannotSelectOrRecommendItself() {
    val presentationIds = listOf(7, 9)
    val targets = presentationIds.filter { isAudienceDisplay(it, 7) }
    assertEquals(listOf(9), targets)
    assertEquals(9, targets.first())
    assertFalse(isAudienceDisplay(7, 7)) // Revalidation of a previously offered ID.
    assertTrue(listOf(7).filter { isAudienceDisplay(it, 7) }.isEmpty())
  }

  @Test fun movedOrUnknownControllerInvalidatesThePreviousTarget() {
    assertTrue(isAudienceDisplay(7, 0))
    assertFalse(isAudienceDisplay(7, 7))
    assertFalse(isAudienceDisplay(7, null))
  }
}
