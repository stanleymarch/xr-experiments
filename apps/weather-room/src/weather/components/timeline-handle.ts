/**
 * WEATHER//ROOM marker components. System-free: declarations only, so the
 * editor can import this manifest without pulling in runtime systems.
 */

import { createComponent } from '@iwsdk/core';

/** Marks the grabbable timeline playhead handle. */
export const TimelineHandle = createComponent('TimelineHandle', {});

/** Marks the dedicated whole-timeline move grip (coarse rail repositioner). */
export const TimelineMoveGrip = createComponent('TimelineMoveGrip', {});

/** Marks the dedicated weather-panel move grip (whole-panel repositioner). */
export const PanelMoveGrip = createComponent('PanelMoveGrip', {});
