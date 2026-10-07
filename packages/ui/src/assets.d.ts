// The brand wordmark, typed here so any consumer's `tsc` resolves it without
// Next.js's generated image declarations. An exact module name wins over the
// `*.png` wildcard Next.js declares, so the two never clash.
declare module "@polaris/brand/assets/wordmark.png" {
  const wordmark: { src: string; width: number; height: number } | string;
  export default wordmark;
}
