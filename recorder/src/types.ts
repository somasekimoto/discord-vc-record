/** Error 以外の mock / 外部例外も従来のプロパティ参照と同様に扱う。 */
export function errorMessage(error: unknown): unknown {
  return error != null && typeof error === 'object' && 'message' in error ? error.message : undefined;
}
export function errorCode(error: unknown): unknown {
  return error != null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}
