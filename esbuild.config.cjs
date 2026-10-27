const esbuild = require("esbuild");

const isProduction = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: {
    client: "src/client/extension.ts",
    server: "src/server/server.ts"
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: !isProduction,
  minify: isProduction,
  treeShaking: true
};

const build = isWatch
  ? esbuild.context(buildOptions).then((context) => context.watch())
  : esbuild.build(buildOptions);

build.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
