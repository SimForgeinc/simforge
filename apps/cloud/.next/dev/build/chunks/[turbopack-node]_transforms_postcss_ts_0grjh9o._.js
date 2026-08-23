module.exports = [
"[turbopack-node]/transforms/postcss.ts?config=[project]/apps/cloud/postcss.config.mjs { CONFIG => \"[project]/apps/cloud/postcss.config.mjs [postcss] (ecmascript)\" } [postcss] (ecmascript, async loader)", ((__turbopack_context__) => {

__turbopack_context__.v((parentImport) => {
    return Promise.all([
  "chunks/node_modules__pnpm_0y076d_._.js",
  "chunks/[root-of-the-server]__1i_q4fp._.js"
].map((chunk) => __turbopack_context__.l(chunk))).then(() => {
        return parentImport("[turbopack-node]/transforms/postcss.ts?config=[project]/apps/cloud/postcss.config.mjs { CONFIG => \"[project]/apps/cloud/postcss.config.mjs [postcss] (ecmascript)\" } [postcss] (ecmascript)");
    });
});
}),
];