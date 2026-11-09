// Imported first by the CLI: drops two harmless notices dependencies print on every start ("bigint: Failed to load
// bindings, pure JS will be used" and the punycode deprecation), so --json output and MCP stdio stay clean.
const isNoise = (a: unknown) => typeof a === 'string' && (a.startsWith('bigint: Failed to load bindings') || /The `punycode` module is deprecated/.test(a));
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => { if (!isNoise(args[0])) warn(...args); };
const error = console.error.bind(console);
console.error = (...args: unknown[]) => { if (!isNoise(args[0])) error(...args); };
const emit = process.emitWarning.bind(process) as (...a: unknown[]) => void;
process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
  const text = typeof w === 'string' ? w : (w as Error)?.message;
  const code = typeof rest[1] === 'string' ? rest[1] : (rest[0] as { code?: string } | undefined)?.code;
  if (isNoise(text) || code === 'DEP0040') return;
  emit(w, ...rest);
}) as typeof process.emitWarning;
export {};
