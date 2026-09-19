package com.bilikara.app

/** Android window selection only. Callers supply valid Presentation candidates;
 * an unknown controller association must never enable an audience window. */
internal fun isAudienceDisplay(displayId: Int, controllerDisplayId: Int?): Boolean =
  controllerDisplayId != null && displayId != controllerDisplayId
