/** An error the review API answers with: an HTTP status, a code for the UI, and an optional hint. */
export class ReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}
