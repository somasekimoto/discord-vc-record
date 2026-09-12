// Node のHTTPクライアント専用。Worker globals をimportしない。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function readObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error('Expected JSON object');
  return value;
}
export async function readUpload(response: Response): Promise<{ key: string; uploadId: string }> {
  const value = await readObject(response);
  if (typeof value.key !== 'string' || typeof value.uploadId !== 'string') throw new Error('Expected upload key/id');
  return { key: value.key, uploadId: value.uploadId };
}
