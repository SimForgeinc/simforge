/**
 * Actor SVG icons for the scenario editor.
 *
 * PROP_SVG_ICONS is a static in-repo icon map.
 * dangerouslySetInnerHTML in PropIcon is safe because the source is a
 * static constant owned by this team — no user-supplied content ever
 * flows into this map.
 */

// ---------------------------------------------------------------------------
// Prop icon map — copied verbatim from Svelte editor constants.ts:129-168
// ---------------------------------------------------------------------------
export const PROP_SVG_ICONS: Record<string, string> = {
  // Traffic & Safety — Cones
  'static.prop.trafficcone01': '<polygon points="12,3 7,20 17,20" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/><line x1="8.5" y1="14" x2="15.5" y2="14" stroke="currentColor" stroke-width="1.5"/><line x1="9.5" y1="10" x2="14.5" y2="10" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="20" width="14" height="2" rx="0.5" stroke="currentColor" stroke-width="1" fill="none"/>',
  'static.prop.trafficcone02': '<polygon points="12,2 8,18 16,18" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/><line x1="9" y1="12" x2="15" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="8.5" y1="16" x2="15.5" y2="16" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.5"/><rect x="6" y="18" width="12" height="3" rx="0.5" stroke="currentColor" stroke-width="1" fill="none"/>',
  'static.prop.constructioncone': '<polygon points="12,5 5,19 19,19" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/><line x1="6.5" y1="16" x2="17.5" y2="16" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="12.5" x2="16" y2="12.5" stroke="currentColor" stroke-width="1.5"/><line x1="9.5" y1="9" x2="14.5" y2="9" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="19" width="18" height="3" rx="0.5" stroke="currentColor" stroke-width="1" fill="none"/>',
  // Traffic & Safety — Warnings
  'static.prop.warningconstruction': '<polygon points="12,3 2,21 22,21" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="12" y1="10" x2="12" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="18" r="0.75" fill="currentColor"/><line x1="6" y1="21" x2="4" y2="23" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="18" y1="21" x2="20" y2="23" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  'static.prop.warningaccident': '<polygon points="12,2 22,12 12,22 2,12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="12" y1="8" x2="12" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="17" r="0.75" fill="currentColor"/>',
  'static.prop.trafficwarning': '<rect x="4" y="3" width="16" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="7" x2="12" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="13" r="0.5" fill="currentColor"/><line x1="12" y1="15" x2="12" y2="23" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  // Traffic & Safety — Barriers
  'static.prop.streetbarrier': '<rect x="2" y="8" width="20" height="4" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="8" x2="10" y2="12" stroke="currentColor" stroke-width="1"/><line x1="10" y1="8" x2="14" y2="12" stroke="currentColor" stroke-width="1"/><line x1="14" y1="8" x2="18" y2="12" stroke="currentColor" stroke-width="1"/><line x1="5" y1="12" x2="4" y2="20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="19" y1="12" x2="20" y2="20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  'static.prop.chainbarrier': '<line x1="5" y1="6" x2="5" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="19" y1="6" x2="19" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="19" cy="5" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5 10 Q8 15 12 14 Q16 13 19 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  'static.prop.chainbarrierend': '<line x1="12" y1="6" x2="12" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="5" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 10 Q16 13 20 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="20" cy="11" r="1" stroke="currentColor" stroke-width="1" fill="none"/>',
  'static.prop.ironplank': '<polygon points="4,10 20,10 22,16 2,16" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><line x1="7" y1="12" x2="17" y2="12" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><line x1="5" y1="14" x2="19" y2="14" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>',
  // Debris & Obstacles
  'static.prop.dirtdebris01': '<polygon points="12,8 4,18 20,18" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><circle cx="8" cy="19" r="1" stroke="currentColor" stroke-width="1" fill="none"/><circle cx="16" cy="19" r="0.8" stroke="currentColor" stroke-width="1" fill="none"/>',
  'static.prop.dirtdebris02': '<polygon points="6,10 2,18 12,18" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><polygon points="14,12 10,18 20,18" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><circle cx="18" cy="19" r="1" stroke="currentColor" stroke-width="1" fill="none"/>',
  'static.prop.dirtdebris03': '<path d="M2,18 Q4,10 8,12 Q10,6 14,10 Q17,7 22,18 Z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><circle cx="6" cy="19" r="1" stroke="currentColor" stroke-width="1" fill="none"/><circle cx="19" cy="19" r="1.2" stroke="currentColor" stroke-width="1" fill="none"/>',
  'static.prop.brokentile01': '<rect x="3" y="5" width="18" height="14" rx="0.5" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="3" y1="12" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="10" x2="14" y2="15" stroke="currentColor" stroke-width="1.2"/><line x1="14" y1="15" x2="21" y2="13" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="10" x2="12" y2="5" stroke="currentColor" stroke-width="1.2"/>',
  'static.prop.brokentile02': '<rect x="3" y="5" width="18" height="14" rx="0.5" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="8" y1="5" x2="11" y2="12" stroke="currentColor" stroke-width="1.2"/><line x1="11" y1="12" x2="8" y2="19" stroke="currentColor" stroke-width="1.2"/><line x1="11" y1="12" x2="21" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="11" y1="12" x2="18" y2="19" stroke="currentColor" stroke-width="1.2"/>',
  // Containers
  'static.prop.container': '<rect x="3" y="5" width="18" height="14" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="10" x2="10" y2="14" stroke="currentColor" stroke-width="1.5"/><line x1="14" y1="10" x2="14" y2="14" stroke="currentColor" stroke-width="1.5"/>',
  'static.prop.box01': '<rect x="4" y="9" width="16" height="11" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4,9 L8,4 L20,4 L20,9" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="12" y1="4" x2="12" y2="20" stroke="currentColor" stroke-width="1.5"/>',
  'static.prop.box02': '<rect x="4" y="9" width="16" height="11" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4,9 L4,7 L12,5 L20,7 L20,9" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="8" y1="8" x2="8" y2="5.5" stroke="currentColor" stroke-width="1"/><line x1="16" y1="8" x2="16" y2="5.5" stroke="currentColor" stroke-width="1"/>',
  'static.prop.creasedbox01': '<path d="M4,9 L20,9 L20,20 L4,20 Z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4,9 L8,4 L20,4 L20,9" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="12" y1="9" x2="12" y2="20" stroke="currentColor" stroke-width="1.5"/><path d="M7,12 L10,14 L7,17" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  'static.prop.barrel': '<ellipse cx="12" cy="6" rx="7" ry="3" stroke="currentColor" stroke-width="1.5" fill="none"/><ellipse cx="12" cy="18" rx="7" ry="3" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="5" y1="6" x2="5" y2="18" stroke="currentColor" stroke-width="1.5"/><line x1="19" y1="6" x2="19" y2="18" stroke="currentColor" stroke-width="1.5"/><line x1="5.5" y1="12" x2="18.5" y2="12" stroke="currentColor" stroke-width="1" stroke-dasharray="2,2"/>',
  // Street Furniture
  'static.prop.bench01': '<rect x="3" y="10" width="18" height="2" rx="0.5"/><rect x="3" y="6" width="18" height="3" rx="0.5"/><line x1="5" y1="12" x2="5" y2="20" stroke="currentColor" stroke-width="1.5"/><line x1="19" y1="12" x2="19" y2="20" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="6" x2="5" y2="4" stroke="currentColor" stroke-width="1.5"/><line x1="19" y1="6" x2="19" y2="4" stroke="currentColor" stroke-width="1.5"/>',
  'static.prop.bench03': '<rect x="3" y="11" width="18" height="2" rx="0.5"/><line x1="5" y1="13" x2="4" y2="20" stroke="currentColor" stroke-width="1.5"/><line x1="19" y1="13" x2="20" y2="20" stroke="currentColor" stroke-width="1.5"/><line x1="9" y1="13" x2="9" y2="20" stroke="currentColor" stroke-width="1.5"/><line x1="15" y1="13" x2="15" y2="20" stroke="currentColor" stroke-width="1.5"/>',
  'static.prop.bin': '<polygon points="7,7 17,7 16,20 8,20"/><rect x="6" y="5" width="12" height="2" rx="0.5"/><line x1="10" y1="10" x2="10" y2="17" stroke="currentColor" stroke-width="1"/><line x1="14" y1="10" x2="14" y2="17" stroke="currentColor" stroke-width="1"/>',
  'static.prop.trashcan01': '<rect x="5" y="8" width="14" height="13" rx="1"/><rect x="4" y="6" width="16" height="2" rx="0.5"/><rect x="9" y="3" width="6" height="3" rx="0.5"/><line x1="9" y1="11" x2="9" y2="18" stroke="currentColor" stroke-width="1"/><line x1="12" y1="11" x2="12" y2="18" stroke="currentColor" stroke-width="1"/><line x1="15" y1="11" x2="15" y2="18" stroke="currentColor" stroke-width="1"/>',
  'static.prop.busstop': '<rect x="4" y="4" width="16" height="2" rx="0.5"/><line x1="5" y1="6" x2="5" y2="20" stroke="currentColor" stroke-width="1.5"/><line x1="19" y1="6" x2="19" y2="20" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="20" x2="19" y2="20" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="8" width="8" height="6" rx="0.5" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="12" y1="20" x2="12" y2="23" stroke="currentColor" stroke-width="1.5"/>',
  'static.prop.vendingmachine': '<rect x="5" y="2" width="14" height="20" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="7" y="4" width="10" height="7" rx="0.5" stroke="currentColor" stroke-width="1" fill="none"/><circle cx="9" cy="14" r="1" fill="currentColor"/><circle cx="12" cy="14" r="1" fill="currentColor"/><circle cx="15" cy="14" r="1" fill="currentColor"/><circle cx="9" cy="17" r="1" fill="currentColor"/><circle cx="12" cy="17" r="1" fill="currentColor"/><rect x="14" y="19" width="3" height="2" rx="0.5" fill="currentColor"/>',
  'static.prop.atm': '<rect x="4" y="3" width="16" height="18" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="7" y="5" width="10" height="6" rx="0.5" stroke="currentColor" stroke-width="1" fill="none"/><rect x="7" y="13" width="4" height="3" rx="0.5" stroke="currentColor" stroke-width="1" fill="none"/><line x1="14" y1="13" x2="17" y2="13" stroke="currentColor" stroke-width="1"/><line x1="14" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="1"/><line x1="14" y1="17" x2="17" y2="17" stroke="currentColor" stroke-width="1"/><rect x="7" y="18" width="10" height="1.5" rx="0.5" fill="currentColor"/>',
  'static.prop.mailbox': '<rect x="7" y="4" width="10" height="12" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M7 4 Q12 1 17 4" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="9" y="8" width="6" height="1.5" rx="0.5" fill="currentColor"/><line x1="12" y1="16" x2="12" y2="22" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="22" width="8" height="1.5" rx="0.5" fill="currentColor"/>',
  // Vegetation
  'static.prop.plantpot01': '<circle cx="12" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="13" x2="12" y2="16" stroke="currentColor" stroke-width="1.5"/><polygon points="7,16 17,16 15,22 9,22" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  'static.prop.plantpot03': '<line x1="12" y1="6" x2="12" y2="14" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="10" x2="8" y2="6" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="8" x2="16" y2="4" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="12" x2="7" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="6" x2="14" y2="2" stroke="currentColor" stroke-width="1.5"/><polygon points="7,14 17,14 15,22 9,22" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  'static.prop.plantpot05': '<rect x="3" y="16" width="18" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="16" x2="6" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="9" y1="16" x2="9" y2="10" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="16" x2="12" y2="11" stroke="currentColor" stroke-width="1.5"/><line x1="15" y1="16" x2="15" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="18" y1="16" x2="18" y2="13" stroke="currentColor" stroke-width="1.5"/>',
}

