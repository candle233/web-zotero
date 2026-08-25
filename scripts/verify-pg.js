'use strict';

const { PgWebStore } = require('../src/web-store-pg');
const { PgWebAnnotationStore } = require('../src/annotations-store-pg');
const { PgUserStore } = require('../src/users-pg');
const { HealthMonitor } = require('../src/health');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

async function main() {
  if (!DATABASE_URL) {
    console.log('DATABASE_URL not set; skipping verification.');
    return;
  }
  console.log('Testing PG stores against database...');
  const webStore = new PgWebStore(DATABASE_URL);
  const annotationStore = new PgWebAnnotationStore(DATABASE_URL);
  const userStore = new PgUserStore(DATABASE_URL);

  const monitor = new HealthMonitor({
    zoteroDatabase: { database: { prepare: () => ({ get: () => 1 }) }, items: [] },
    searchIndex: { status: () => ({ indexed: 10 }) },
    webStore,
    userStore,
    annotationStore
  });

  const health = await monitor.status();
  console.log('Health status:', health.ok, health.dependencies);

  // Test note save + version
  const testKey = 'PG_VERIFY_' + Date.now();
  const n1 = await webStore.saveNote(testKey, 'Verifying PG note content', '<p>Verifying PG note content</p>');
  console.log('Note v1 saved:', n1);
  const n2 = await webStore.saveNote(testKey, 'Updated PG note content', '<p>Updated PG note content</p>', 1);
  console.log('Note v2 saved:', n2);

  // Test progress
  const prog = await webStore.saveProgress(testKey, 88.8);
  console.log('Progress saved:', prog);

  // Test formula
  const form = await webStore.saveFormula('E = mc^2', testKey);
  console.log('Formula saved:', form);

  // Test annotation
  const ann = await annotationStore.create({
    itemKey: testKey,
    attachmentKey: 'ATT_VERIFY',
    pageIndex: 1,
    type: 'highlight',
    rects: [{ x: 0.2, y: 0.3, width: 0.4, height: 0.05 }],
    color: '#00ff00',
    comment: 'PG annotation test'
  });
  console.log('Annotation created:', ann);

  // Verify directly in PG via raw query
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const dbNote = await client.query('SELECT * FROM web_notes WHERE item_key = $1', [testKey]);
  const dbVersions = await client.query('SELECT * FROM note_versions WHERE item_key = $1', [testKey]);
  const dbProg = await client.query('SELECT * FROM reading_progress_web WHERE item_key = $1', [testKey]);
  const dbForm = await client.query('SELECT * FROM formula_history WHERE id = $1', [form.id]);
  const dbAnn = await client.query('SELECT * FROM web_annotations WHERE id = $1', [ann.id]);

  console.log('DB web_notes row count:', dbNote.rows.length);
  console.log('DB note_versions row count:', dbVersions.rows.length);
  console.log('DB reading_progress_web row count:', dbProg.rows.length);
  console.log('DB formula_history row count:', dbForm.rows.length);
  console.log('DB web_annotations row count:', dbAnn.rows.length);

  // Clean up
  await webStore.deleteNote(testKey);
  await webStore.deleteFormula(form.id);
  await annotationStore.remove(ann.id);
  await client.query('DELETE FROM reading_progress_web WHERE item_key = $1', [testKey]);
  await client.end();

  await webStore.close();
  await annotationStore.close();
  await userStore.close();

  console.log('PG verification completed successfully!');
}

main().catch(err => {
  console.error('PG verification failed:', err);
  process.exit(1);
});
