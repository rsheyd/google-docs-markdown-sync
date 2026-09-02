import {
  Action,
  ActionPanel,
  Form,
  Icon,
  List,
  LocalStorage,
  Toast,
  getFrontmostApplication,
  popToRoot,
  showToast,
  useNavigation,
} from "@raycast/api";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { useEffect, useMemo, useState } from "react";

const executeFile = promisify(execFile);
const SYNC_LOCATIONS_KEY = "sync-locations";
const DEFAULT_SYNC_LOCATION = path.join(os.homedir(), "dev");
const RUNTIME_CONFIG_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "google-docs-markdown-sync",
  "runtime.json",
);
const SKIPPED = new Set([
  ".git",
  ".cache",
  ".next",
  "build",
  "dist",
  "node_modules",
  "vendor",
]);

type ActiveResource = {
  type: "document" | "spreadsheet";
  url: string;
  title: string;
};

type RuntimeConfig = {
  version: 1;
  cliPath: string;
  nodePath: string;
  oauthClientPath: string;
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

async function loadSyncLocations(): Promise<string[]> {
  const stored = await LocalStorage.getItem<string>(SYNC_LOCATIONS_KEY);
  if (stored !== undefined) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Replace malformed local state with the default below.
    }
  }
  await LocalStorage.setItem(SYNC_LOCATIONS_KEY, JSON.stringify([DEFAULT_SYNC_LOCATION]));
  return [DEFAULT_SYNC_LOCATION];
}

