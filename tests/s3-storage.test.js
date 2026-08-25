'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { S3Storage, getSigningKey, sha256Hex, uriEncode } = require('../src/s3-storage');

test('uriEncode encodes special characters according to RFC 3986', () => {
  assert.equal(uriEncode('hello world'), 'hello%20world');
  assert.equal(uriEncode('foo/bar', false), 'foo/bar');
  assert.equal(uriEncode('foo/bar', true), 'foo%2Fbar');
  assert.equal(uriEncode('test-._~'), 'test-._~');
});

test('S3Storage isConfigured reports false when credentials are missing', () => {
  const s3 = new S3Storage({ accessKeyId: '', secretAccessKey: '', bucket: '' });
  assert.equal(s3.isConfigured(), false);
  assert.throws(() => s3.generatePresignedUploadUrl({ fileKey: 'test.pdf' }), err => err.statusCode === 503);
});

test('S3Storage generates deterministic SigV4 presigned PUT URL (path-style)', () => {
  const s3 = new S3Storage({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin123',
    forcePathStyle: true
  });

  const fixedDate = new Date('2026-08-26T12:00:00.000Z');
  const result = s3.generatePresignedUploadUrl({
    fileKey: 'attachments/ITEM1/ATT1-paper.pdf',
    contentType: 'application/pdf',
    expiresIn: 600,
    now: fixedDate
  });

  assert.equal(result.method, 'PUT');
  assert.equal(result.fileKey, 'attachments/ITEM1/ATT1-paper.pdf');
  assert.equal(result.expiresIn, 600);
  assert.equal(result.headers['content-type'], 'application/pdf');

  const parsedUrl = new URL(result.uploadUrl);
  assert.equal(parsedUrl.origin, 'http://127.0.0.1:9000');
  assert.equal(parsedUrl.pathname, '/test-bucket/attachments/ITEM1/ATT1-paper.pdf');
  assert.equal(parsedUrl.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(parsedUrl.searchParams.get('X-Amz-Credential'), 'minioadmin/20260826/us-east-1/s3/aws4_request');
  assert.equal(parsedUrl.searchParams.get('X-Amz-Date'), '20260826T120000Z');
  assert.equal(parsedUrl.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(parsedUrl.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.ok(parsedUrl.searchParams.get('X-Amz-Signature').length === 64);
});

test('S3Storage generates virtual-host style presigned URLs when forcePathStyle is false', () => {
  const s3 = new S3Storage({
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    bucket: 'my-zotero-bucket',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    forcePathStyle: false
  });

  const fixedDate = new Date('2026-08-26T12:00:00.000Z');
  const result = s3.generatePresignedUploadUrl({
    fileKey: 'attachments/ITEM2/doc.pdf',
    contentType: 'application/pdf',
    now: fixedDate
  });

  const parsedUrl = new URL(result.uploadUrl);
  assert.equal(parsedUrl.host, 'my-zotero-bucket.s3.us-east-1.amazonaws.com');
  assert.equal(parsedUrl.pathname, '/attachments/ITEM2/doc.pdf');
  assert.ok(parsedUrl.searchParams.has('X-Amz-Signature'));
});

test('S3Storage generates sanitized hierarchical file keys', () => {
  const s3 = new S3Storage();
  const fileKey = s3.generateFileKey('ITEM_123', 'ATT_456', 'My Research Paper (2026).pdf');
  assert.equal(fileKey, 'attachments/ITEM_123/ATT_456-My_Research_Paper__2026_.pdf');
});
