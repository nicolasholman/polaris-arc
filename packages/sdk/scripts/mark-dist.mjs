/**
 * Node decides CJS-or-ESM per directory from the nearest package.json "type".
 * Without these two markers it reads dist/cjs/*.js under the root package's
 * type and throws on the first require(), so the dual build only holds
 * together while they are present.
 */

import { writeFileSync } from "node:fs";

writeFileSync("dist/esm/package.json", `${JSON.stringify({ type: "module" }, null, 2)}\n`);
writeFileSync("dist/cjs/package.json", `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
