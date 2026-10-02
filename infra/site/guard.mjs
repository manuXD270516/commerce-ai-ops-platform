// What must never reach the public site: local paths, connection strings, tokens, keys or emails.
const FORBIDDEN = [
  [/[A-Za-z]:\\/, 'Windows path'],
  [/\/(?:home|Users|runner)\//, 'local path'],
  [/postgres(?:ql)?:\/\/|rediss?:\/\//, 'connection string'],
  [/Bearer\s+[A-Za-z0-9_-]+\./, 'bearer token'],
  [/"d"\s*:\s*"/, 'private JWK'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'email address'],
];

/** Kinds of private data found in `text` (empty when it is safe to publish). */
export function findPrivateData(text) {
  return FORBIDDEN.filter(([re]) => re.test(text)).map(([, what]) => what);
}
