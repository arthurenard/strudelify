/** Bundle the installed browser packages so their ESM exports can also be tested in Node. */
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const result = buildSync({
  stdin: {
    contents: 'export * from "@strudel/core"; export * from "@strudel/mini"; export { transpiler } from "@strudel/transpiler"; import "@strudel/tonal";',
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, platform: 'browser', format: 'esm', write: false,
});
export const runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
runtime.setStringParser(runtime.mini);
const names = Object.keys(runtime).filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
const values = names.map(name => runtime[name]);

/** Execute generated code and return its final pattern without starting audio. */
export function evaluatePattern(code) {
  const source = code.replace(/^setcpm\([^\n]*\)\s*$/m, '');
  const body = runtime.transpiler(source, { emitMiniLocations: false, emitWidgets: false }).output;
  return new Function(...names, `return (() => {\n${body}\n})()`)(...values);
}
