'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { installedDesktopPlugins } = require('../src/plugins');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wz-plugins-'));
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

async function writeExtensionsJson(profileRoot, manifest) {
  const profileDir = profileRoot;
  await fsp.mkdir(profileDir, { recursive: true });
  const target = path.join(profileDir, "extensions.json");
  await fsp.writeFile(target, JSON.stringify(manifest), 'utf8');
  return target;
}

const sampleManifest = {
  addons: [
    {
      id: 'addon1@zotero.org',
      version: '1.0.0',
      active: true,
      path: '/Applications/Zotero.app/Contents/Resources/extensions/addon1',
      defaultLocale: { name: 'Better BibTeX', description: 'Cite-as-you-write' },
      targetApplications: [{ id: 'zotero@chnm.gmu.edu', minVersion: '5.0', maxVersion: '6.*' }]
    },
    {
      id: 'addon2@zotero.org',
      version: '2.3.4',
      active: false,
      appDisabled: false,
      path: '/extensions/addon2',
      defaultLocale: { name: 'ZotFile', description: 'Rename and attach PDFs' },
      targetApplications: []
    },
    {
      id: 'addon3@example.com',
      version: '0.1.0',
      active: true,
      appDisabled: true,
      defaultLocale: { name: '', description: '' },
      targetApplications: []
    }
  ]
};

test('installedDesktopPlugins returns parsed list sorted by name', async () => {
  const dir = tempDir();
  await writeExtensionsJson(path.join(dir, 'Profiles'), sampleManifest);
  try {
    const plugins = await installedDesktopPlugins(path.join(dir, 'Profiles'));
    assert.equal(plugins.length, 3);
    // The list is sorted by name. The third addon has defaultLocale.name=''
    // so it falls back to its id ('addon3@example.com').
    const names = plugins.map(p => p.name);
    assert.equal(names.includes('addon3@example.com'), true, 'empty name falls back to id');
    assert.equal(names.includes('Better BibTeX'), true);
    assert.equal(names.includes('ZotFile'), true);
    // ZotFile < 'addon3@...' (letters come before '@' numerically for the fallback).
    const idxZF = names.indexOf('ZotFile');
    const idxBT = names.indexOf('Better BibTeX');
    assert.ok(idxZF >= 0 && idxBT >= 0);
    assert.ok(idxBT < idxZF, 'Better BibTeX should come before ZotFile');
  } finally { cleanup(dir); }
});

test('installedDesktopPlugins falls back to id when locale name is missing', async () => {
  const dir = tempDir();
  await writeExtensionsJson(path.join(dir, 'Profiles'), { addons: [
    { id: 'no-name@example.com', version: '1.0', active: true, defaultLocale: {} }
  ]});
  try {
    const plugins = await installedDesktopPlugins(path.join(dir, 'Profiles'));
    assert.equal(plugins[0].name, 'no-name@example.com');
  } finally { cleanup(dir); }
});

test('installedDesktopPlugins reports active=false when appDisabled even if active flag is true', async () => {
  const dir = tempDir();
  await writeExtensionsJson(path.join(dir, 'Profiles'), { addons: [
    { id: 'a@b.c', version: '1.0', active: true, appDisabled: true, defaultLocale: { name: 'X' } }
  ]});
  try {
    const plugins = await installedDesktopPlugins(path.join(dir, 'Profiles'));
    assert.equal(plugins[0].active, false);
  } finally { cleanup(dir); }
});

test('installedDesktopPlugins returns compatibility min/max from targetApplications[0]', async () => {
  const dir = tempDir();
  await writeExtensionsJson(path.join(dir, 'Profiles'), { addons: [
    {
      id: 'a@b.c', version: '1.0', active: true, defaultLocale: { name: 'A' },
      targetApplications: [{ minVersion: '6.0', maxVersion: '7.0' }]
    }
  ]});
  try {
    const plugins = await installedDesktopPlugins(path.join(dir, 'Profiles'));
    assert.equal(plugins[0].compatibility.minVersion, '6.0');
    assert.equal(plugins[0].compatibility.maxVersion, '7.0');
  } finally { cleanup(dir); }
});

test('installedDesktopPlugins returns null compatibility when no targetApplications', async () => {
  const dir = tempDir();
  await writeExtensionsJson(path.join(dir, 'Profiles'), { addons: [
    { id: 'a@b.c', version: '1.0', active: true, defaultLocale: { name: 'A' } }
  ]});
  try {
    const plugins = await installedDesktopPlugins(path.join(dir, 'Profiles'));
    assert.equal(plugins[0].compatibility.minVersion, null);
    assert.equal(plugins[0].compatibility.maxVersion, null);
  } finally { cleanup(dir); }
});

test('installedDesktopPlugins returns empty list when extensions.json does not exist', async () => {
  const dir = tempDir();
  try {
    const plugins = await installedDesktopPlugins(path.join(dir, 'Profiles'));
    assert.deepEqual(plugins, []);
  } finally { cleanup(dir); }
});

test('installedDesktopPlugins returns empty list when JSON is malformed', async () => {
  const dir = tempDir();
  await fsp.writeFile(path.join(dir, 'extensions.json'), '{ this is not json', 'utf8');
  try {
    const plugins = await installedDesktopPlugins(dir);
    assert.deepEqual(plugins, []);
  } finally { cleanup(dir); }
});

test('installedDesktopPlugins returns empty list when manifest has no addons', async () => {
  const dir = tempDir();
  await writeExtensionsJson(path.join(dir, 'Profiles'), { addons: [] });
  try {
    const plugins = await installedDesktopPlugins(path.join(dir, 'Profiles'));
    assert.deepEqual(plugins, []);
  } finally { cleanup(dir); }
});

test('installedDesktopPlugins exposes id, version, and installPath', async () => {
  const dir = tempDir();
  await writeExtensionsJson(path.join(dir, 'Profiles'), { addons: [
    { id: 'a@b.c', version: '3.1.4', active: true, path: '/x/y/z', defaultLocale: { name: 'X' } }
  ]});
  try {
    const plugins = await installedDesktopPlugins(path.join(dir, 'Profiles'));
    assert.equal(plugins[0].id, 'a@b.c');
    assert.equal(plugins[0].version, '3.1.4');
    assert.equal(plugins[0].installPath, '/x/y/z');
  } finally { cleanup(dir); }
});
