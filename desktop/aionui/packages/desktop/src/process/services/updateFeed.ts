/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GithubOptions } from 'builder-util-runtime';

export const THOR_RELEASE_REPOSITORY = 'bitboom/thor';

export function buildReleaseFeedOptions(): GithubOptions {
  return {
    provider: 'github',
    owner: 'bitboom',
    repo: 'thor',
    private: false,
    releaseType: 'release',
  };
}
