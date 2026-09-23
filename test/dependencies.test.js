import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));

// brace-expansion reaches the tree only through
// googleapis > googleapis-common > gaxios > rimraf > glob > minimatch, which declares
// ^2.0.2. Version 2.1.4 is the first 2.x release patched for both CVE-2026-14257
// (GHSA-mh99-v99m-4gvg, patched 2.1.3) and CVE-2026-69152 (GHSA-rgw5-rvv9-x895, patched
// 2.1.4), which bypasses the CVE-2026-14257 mitigation.
const BRACE_EXPANSION_MINIMUM = [2, 1, 4];

function parseVersion(version) {
  const numbers = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(numbers, `expected a semantic version, received ${version}`);
  return numbers.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// Deliberately narrow: only caret ranges are understood, and anything else fails loudly
// rather than being silently treated as satisfied.
function satisfiesCaret(version, range) {
  assert.match(range, /^\^\d+\.\d+\.\d+$/, `unsupported dependency range ${range}`);
  const lowerBound = parseVersion(range.slice(1));
  return version[0] === lowerBound[0] && compareVersions(version, lowerBound) >= 0;
}

function resolvedVersion(name) {
  const entry = lockfile.packages[`node_modules/${name}`];
  assert.ok(entry, `expected ${name} in the lockfile`);
  return parseVersion(entry.version);
}

function declaredRanges(name) {
  return Object.entries(lockfile.packages)
    .flatMap(([location, entry]) => {
      const ranges = {
        ...entry.dependencies,
        ...entry.optionalDependencies,
        ...entry.peerDependencies,
      };
      return ranges[name] ? [{ location: location || "the project root", range: ranges[name] }] : [];
    });
}

test("brace-expansion is patched for CVE-2026-14257 and CVE-2026-69152", () => {
  const version = resolvedVersion("brace-expansion");
  assert.ok(
    compareVersions(version, BRACE_EXPANSION_MINIMUM) >= 0,
    `brace-expansion ${version.join(".")} is older than the patched ${BRACE_EXPANSION_MINIMUM.join(".")}`,
  );
});

test("the resolved brace-expansion satisfies every declared dependency range", () => {
  const version = resolvedVersion("brace-expansion");
  const dependers = declaredRanges("brace-expansion");
  assert.ok(dependers.length > 0, "expected at least one declared brace-expansion range");
  for (const { location, range } of dependers) {
    assert.ok(
      satisfiesCaret(version, range),
      `brace-expansion ${version.join(".")} does not satisfy ${range} declared by ${location}`,
    );
  }
});
