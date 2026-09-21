declare module "lindvimera:assets" {
  const assets: Readonly<Record<string, { gzipBase64: string; bytes: number }>>;
  export default assets;
}
