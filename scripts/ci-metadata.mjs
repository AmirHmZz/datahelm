import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

export function imageMetadata({ repository, sha, ref, backendVersion, frontendVersion }) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!stable.test(backendVersion) || backendVersion !== frontendVersion)
    throw new Error("Backend and frontend must declare the same stable version");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected a full commit SHA");
  if (repository.toLowerCase() !== "amirhmzz/datahelm")
    throw new Error("Publishing is configured for AmirHmZz/datahelm only");

  const image = `ghcr.io/${repository.toLowerCase()}`;
  let tags = [`${image}:sha-${sha}`];
  let version = "edge";
  if (ref.startsWith("refs/tags/")) {
    const tag = ref.slice("refs/tags/".length);
    if (tag !== `v${backendVersion}`)
      throw new Error("Release tag must be vX.Y.Z and match both package versions");
    version = backendVersion;
    tags = [
      `${image}:${version}`,
      `${image}:${version.split(".").slice(0, 2).join(".")}`,
      `${image}:latest`,
    ];
  } else if (ref === "refs/heads/main") {
    tags.push(`${image}:edge`);
  } else if (!/^refs\/pull\/\d+\/merge$/.test(ref)) {
    throw new Error("Expected main, a version tag, or a pull request merge ref");
  }
  return { image, version, tags };
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const manifest = readFileSync(resolve(root, "backend/Cargo.toml"), "utf8");
  const metadata = imageMetadata({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    backendVersion: manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    frontendVersion: JSON.parse(readFileSync(resolve(root, "frontend/package.json"), "utf8")).version,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `image=${metadata.image}\nversion=${metadata.version}\ntags<<DATAHELM_TAGS\n${metadata.tags.join("\n")}\nDATAHELM_TAGS\n`);
}
