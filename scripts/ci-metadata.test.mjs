import { test, expect } from "bun:test";
import { imageMetadata } from "./ci-metadata.mjs";

const base = {
  repository: "AmirHmZz/datahelm",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
  backendVersion: "0.1.0",
  frontendVersion: "0.1.0",
};

test("main publishes edge and an immutable commit tag, without latest", () => {
  const metadata = imageMetadata(base);
  expect(metadata.tags).toEqual([
    `ghcr.io/amirhmzz/datahelm:sha-${base.sha}`,
    "ghcr.io/amirhmzz/datahelm:edge",
  ]);
  expect(metadata.version).toBe("edge");
});

test("a matching stable tag publishes version, minor and latest aliases", () => {
  const metadata = imageMetadata({ ...base, ref: "refs/tags/v0.1.0" });
  expect(metadata.tags).toEqual([
    "ghcr.io/amirhmzz/datahelm:0.1.0",
    "ghcr.io/amirhmzz/datahelm:0.1",
    "ghcr.io/amirhmzz/datahelm:latest",
  ]);
  expect(metadata.version).toBe("0.1.0");
});

test("pull requests cannot select a mutable publishing alias", () => {
  expect(imageMetadata({ ...base, ref: "refs/pull/12/merge" }).tags).toHaveLength(1);
});

test("rejects invalid release inputs", () => {
  for (const patch of [
    { ref: "refs/tags/v0.2.0" },
    { ref: "refs/tags/v0.1.0-rc.1" },
    { backendVersion: "0.1.0-rc.1", frontendVersion: "0.1.0-rc.1" },
    { frontendVersion: "0.2.0" },
    { sha: "abcdef" },
    { repository: "someone/datahelm" },
    { ref: "refs/heads/feature" },
  ]) expect(() => imageMetadata({ ...base, ...patch })).toThrow();
});