async function saveSyncLocations(locations: string[]) {
  await LocalStorage.setItem(SYNC_LOCATIONS_KEY, JSON.stringify(locations));
}

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const config = JSON.parse(await fs.readFile(RUNTIME_CONFIG_PATH, "utf8"));
    if (
      config?.version === 1 &&
      typeof config.cliPath === "string" &&
      typeof config.nodePath === "string" &&
      typeof config.oauthClientPath === "string"
    ) {
      return config;
    }
  } catch {
    // Report one actionable setup error below.
  }
  throw new Error("GDMS setup is incomplete. Run `gdms install-service`, then try again.");
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
  directory = "",
}: {
  resource: ActiveResource;
  workspace: string;
  directory?: string;
}) {
  const [localPathError, setLocalPathError] = useState<string>();

  async function submit(values: { localPath: string }) {
    const localPath = values.localPath.trim();
    const invalid = !localPath || path.isAbsolute(localPath) || localPath.split(path.sep).includes("..");
    if (invalid || (resource.type === "document" && !localPath.endsWith(".md"))) {
      setLocalPathError(
        resource.type === "document"
          ? "Use a relative filename ending in .md"
          : "Use a relative directory inside the sync location",
      );
      return;
    }
    const isSheet = resource.type === "spreadsheet";
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Pairing Google ${isSheet ? "Sheet" : "Doc"}…`,
    });
    try {
      const runtime = await loadRuntimeConfig();
      await executeFile(
        runtime.nodePath,
        [
          runtime.cliPath,
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
            GOOGLE_DOCS_SYNC_OAUTH_CLIENT: runtime.oauthClientPath,
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
      <Form.Description title="Sync Location" text={workspace} />
      <Form.TextField
        id="localPath"
        title={resource.type === "spreadsheet" ? "CSV Directory" : "Markdown File"}
        defaultValue={
          path.join(
            directory,
            resource.type === "spreadsheet"
              ? suggestedDirectory(resource.title)
              : suggestedFilename(resource.title),
          )
        }
        error={localPathError}
        onChange={() => setLocalPathError(undefined)}
      />
    </Form>
  );
}

function BrowseSyncLocation({
  resource,
  workspace,
  directory = "",
}: {
  resource: ActiveResource;
  workspace: string;
  directory?: string;
}) {
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const absoluteDirectory = path.join(workspace, directory);

  useEffect(() => {
    setLoading(true);
    fs.readdir(absoluteDirectory, { withFileTypes: true })
      .then((entries) =>
        setFolders(
          entries
            .filter(
              (entry) =>
                entry.isDirectory() &&
                !entry.name.startsWith(".") &&
                !SKIPPED.has(entry.name),
            )
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b)),
        ),
      )
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, [absoluteDirectory]);

  return (
    <List
      isLoading={loading}
      navigationTitle={directory || path.basename(workspace)}
      searchBarPlaceholder="Browse folders…"
    >
      {error ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Could not read this folder"
          description={error}
        />
      ) : (
        <>
          <List.Item
            icon={Icon.CheckCircle}
            title={directory ? `Use ${path.basename(directory)}` : `Use ${path.basename(workspace)}`}
            subtitle={absoluteDirectory}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Choose This Folder"
                  icon={Icon.CheckCircle}
                  target={
                    <PairForm
                      resource={resource}
                      workspace={workspace}
                      directory={directory}
                    />
                  }
                />
              </ActionPanel>
            }
          />
          {folders.map((folder) => {
            const childDirectory = path.join(directory, folder);
            return (
              <List.Item
                key={folder}
                icon={Icon.Folder}
                title={folder}
                actions={
                  <ActionPanel>
                    <Action.Push
                      title="Open Folder"
                      icon={Icon.ArrowRight}
                      target={
                        <BrowseSyncLocation
                          resource={resource}
                          workspace={workspace}
                          directory={childDirectory}
                        />
                      }
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </>
      )}
    </List>
  );
}

function AddSyncLocations({
  onAdd,
}: {
  onAdd: (locations: string[]) => Promise<void>;
}) {
  const { pop } = useNavigation();
  const [error, setError] = useState<string>();

  async function submit(values: { locations: string[] }) {
    if (!values.locations.length) {
      setError("Choose at least one folder.");
      return;
    }
    await onAdd(values.locations);
    pop();
  }

  return (
    <Form
      navigationTitle="Add Sync Locations"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Sync Locations" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="locations"
        title="Sync Locations"
        allowMultipleSelection
        canChooseDirectories
        canChooseFiles={false}
        error={error}
        onChange={() => setError(undefined)}
      />
      <Form.Description text="Choose project folders, document archives, or both. Every location supports the same lazy folder browsing and synchronization behavior." />
    </Form>
  );
}

export default function PairGoogleDoc() {
  const [resource, setResource] = useState<ActiveResource>();
  const [locations, setLocations] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([activeBrowserResource(), loadSyncLocations()])
      .then(([activeResource, savedLocations]) => {
        setResource(activeResource);
        setLocations(savedLocations);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, []);

  const items = useMemo(
    () =>
      locations.map((location) => ({ location, title: path.basename(location) })),
    [locations],
  );

  async function addLocations(nextLocations: string[]) {
    const merged = [
      ...new Set([...locations, ...nextLocations.map((location) => path.resolve(location))]),
    ];
    setLocations(merged);
    await saveSyncLocations(merged);
  }

  async function removeLocation(location: string) {
    const next = locations.filter((candidate) => candidate !== location);
    setLocations(next);
    await saveSyncLocations(next);
  }

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
    <List isLoading={loading} searchBarPlaceholder="Search sync locations…">
      {resource && items.length > 0 && (
        <List.Section title="Sync Locations">
          {items.map(({ location, title }) => (
            <List.Item
              key={location}
              icon={Icon.Folder}
              title={title}
              subtitle={location}
              actions={
                <ActionPanel>
                  <Action.Push
                    title="Browse Sync Location"
                    icon={Icon.ArrowRight}
                    target={<BrowseSyncLocation resource={resource} workspace={location} />}
                  />
                  <Action.Push
                    title="Add Sync Locations"
                    icon={Icon.Plus}
                    target={<AddSyncLocations onAdd={addLocations} />}
                  />
                  <Action
                    title="Remove Sync Location"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={() => removeLocation(location)}
                  />
                </ActionPanel>
              }
            />
          ))}
          <List.Item
            icon={Icon.Plus}
            title="Add Sync Location…"
            actions={
              <ActionPanel>
                <Action.Push
                  title="Add Sync Locations"
                  icon={Icon.Plus}
                  target={<AddSyncLocations onAdd={addLocations} />}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      {resource && items.length === 0 && (
        <List.EmptyView
          icon={Icon.Folder}
          title="No Sync Locations"
          description="Add a project folder or document archive."
          actions={
            <ActionPanel>
              <Action.Push
                title="Add Sync Locations"
                icon={Icon.Plus}
                target={<AddSyncLocations onAdd={addLocations} />}
              />
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}
