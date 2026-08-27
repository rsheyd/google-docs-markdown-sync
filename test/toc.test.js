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
  const exported = "Intro\n\n**Table of Contents**\n\n[Current](#current)\n\n## Current\n\nBody\n";
  const represented = representNativeTableOfContents(exported);
  assert.match(represented, new RegExp(GENERATED_TOC_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(represented, /\[Current\]\(#current\)/);
  assert.match(represented, /\*\*Table of Contents\*\*/);
  assert.match(stripGeneratedTableOfContents(represented), /Table of Contents/);
});

test("represents an unlabeled native Google TOC while removing empty wrapper headings", () => {
  const exported = "# \n\n[Call Summary](#call-summary)\n\n\n\n[Next Steps](#next-steps)\n\n# \n\n# Call Summary\n\nBody\n\n## Next Steps\n";
  const represented = representNativeTableOfContents(exported);
  assert.match(represented, /gdms:generated-toc:start/);
  assert.match(represented, /\[Call Summary\]\(#call-summary\)/);
  assert.match(represented, /\[Next Steps\]\(#next-steps\)/);
  assert.equal(represented.match(/^#\s*$/gm)?.length ?? 0, 0);
  assert.doesNotMatch(represented, /\*\*Table of Contents\*\*/);
});

test("does not use a user-authored Table of Contents label as the native range", () => {
  const exported = "**Table of Contents**\n\n[First](#first)\n\n## First\n";
  const represented = representNativeTableOfContents(exported);
  assert.ok(represented.indexOf("**Table of Contents**") < represented.indexOf(GENERATED_TOC_START));
  assert.equal(represented.match(/\*\*Table of Contents\*\*/g)?.length, 1);
});

test("matches native TOC labels when Google and Markdown fragment rules differ", () => {
  const exported = "**Table of Contents**\n\n[30/60/90-Day Action Plan](#30/60/90-day-action-plan)\n\n## 30/60/90-Day Action Plan\n";
  const represented = representNativeTableOfContents(exported);
  assert.match(represented, /gdms:generated-toc:start/);
  assert.match(represented, /\*\*Table of Contents\*\*/);
});

test("restores the remote native TOC only for the Google update view", () => {
  const local = `Intro\n\n${GENERATED_TOC_START}\n\n[New](#new)\n\n${GENERATED_TOC_END}\n\n## New\n`;
  const remote = "Old intro\n\n[Old](#old)\n\n## Old\n";
  const restored = restoreNativeTableOfContents(local, remote);
  assert.match(restored, /\[Old\]\(#old\)/);
  assert.doesNotMatch(restored, /gdms:generated-toc/);
  assert.match(restored, /## New/);
});

test("normalizes Google export spacing between native TOC entries", () => {
  const local = `${GENERATED_TOC_START}\n\n[One](#one)\n\n[Two](#two)\n\n${GENERATED_TOC_END}\n\n## One\n\n## Two\n`;
  const remote = "[One](#one)\n\n\n\n[Two](#two)\n\n## One\n\n## Two\n";
  const restored = restoreNativeTableOfContents(local, remote);
  assert.match(restored, /^\[One\]\(#one\)\n\n\[Two\]\(#two\)/);
});

test("recreates a removed generated range at the native TOC position", () => {
  const local = "Intro\n\n## First\n\nBody\n";
  const remote = "Intro\n\n[First](#first)\n\n## First\n\nBody\n";
  const represented = representNativeTableOfContentsFromRemote(local, remote);
  assert.match(represented, /gdms:generated-toc:start/);
  assert.ok(represented.indexOf("gdms:generated-toc:start") < represented.indexOf("## First"));
});

test("recreates a leading native TOC when the first heading changed locally", () => {
  const local = "# Renamed locally\n\nBody\n";
  const remote = "# \n\n[Old](#old)\n\n# \n\n# Old\n\nBody\n";
  const represented = representNativeTableOfContentsFromRemote(local, remote);
  assert.ok(represented.indexOf(GENERATED_TOC_START) < represented.indexOf("# Renamed locally"));
});

test("rejects malformed generated TOC markers", () => {
  assert.throws(
    () => refreshGeneratedTableOfContents(`${GENERATED_TOC_START}\ncontent`),
    /only one GDMS marker/,
  );
});
