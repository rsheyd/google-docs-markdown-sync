/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** GDMS Workspaces Root - Folder containing the local workspaces GDMS should search */
  "workspaceRoot": string,
  /** Sync Service Root - Folder containing this project's src/cli.js */
  "serviceRoot": string,
  /** Google OAuth Client JSON - OAuth desktop client JSON stored outside Git */
  "oauthClientPath": string,
  /** Node Executable Override - Optional absolute path to Node.js; leave blank to use Raycast's Node runtime */
  "nodePath"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `pair-google-doc` command */
  export type PairGoogleDoc = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `pair-google-doc` command */
  export type PairGoogleDoc = {}
}
