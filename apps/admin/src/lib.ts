export { account, db, storage, teams, client, DB_ID, ID, Query, Permission, Role, listAll } from '@snpos/core';
export { applyTheme } from '@snpos/ui';

import { applyTheme } from '@snpos/ui';
import type { Settings } from '@snpos/core';

export const applyThemeSettings = (s: Settings) =>
  applyTheme({ primary_color: s.primary_color, secondary_color: s.secondary_color, accent_color: s.accent_color });

export { humanError } from '@snpos/core';
