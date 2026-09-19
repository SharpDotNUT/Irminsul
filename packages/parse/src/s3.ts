/**
 * `parse upload` 的对象存储通道：Bun 内置的 `Bun.S3Client`（R2 兼容 S3 协议）。
 * `tsconfig` 只挂 `types: ["node"]`，所以这里声明实际用到的那点 Bun 表面，而不是引入 bun-types。
 */

const ENV = {
  accessKeyId: "R2_ACCESS_KEY_ID",
  secretAccessKey: "R2_SECRET_ACCESS_KEY",
  bucket: "R2_BUCKET_NAME",
  endpoint: "R2_ENDPOINT",
} as const;

const LIST_PAGE_SIZE = 1000;

type S3Object = { key: string; size: number };
type S3ListPage = { contents?: S3Object[]; nextContinuationToken?: string };
type S3ClientLike = {
  write: (key: string, data: Blob) => Promise<number>;
  list: (options: { prefix: string; maxKeys: number; continuationToken?: string }) => Promise<S3ListPage>;
};
type BunGlobal = {
  S3Client: new (options: Record<string, string>) => S3ClientLike;
  file: (path: string) => Blob;
};
declare const Bun: BunGlobal;

/** 目标 bucket + 上传要用的两个操作。 */
export type S3 = {
  bucket: string;
  /** 按前缀列举远端对象（自动翻页）：key -> 字节数。 */
  listKeys: (prefix: string) => Promise<Map<string, number>>;
  /** 上传单个文件；Content-Type 由文件扩展名推断。 */
  upload: (key: string, path: string) => Promise<void>;
};

/** 从 `R2_*` 环境变量建立连接（`.env` 由 Bun 自动加载）。 */
export function createS3(): S3 {
  const missing = Object.values(ENV).filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量 ${missing.join(", ")}（Cloudflare R2 配置，可写进项目根 .env）`);
  }
  const endpoint = process.env[ENV.endpoint]!;
  if (!URL.canParse(endpoint)) throw new Error(`${ENV.endpoint} 不是合法 URL: ${endpoint}`);

  const options = {
    accessKeyId: process.env[ENV.accessKeyId]!,
    secretAccessKey: process.env[ENV.secretAccessKey]!,
    bucket: process.env[ENV.bucket]!,
    endpoint,
    // R2 不区分区域，官方约定的取值就是 auto。
    region: "auto",
  };
  const client = new Bun.S3Client(options);

  return {
    bucket: options.bucket,
    async listKeys(prefix) {
      const keys = new Map<string, number>();
      let continuationToken: string | undefined;
      do {
        const page = await client.list({
          prefix,
          maxKeys: LIST_PAGE_SIZE,
          ...(continuationToken ? { continuationToken } : {}),
        });
        for (const object of page.contents ?? []) keys.set(object.key, object.size);
        continuationToken = page.nextContinuationToken;
      } while (continuationToken);
      return keys;
    },
    async upload(key, path) {
      await client.write(key, Bun.file(path));
    },
  };
}
