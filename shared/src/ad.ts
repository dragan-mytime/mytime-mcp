/** One competitor ad observed in the Meta Ad Library during one run. */
export interface AdObservation {
  adArchiveId: string;
  startedRunningDate: string | null; // YYYY-MM-DD
  daysRunning: number | null;
  platforms: string[]; // e.g. ["facebook","instagram"]
  ctaType: string | null;
  linkUrl: string | null;
  adTitle: string | null;
  adBody: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  snapshotUrl: string | null;
}
