/** Do not inherit another tool's Node preload hooks into our own executables. */
export function childProcessEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/^(NODE_OPTIONS|NODE_PATH)$/i.test(key)) delete next[key];
  }
  return next;
}
