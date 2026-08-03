/**
 * Reading Postgres' verdict off an error.
 *
 * Drizzle wraps driver errors, so the SQLSTATE lives somewhere down the `cause`
 * chain rather than on the error you catch. Unwrapping it here keeps that
 * knowledge in one place instead of in every call site that wants to tell "this
 * slug is taken" apart from "the database is on fire".
 */

/** Walks to the root cause and returns its SQLSTATE, if it has one. */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return (current as { code?: string } | undefined)?.code;
}

/** 23505 — unique_violation. */
export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === "23505";
}
