import { access } from "node:fs/promises";
for (const path of [
  "public/index.html",
  "public/app.js",
  "public/style.css",
  "public/font.woff2",
  "api/index.js",
])
  await access(path);
console.log("Lunchpass static assets and serverless entry are ready.");
