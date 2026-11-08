/**
 * Stops slow page loads from landing in the wrong channel. Two separate questions:
 * - Is this switch still the newest one asked for? (Clicking A then B must end on B.)
 * - Is the list this paging started from still on screen? That list only changes when a switch
 *   lands, and going A → B → A replaces it too, even though the channel ends up the same.
 */
export class PageGuard {
  private requested = 0
  private shown = 0

  /** A switch starts and overrides any before it. The result says whether it's still the newest. */
  beginSwitch(): () => boolean {
    const mine = ++this.requested
    return () => mine === this.requested
  }

  /** A switch has replaced the list: paging that started against the old one no longer applies. */
  landed(): void {
    this.shown++
  }

  /** Paging starts. The result says whether the list it started from is still the one shown. */
  watchList(): () => boolean {
    const mine = this.shown
    return () => mine === this.shown
  }
}
