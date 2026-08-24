import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERATED_TOC_END,
  GENERATED_TOC_START,
  generatedTableOfContents,
  refreshGeneratedTableOfContents,
  representNativeTableOfContents,
  representNativeTableOfContentsFromRemote,
  restoreNativeTableOfContents,
  stripGeneratedTableOfContents,
} from "../src/toc.js";

test("generates a quiet Markdown TOC from headings and explicit fragments", () => {
  const markdown = "# Guide\n\n## First [topic]\n\n## Duplicate\n\n## Duplicate {#chosen}\n";
  assert.equal(generatedTableOfContents(markdown), [
    GENERATED_TOC_START,
    "",
    "**Table of Contents**",
    "",
    "[Guide](#guide)",
    "",
    "[First \\[topic\\]](#first-topic)",
    "",
    "[Duplicate](#duplicate)",
    "",
    "[Duplicate](#chosen)",
    "",
    GENERATED_TOC_END,
  ].join("\n"));
});

test("refreshes marked entries while leaving ordinary static TOCs alone", () => {
  const staticToc = "**Table of Contents**\n\n[Old](#old)\n\n## New\n";
  assert.equal(refreshGeneratedTableOfContents(staticToc), staticToc);

  const marked = `${GENERATED_TOC_START}\nwrong\n${GENERATED_TOC_END}\n\n## New\n`;
  assert.match(refreshGeneratedTableOfContents(marked), /\[New\]\(#new\)/);
  assert.doesNotMatch(refreshGeneratedTableOfContents(marked), /wrong/);
});

test("represents a confirmed native Google TOC with generated markers", () => {
  const exported = "Intro\n\n**Table of Contents**\n\n[Old](#old)\n\n## Current\n\nBody\n";
  const represented = representNativeTableOfContents(exported);
  assert.match(represented, new RegExp(GENERATED_TOC_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(represented, /\[Current\]\(#current\)/);
  assert.doesNotMatch(represented, /\[Old\]/);
  assert.doesNotMatch(stripGeneratedTableOfContents(represented), /Table of Contents/);
});

test("restores the remote native TOC only for the Google update view", () => {
  const local = `Intro\n\n${GENERATED_TOC_START}\n\n**Table of Contents**\n\n[New](#new)\n\n${GENERATED_TOC_END}\n\n## New\n`;
  const remote = "Old intro\n\n**Table of Contents**\n\n[Old](#old)\n\n## Old\n";
  const restored = restoreNativeTableOfContents(local, remote);
  assert.match(restored, /\[Old\]\(#old\)/);
  assert.doesNotMatch(restored, /gdms:generated-toc/);
  assert.match(restored, /## New/);
});

test("recreates a removed generated range at the native TOC position", () => {
  const local = "Intro\n\n## First\n\nBody\n";
  const remote = "Intro\n\n**Table of Contents**\n\n[First](#first)\n\n## First\n\nBody\n";
  const represented = representNativeTableOfContentsFromRemote(local, remote);
  assert.match(represented, /gdms:generated-toc:start/);
  assert.ok(represented.indexOf("gdms:generated-toc:start") < represented.indexOf("## First"));
});

test("rejects malformed generated TOC markers", () => {
  assert.throws(
    () => refreshGeneratedTableOfContents(`${GENERATED_TOC_START}\ncontent`),
    /only one GDMS marker/,
  );
});
