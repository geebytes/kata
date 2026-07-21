// Asset modules inlined by scripts/build.mjs at bundle time.
// Any `kata-asset:<path>` import resolves to the file content as a string.
declare module 'kata-asset:*' {
  const content: string;
  export default content;
}