const TOP_CAR_BODY_PATH =
  'm184 97.21c-0.32-3.05-1.73-4.55-4.73-6.23l-3.31-1.81 0.05-9.08c2.3-1.11 2.8-2.83 2.8-6.18l0.14-28.09c0-4.53-1.05-6.11-4.1-7.87-0.67-9.68-2.25-17.89-6.64-22.97-6.04-6.8-22.51-8.52-40.18-8.52h-0.08c-17.67 0-34.14 1.72-40.18 8.52-4.39 5.08-5.97 13.29-6.64 22.97-3.05 1.76-4.36 3.34-4.36 8.67l-0.14 27.29c0 3.35 0.82 4.76 3.12 6.18l0.05 9.08-3.31 1.81c-3 1.68-4.41 3.18-4.73 6.23-0.19 1.72-0.81 4.45 0.55 3.98l7.25-3.14v75.86c-2.25 1.81-3.07 2.77-3.07 6.77l-0.1 27.06c0 3.94 0.92 5.45 3.45 6.98 0.62 7.89 1.29 17.39 3.54 23.9 1.95 5.9 8.08 7.48 12.52 8.69 7.84 2.2 20.3 2.72 31.91 2.68h0.14c11.61 0.04 24.07-1.17 31.91-3.37 4.44-1.21 10.57-2.1 12.52-9.3 1.53-6.04 2-14.71 2.62-22.6 2.53-1.53 4-3.04 3.95-6.98l0.1-27.95c0-3.45-0.72-4.45-3.12-5.88v-75.86l7.52 3.14c1.36 0.47 0.74-2.26 0.55-3.98zm-16.12 130c-0.28 1.53-1.1 0.76-1.82-0.51-2.04-3.59-4.34-6.8-4.34-9.9l0.43-28.57c0-0.53 0.52-0.67 0.99-0.24l5.51 5.76c0.96 0.91 0.91 2.08 0.86 3.39l-1.63 30.07zm2.05-46.27c0 1.36-1 1.36-1.82 0.59l-5.39-4.3c-0.82-0.58-1.1-1-1.1-2.58l0.43-28.85c0-1.05 0.57-1.67 1.72-1.77l5.3-0.57c0.67-0.1 1 0.28 1 1.14l-0.14 36.34zm0-46.18c0 1.21-0.53 1.59-1.29 1.73l-5.73 1.05c-0.58 0.1-0.58-0.43-0.58-0.91 0.1-9.4-0.23-19.4 2.07-27.3 1.76-6.55 4.05-14.25 4.67-14.63s0.86 0.24 0.86 1v39.06zm-18.77-120.9c6.18 1.46 15.62 3.9 17.05 9.94 0.38 1.62-0.24 1.43-1.5 0.86l-10.3-4.44c-2.82-1.21-5.35-3.12-6.01-5.12-0.43-1.27-0.62-1.7 0.76-1.24zm-3.1 12.23c-0.14-1 1.91-1 2.14 0.05l5.77 39.96c0.23 1.42-1.86 1.65-2.1 0.44l-5.81-40.45zm-34.15-14.91c4.25-0.43 8.83-0.52 13.99-0.52h0.05c4.25 0 8.83 0.09 13.55 0.52 2.2 0.19 3.41 2.29 4.13 4.25 0.38 1.05-0.62 0.57-1.43 0.48-5.5-0.72-10.49-1.05-16.25-1.05h-0.05c-5.76 0-10.75 0.33-16.25 1.05-0.81 0.09-1.81 0.57-1.43-0.48 0.72-1.96 1.93-4.06 3.69-4.25zm-7.61 14.96c0.23-1.05 2.28-1.05 2.14-0.05l-6.67 40.45c-0.23 1.21-2.67 1.59-2.34 0l6.87-40.4zm-16.22-7.09c3.2-3.15 8.69-4.41 14.73-5.67 1.11-0.28 1.25-0.05 0.68 1.26-1.05 2.53-3.49 4.34-7.39 5.71l-8.69 3.59c-1.31 0.57-1.69 0.71-1.21-1.19 0.42-1.53 0.9-2.79 1.88-3.7zm0.62 62.13c-0.57-2.43 6.73-5.21 15.03-7.31 7.99-2.05 14.54-2.91 22.17-2.91h0.05c7.63 0 14.18 0.86 22.17 2.91 8.3 2.1 15.6 4.88 15.03 7.31l-7.45 22.8c-0.62 1.86-2.92 1.14-4.59 0.57-7.09-1.95-16.04-2.85-25.16-2.85h-0.05c-9.12 0-18.07 0.9-25.16 2.85-1.67 0.57-3.97 1.29-4.59-0.57l-7.45-22.8zm-4.72 14.54c0-0.76 0.23-1.38 0.85-1s2.92 8.08 4.68 14.63c2.3 7.9 1.97 17.9 2.07 27.3 0 0.48 0 1.01-0.58 0.91l-5.73-1.05c-0.76-0.14-1.29-0.52-1.29-1.73v-39.06zm0 48.9c0-0.86 0.33-1.24 1-1.14l5.3 0.57c1.15 0.1 1.72 0.72 1.72 1.77l0.43 28.85c0 1.58-0.28 2-1.1 2.58l-5.39 4.3c-0.82 0.77-1.82 0.77-1.82-0.59l-0.14-36.34zm1.96 82.1-0.87-26.52c-0.05-2.05-0.86-5.05 0.71-6.67l5.55-5.52c0.48-0.43 1-0.29 1 0.24l0.24 28.57c0 3.1-2.87 6.31-4.92 9.9-0.67 1.27-1.48 2.04-1.71 0zm71.34 14.43c-1.36 1.26-17.07 3.7-31.33 3.7h-0.05c-14.26 0-29.97-1.86-31.83-3.67-1.36-1.31 0.1-4.26 1.41-7.26 1.47-3.49 1.8-4.81 3.76-4.62 8.79 1.37 15.44 1.75 26.66 1.65h0.05c9.22-0.09 15.88-1 26.1-2.31 2.15-0.28 2.72 1.58 4.19 6.02 1.21 3.73 2.26 5.4 1.04 6.49zm-7.89-27.7c0 2.68-3.99 2.68-3.99 0.19v-15.63h-39.84v15.44c0 2.58-3.63 2.3-3.63 0.19v-84.53c0-2.72 3.68-2.44 3.68-0.44v16.91h40.64v-16.47c0-2.68 3.39-2.44 3.39-0.34l-0.25 84.68z';
