import {
  Action,
  ActionPanel,
  Form,
  Icon,
  List,
  Toast,
  getFrontmostApplication,
  getPreferenceValues,
  popToRoot,
  showToast,
} from "@raycast/api";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { useEffect, useMemo, useState } from "react";

const executeFile = promisify(execFile);
const SKIPPED = new Set([
  ".git",
  ".cache",
  ".next",
  "build",
  "dist",
  "node_modules",
  "vendor",
]);

type Preferences = {
  workspaceRoot: string;
  serviceRoot: string;
  oauthClientPath: string;
  nodePath?: string;
};

type ActiveResource = {
  type: "document" | "spreadsheet";
  url: string;
  title: string;
};

const CHROMIUM_BROWSERS = new Map([
  ["com.google.Chrome", "Google Chrome"],
  ["com.google.Chrome.beta", "Google Chrome Beta"],
  ["org.chromium.Chromium", "Chromium"],
  ["com.brave.Browser", "Brave Browser"],
  ["com.microsoft.edgemac", "Microsoft Edge"],
]);

async function activeBrowserResource(): Promise<ActiveResource> {
  const bundleId = (await getFrontmostApplication()).bundleId ?? "";
  const chromiumName = CHROMIUM_BROWSERS.get(bundleId);
  const browserName = bundleId === "com.apple.Safari" ? "Safari" : chromiumName;
  if (!browserName) {
    throw new Error(
      "Open this command from Safari, Chrome, Chromium, Brave, or Microsoft Edge.",
    );
  }
  const script = bundleId === "com.apple.Safari" ? [
    'tell application "Safari"',
    'if (count of windows) is 0 then error "Safari has no open windows."',
    "set activeURL to URL of current tab of front window",
    "set activeTitle to name of current tab of front window",
    "return activeURL & linefeed & activeTitle",
    "end tell",
  ] : [
    `tell application "${chromiumName}"`,
    `if (count of windows) is 0 then error "${chromiumName} has no open windows."`,
    "set activeURL to URL of active tab of front window",
    "set activeTitle to title of active tab of front window",
    "return activeURL & linefeed & activeTitle",
    "end tell",
  ];
  const argumentsList = script.flatMap((line) => ["-e", line]);
  const { stdout } = await executeFile("/usr/bin/osascript", argumentsList);
  const [url, ...titleLines] = stdout.trim().split("\n");
  const type = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\//.test(url)
    ? "document"
    : /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\//.test(url)
      ? "spreadsheet"
      : undefined;
  if (!type) {
    throw new Error(`${browserName}'s active tab is not a Google Doc or Sheet.`);
  }
  const title = titleLines
    .join(" ")
    .replace(type === "document" ? / - Google Docs$/ : / - Google (?:Drive|Sheets)$/, "");
  return { type, url, title };
}

async function collectFolders(root: string): Promise<string[]> {
  const folders: string[] = [];
  async function visit(directory: string, depth: number) {
    if (depth > 5) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        SKIPPED.has(entry.name)
      ) {
        continue;
      }
      const child = path.join(directory, entry.name);
      folders.push(child);
      await visit(child, depth + 1);
    }
  }
  folders.push(root);
  await visit(root, 0);
  return folders;
}

function suggestedFilename(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/\s+-\s+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[/:\\\u0000-\u001f]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "google-doc"}.md`;
}

function suggestedDirectory(title: string) {
  return suggestedFilename(title).replace(/\.md$/, "");
}

function commandErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String(error.stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

function PairForm({
  resource,
  workspace,
}: {
  resource: ActiveResource;
  workspace: string;
}) {
  const preferences = getPreferenceValues<Preferences>();
  const [localPathError, setLocalPathError] = useState<string>();

  async function submit(values: { localPath: string }) {
    const localPath = values.localPath.trim();
    const invalid = !localPath || path.isAbsolute(localPath) || localPath.split(path.sep).includes("..");
    if (invalid || (resource.type === "document" && !localPath.endsWith(".md"))) {
      setLocalPathError(
        resource.type === "document"
          ? "Use a relative filename ending in .md"
          : "Use a relative directory inside the workspace",
      );
      return;
    }
    const isSheet = resource.type === "spreadsheet";
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Pairing Google ${isSheet ? "Sheet" : "Doc"}…`,
    });
    try {
      await executeFile(
        preferences.nodePath?.trim() || process.execPath,
        [
          path.join(preferences.serviceRoot, "src", "cli.js"),
          isSheet ? "pair-sheet" : "pair",
          "--url",
          resource.url,
          "--workspace",
          workspace,
          isSheet ? "--directory" : "--file",
          localPath,
          "--name",
          resource.title,
        ],
        {
          env: {
            ...process.env,
            GOOGLE_DOCS_SYNC_OAUTH_CLIENT: preferences.oauthClientPath,
          },
        },
      );
      toast.style = Toast.Style.Success;
      toast.title = `Google ${isSheet ? "Sheet" : "Doc"} paired`;
      toast.message = path.join(workspace, localPath);
      popToRoot();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Pairing failed";
      toast.message = commandErrorMessage(error);
    }
  }

  return (
    <Form
      navigationTitle={`Pair “${resource.title}”`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Pairing" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title={resource.type === "spreadsheet" ? "Google Sheet" : "Google Doc"}
        text={resource.url}
      />
      <Form.Description title="Workspace" text={workspace} />
      <Form.TextField
        id="localPath"
        title={resource.type === "spreadsheet" ? "CSV Directory" : "Markdown File"}
        defaultValue={
          resource.type === "spreadsheet"
            ? suggestedDirectory(resource.title)
            : suggestedFilename(resource.title)
        }
        error={localPathError}
        onChange={() => setLocalPathError(undefined)}
      />
    </Form>
  );
}

export default function PairGoogleDoc() {
  const preferences = getPreferenceValues<Preferences>();
  const [resource, setResource] = useState<ActiveResource>();
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      activeBrowserResource(),
      collectFolders(preferences.workspaceRoot),
    ])
      .then(([activeResource, discoveredFolders]) => {
        setResource(activeResource);
        setFolders(discoveredFolders);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, [preferences.workspaceRoot]);

  const items = useMemo(
    () =>
      folders.map((folder) => ({
        folder,
        title:
          folder === preferences.workspaceRoot
            ? path.basename(folder)
            : path.relative(preferences.workspaceRoot, folder),
      })),
    [folders, preferences.workspaceRoot],
  );

  if (error) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Could not prepare pairing"
          description={error}
        />
      </List>
    );
  }

  return (
    <List isLoading={loading} searchBarPlaceholder="Search workspace folders…">
      {resource &&
        items.map(({ folder, title }) => (
          <List.Item
            key={folder}
            icon={Icon.Folder}
            title={title}
            subtitle={folder}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Choose Workspace"
                  icon={Icon.ArrowRight}
                  target={<PairForm resource={resource} workspace={folder} />}
                />
              </ActionPanel>
            }
          />
        ))}
    </List>
  );
}
