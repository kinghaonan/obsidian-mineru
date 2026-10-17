/**
 * 用 esbuild 把 tests/*.test.ts 打包到 .test-build/，
 * 并把 "obsidian" 指向 tests/stubs/obsidian.ts，随后交给 node --test 运行。
 *
 *   node tests/build.mjs
 */
import { build } from "esbuild";
import { rm, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".test-build");
const testsDir = path.join(root, "tests");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entryPoints = (await readdir(testsDir))
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => path.join(testsDir, name));

if (entryPoints.length === 0) {
	console.error("没有找到 tests/*.test.ts");
	process.exit(1);
}

await build({
	entryPoints,
	outdir: outDir,
	outExtension: { ".js": ".cjs" },
	bundle: true,
	platform: "node",
	target: "node20",
	format: "cjs",
	sourcemap: "inline",
	logLevel: "info",
	external: ["jszip"],
	alias: {
		obsidian: path.join(testsDir, "stubs", "obsidian.ts"),
	},
});