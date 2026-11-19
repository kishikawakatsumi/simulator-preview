import { copyFile, mkdir } from "node:fs/promises";
await mkdir("dist/web", { recursive: true });
for (const file of ["index.html", "style.css", "manifest.webmanifest"])
  await copyFile(`web/${file}`, `dist/web/${file}`);
