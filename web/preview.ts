interface PreviewBuild {
  repository: string;
  pr: number;
  sha: string;
  title: string;
  run: string;
  artifact: string;
}
/** Preparation is an authenticated POST; loading the URL alone never installs an app. */
export async function preparePreview(demo: boolean): Promise<void> {
  const gate = document.createElement("section");
  gate.className = "preview-gate";
  const heading = document.createElement("h1");
  heading.textContent = "Simulator Preview";
  const detail = document.createElement("p");
  detail.setAttribute("role", "status");
  const retry = document.createElement("button");
  retry.textContent = "Try again";
  retry.hidden = true;
  gate.append(heading, detail, retry);
  document.body.append(gate);
  const match = /^\/builds\/[1-9]\d*\/[1-9]\d*\/?$/.test(location.pathname);
  if (!match) {
    detail.textContent =
      "Open the preview link in your pull request to run that build in the browser.";
    if (demo) {
      const link = document.createElement("a");
      link.href = "/builds/1/1";
      link.textContent = "Open local demo →";
      gate.append(link);
    }
    await new Promise(() => {});
    return;
  }
  const endpoint = `/api${location.pathname.replace(/\/$/, "")}`;
  async function request(method: string) {
    const response = await fetch(endpoint, {
      method,
      headers: method === "POST" ? { "X-Preview-Request": "1" } : {},
      signal: AbortSignal.timeout(30_000),
    });
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        "Your session may have expired. Reload this page to sign in again.",
      );
    }
    if (!response.ok)
      throw new Error(data.error ?? "Could not prepare this preview.");
    return data;
  }
  for (;;) {
    try {
      retry.hidden = true;
      detail.textContent = "Preparing your preview…";
      let result = await request("POST");
      const deadline = Date.now() + 15 * 60_000;
      while (result.state === "preparing") {
        if (Date.now() > deadline)
          throw new Error(
            "Preparation is taking longer than expected. Retry to check its progress.",
          );
        detail.textContent = result.message;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        result = await request("GET");
      }
      if (result.state !== "ready")
        throw new Error(result.message ?? "Preview preparation failed.");
      const build = result.build as PreviewBuild;
      const banner = document.createElement("section");
      banner.className = "panel preview-build";
      const name = document.createElement("strong");
      name.textContent = `${build.repository} · PR #${build.pr}`;
      const title = document.createElement("p");
      title.textContent = build.title;
      const commit = document.createElement("code");
      commit.textContent = `${build.sha.slice(0, 7)} · Build ${build.run}`;
      banner.append(name, title, commit);
      document.querySelector("aside")!.prepend(banner);
      document.title = `PR #${build.pr} · ${build.sha.slice(0, 7)} · Simulator Preview`;
      gate.remove();
      return;
    } catch (error) {
      heading.textContent = "Preview unavailable";
      detail.textContent =
        error instanceof Error
          ? error.message
          : "Could not prepare this preview.";
      retry.hidden = false;
      await new Promise<void>((resolve) => {
        retry.onclick = () => resolve();
      });
      heading.textContent = "Simulator Preview";
    }
  }
}
