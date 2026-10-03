/** Error 以外の mock / 外部例外も従来のプロパティ参照と同様に扱う(関数に付いたプロパティも含む)。 */
function hasProp<K extends string>(error: unknown, key: K): error is Record<K, unknown> {
  return (typeof error === 'object' || typeof error === 'function') && error !== null && key in error;
}
export function errorMessage(error: unknown): unknown {
  return hasProp(error, 'message') ? error.message : undefined;
}
export function errorCode(error: unknown): unknown {
  return hasProp(error, 'code') ? error.code : undefined;
}
