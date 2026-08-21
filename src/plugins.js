'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function installedDesktopPlugins(profileRoot) {
  const extensionsPath = path.join(profileRoot, 'extensions.json');
  try {
    const manifest = JSON.parse(await fs.readFile(extensionsPath, 'utf8'));
    return manifest.addons.map(addon => ({
      id: addon.id,
      name: addon.defaultLocale?.name || addon.id,
      description: addon.defaultLocale?.description || '',
      version: addon.version,
      active: Boolean(addon.active && !addon.appDisabled),
      installPath: addon.path || '',
      compatibility: {
        minVersion: addon.targetApplications?.[0]?.minVersion || null,
        maxVersion: addon.targetApplications?.[0]?.maxVersion || null
      }
    })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

module.exports = { installedDesktopPlugins };
