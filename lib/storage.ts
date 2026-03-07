import { Client } from "minio";

if (!process.env.MINIO_ACCESS_KEY || !process.env.MINIO_SECRET_KEY) {
  throw new Error("MINIO_ACCESS_KEY and MINIO_SECRET_KEY environment variables are required");
}

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || "localhost",
  port: parseInt(process.env.MINIO_PORT || "9000", 10),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

const BUCKET = process.env.MINIO_BUCKET || "sparkstack";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

let bucketReady = false;

export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const exists = await minioClient.bucketExists(BUCKET);
  if (!exists) {
    await minioClient.makeBucket(BUCKET);
  }
  bucketReady = true;
}

export async function putFile(key: string, data: Buffer | string): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  if (buf.length > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large (${buf.length} bytes, max ${MAX_UPLOAD_SIZE})`);
  }
  await ensureBucket();
  await minioClient.putObject(BUCKET, key, buf);
}

export async function getFile(key: string): Promise<Buffer> {
  await ensureBucket();
  const stream = await minioClient.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function deleteFile(key: string): Promise<void> {
  await ensureBucket();
  await minioClient.removeObject(BUCKET, key);
}

export async function fileExists(key: string): Promise<boolean> {
  await ensureBucket();
  try {
    await minioClient.statObject(BUCKET, key);
    return true;
  } catch {
    return false;
  }
}
