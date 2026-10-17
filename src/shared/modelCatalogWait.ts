/** A directory may finish later; only the foreground wait has a deadline. */
export async function waitForModelCatalog(
  request: Promise<boolean>,
  startedAt: number
): Promise<'ready' | 'failed' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.then(ready => ready ? 'ready' as const : 'failed' as const, () => 'failed' as const),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, 2_000 - (Date.now() - startedAt)));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