const TOP_CAR_CABIN_PATH = 'm107.6 149.3v44.46h40.64l0.24-44.46h-40.88z';

// ---------------------------------------------------------------------------
// Shared SVG wrapper props
// ---------------------------------------------------------------------------
interface SvgProps {
  className?: string
  style?: React.CSSProperties
}

type ActorIconVariant = "draft" | "live";

// ---------------------------------------------------------------------------
// Vehicle icon (car top-down silhouette)
// ---------------------------------------------------------------------------
export function VehicleIcon({
  className,
  style,
  variant = "draft",
}: SvgProps & { variant?: ActorIconVariant }) {
  const bodyStroke =
    variant === "live" ? "rgba(255,255,255,0.88)" : "rgba(15,20,25,0.95)";
  const cabinFill =
    variant === "live" ? "rgba(240,248,255,0.36)" : "rgba(231,244,255,0.28)";
  const cabinStroke =
    variant === "live" ? "rgba(240,248,255,0.62)" : "rgba(231,244,255,0.46)";

  return (
    <svg
      viewBox="-4 -4 8 8"
      fill="none"
      aria-hidden="true"
      className={className}
      width="100%"
      height="100%"
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <g transform="scale(0.028) translate(-128 -128)">
        <path
          d={TOP_CAR_BODY_PATH}
          fill="currentColor"
          stroke={bodyStroke}
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={TOP_CAR_CABIN_PATH}
          fill={cabinFill}
          stroke={cabinStroke}
          strokeWidth="0.18"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Bicycle icon (top-down silhouette — slimmer rectangle with circle wheels)
// ---------------------------------------------------------------------------
export function BicycleIcon({ className, style }: SvgProps) {
  return (
    <svg
      viewBox="-4 -4 8 8"
      fill="currentColor"
      stroke="rgba(15,20,25,0.95)"
      strokeWidth="0.18"
      vectorEffect="non-scaling-stroke"
      aria-hidden="true"
      className={className}
      width="100%"
      height="100%"
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <ellipse cx="0" cy="-1.8" rx="0.6" ry="0.5" />
      <ellipse cx="0" cy="1.8" rx="0.6" ry="0.5" />
      <rect x="-0.25" y="-1.6" width="0.5" height="3.2" />
      <rect x="-0.9" y="-0.2" width="1.8" height="0.4" rx="0.1" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Motorcycle icon (top-down — bicycle-like but bulkier with handlebars)
// ---------------------------------------------------------------------------
export function MotorcycleIcon({ className, style }: SvgProps) {
  return (
    <svg
      viewBox="-4 -4 8 8"
      fill="currentColor"
      stroke="rgba(15,20,25,0.95)"
      strokeWidth="0.18"
      vectorEffect="non-scaling-stroke"
      aria-hidden="true"
      className={className}
      width="100%"
      height="100%"
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <ellipse cx="0" cy="-1.8" rx="0.7" ry="0.55" />
      <ellipse cx="0" cy="1.8" rx="0.75" ry="0.6" />
      <rect x="-0.4" y="-1.6" width="0.8" height="3.2" rx="0.2" />
      <rect x="-1.1" y="-1.1" width="2.2" height="0.45" rx="0.18" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Walker icon (pedestrian silhouette)
// ---------------------------------------------------------------------------
export function WalkerIcon({ className, style }: SvgProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={0}
      aria-hidden="true"
      className={className}
      width="100%"
      height="100%"
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <circle cx="12" cy="5" r="2.2" />
      <path d="M12 8.5c-1.8 0-3 1.1-3 2.7v2.1h2V22h2v-4.5h2V22h2v-8.7h2v-2.1c0-1.6-1.2-2.7-3-2.7z" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Overhead camera icon — top-down surveillance box with downward vision cone
// ---------------------------------------------------------------------------
export function OverheadCameraIcon({ className, style }: SvgProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      width="100%"
      height="100%"
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <rect x="8" y="4" width="8" height="6" rx="1" />
      <path d="M7 10 4 20h16L17 10" opacity="0.3" fill="currentColor" stroke="none" />
      <path d="M7 10 4 20h16L17 10" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Street camera icon — top-down rectangular body with forward vision cone
// ---------------------------------------------------------------------------
export function StreetCameraIcon({ className, style }: SvgProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      width="100%"
      height="100%"
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <rect x="8" y="11" width="8" height="6" rx="1" />
      <path d="M7 11 3 3h18L17 11" opacity="0.3" fill="currentColor" stroke="none" />
      <path d="M7 11 3 3h18L17 11" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Prop icon — looks up PROP_SVG_ICONS by blueprint, falls back to circle.
// dangerouslySetInnerHTML is safe: content comes from the static PROP_SVG_ICONS
// constant above, never from user input.
// ---------------------------------------------------------------------------
interface PropIconProps extends SvgProps {
  blueprint: string
}

export function PropIcon({ blueprint, className, style }: PropIconProps) {
  const body =
    PROP_SVG_ICONS[blueprint] ??
    '<circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>'
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={0}
      aria-hidden="true"
      className={className}
      width="100%"
      height="100%"
      style={{ display: "block", overflow: "visible", ...style }}
      // Safe: body is sourced exclusively from the static PROP_SVG_ICONS map.
      dangerouslySetInnerHTML={{ __html: body }}
    />
  )
}

// ---------------------------------------------------------------------------
// ActorIcon — dispatcher
// ---------------------------------------------------------------------------
interface ActorIconProps extends SvgProps {
  kind: 'vehicle' | 'walker' | 'prop' | 'overhead_camera' | 'street_camera'
  blueprint?: string
  variant?: ActorIconVariant
}

export function ActorIcon({ kind, blueprint, className, style, variant = "draft" }: ActorIconProps) {
  switch (kind) {
    case 'vehicle': {
      // Distinguish bicycle / motorcycle blueprints from cars so the
      // editor map preview matches what CARLA will spawn. Without this
      // every vehicle — including CARLA's bike blueprints
      // (`vehicle.bh.crossbike`, `vehicle.diamondback.century`,
      // `vehicle.gazelle.omafiets`) and motorcycle blueprints
      // (`vehicle.harley-davidson.*`, `vehicle.kawasaki.*`, etc.) —
      // would render as the generic car silhouette and a "Traffic"
      // label, hiding the cyclist NPC inside cut-in / pedestrian-
      // adjacent scenarios behind a car icon.
      const bp = (blueprint ?? '').toLowerCase();
      const isBicycle =
        bp.includes('crossbike') ||
        bp.includes('bicycle') ||
        bp.includes('diamondback') ||
        bp.includes('gazelle') ||
        bp.includes('omafiets');
      const isMotorcycle =
        bp.includes('motorcycle') ||
        bp.includes('motorbike') ||
        bp.includes('harley') ||
        bp.includes('kawasaki') ||
        bp.includes('yamaha') ||
        bp.includes('ninja');
      if (isBicycle) return <BicycleIcon className={className} style={style} />
      if (isMotorcycle) return <MotorcycleIcon className={className} style={style} />
      return <VehicleIcon className={className} style={style} variant={variant} />
    }
    case 'walker':
      return <WalkerIcon className={className} style={style} />
    case 'overhead_camera':
      return <OverheadCameraIcon className={className} style={style} />
    case 'street_camera':
      return <StreetCameraIcon className={className} style={style} />
    case 'prop':
      return <PropIcon blueprint={blueprint ?? ''} className={className} style={style} />
  }
}
