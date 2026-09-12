// 公開設定から生成できない secret の名前だけを補足する。値は持たない。
interface Env {
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  INGEST_SECRET: string;
}
