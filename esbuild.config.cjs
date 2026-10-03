const esbuild = require("esbuild");

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
  sourcemap: true
};

const build = process.argv.includes("--watch")
  ? esbuild.context(buildOptions).then((context) => context.watch())
  : esbuild.build(buildOptions);

build.catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
