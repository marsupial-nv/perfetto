// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// A theme for this page load only. It wins over the user's 'theme' setting
// without changing it, so a page that embeds or opens the UI (?theme=dark, or
// the RemoteControl plugin) can match its own look and leave the user's own
// preference for the UI alone.

export type UiTheme = 'dark' | 'light';

let override: UiTheme | undefined;

export function setThemeOverride(theme: UiTheme | undefined): void {
  override = theme;
}

export function getThemeOverride(): UiTheme | undefined {
  return override;
}
