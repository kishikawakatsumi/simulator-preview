import { resolve } from "node:path";
export function previewConfig(env: NodeJS.ProcessEnv = process.env) {
  const repository = env.PREVIEW_REPOSITORY ?? "";
  const demo = env.PREVIEW_DEMO === "1";
  if (!demo && !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error(
      "Set PREVIEW_REPOSITORY=owner/repo, or PREVIEW_DEMO=1 for local testing",
    );
  if (!demo && !env.GITHUB_TOKEN)
    throw new Error(
      "Set GITHUB_TOKEN with Actions and Pull requests read access",
    );
  if (demo && (env.PREVIEW_AUTH ?? "local") !== "local")
    throw new Error("Demo mode is local only");
  const workflow =
    env.PREVIEW_WORKFLOW ?? ".github/workflows/simulator-preview-build.yml";
  if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow))
    throw new Error("Invalid PREVIEW_WORKFLOW");
  return {
    repository,
    token: env.GITHUB_TOKEN ?? "",
    workflow,
    demo,
    demoArchive: resolve(
      env.PREVIEW_DEMO_ARCHIVE ?? "example-build/artifact.zip",
    ),
    directory: resolve(env.PREVIEW_STATE_DIR ?? ".preview", "builds"),
    artifactName: "simulator-preview",
    maxDownload: 512 * 1024 * 1024,
    maxCache: 10 * 1024 ** 3,
  };
}
export type PreviewConfig = ReturnType<typeof previewConfig>;
export function buildReference(path: string) {
  const match = /^\/builds\/([1-9]\d{0,15})\/([1-9]\d{0,15})\/?$/.exec(path);
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    !Number.isSafeInteger(Number(match[2]))
  )
    return undefined;
  return {
    run: match[1]!,
    artifact: match[2]!,
    key: `${match[1]}-${match[2]}`,
  };
}
export type BuildReference = NonNullable<ReturnType<typeof buildReference>>;
export class PreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
