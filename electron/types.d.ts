// Ambient type declarations for ESM-only packages used via dynamic import()

declare module 'trash' {
  function trash(
    input: string | readonly string[],
    options?: { glob?: boolean }
  ): Promise<void>;
  export default trash;
}
