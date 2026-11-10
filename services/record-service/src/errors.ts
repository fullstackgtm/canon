export class HttpError extends Error {
  readonly status: number;
  readonly issues?: unknown;
  constructor(status: number, message: string, issues?: unknown) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}
