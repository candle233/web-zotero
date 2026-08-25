'use strict';

/**
 * Lightweight zero-dependency S3 / MinIO / Cloudflare R2 Presigned Direct Uploads (R7b/R8).
 *
 * Implements AWS Signature Version 4 (SigV4) for presigned PUT URLs using Node.js built-in `crypto`.
 */

const crypto = require('node:crypto');
const { URL } = require('node:url');

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function getSigningKey(secretKey, dateStamp, region, service = 's3') {
  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function uriEncode(str, encodeSlash = false) {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (
      (char >= 'A' && char <= 'Z') ||
      (char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '_' ||
      char === '-' ||
      char === '~' ||
      char === '.'
    ) {
      result += char;
    } else if (char === '/' && !encodeSlash) {
      result += '/';
    } else {
      const hex = Buffer.from(char).toString('hex').toUpperCase();
      result += '%' + hex;
    }
  }
  return result;
}

class S3Storage {
  constructor(config = {}) {
    this.endpoint = (config.endpoint || process.env.S3_ENDPOINT || 'http://127.0.0.1:9000').replace(/\/+$/, '');
    this.bucket = config.bucket || process.env.S3_BUCKET || 'web-zotero-attachments';
    this.region = config.region || process.env.S3_REGION || 'us-east-1';
    this.accessKeyId = config.accessKeyId || process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
    this.secretAccessKey = config.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
    this.forcePathStyle = config.forcePathStyle !== undefined
      ? Boolean(config.forcePathStyle)
      : (process.env.S3_FORCE_PATH_STYLE !== 'false');
  }

  isConfigured() {
    return Boolean(this.accessKeyId && this.secretAccessKey && this.bucket);
  }

  /**
   * Generates a unique, hierarchical object storage key for an attachment.
   */
  generateFileKey(itemKey, attachmentKey, filename = 'document.pdf') {
    const safeItem = String(itemKey || 'global').replace(/[^a-zA-Z0-9_-]/g, '');
    const safeAtt = String(attachmentKey || crypto.randomBytes(4).toString('hex').toUpperCase()).replace(/[^a-zA-Z0-9_-]/g, '');
    const safeName = String(filename || 'file.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    return `attachments/${safeItem}/${safeAtt}-${safeName}`;
  }

  /**
   * Creates a SigV4 presigned PUT URL for browser direct uploads.
   *
   * @param {Object} options
   * @param {string} options.fileKey - Object key in bucket
   * @param {string} [options.contentType] - MIME type (e.g. 'application/pdf')
   * @param {number} [options.expiresIn=900] - Expiration in seconds (default 15 minutes)
   * @param {Date} [options.now=new Date()] - Override timestamp for deterministic testing
   * @returns {{ uploadUrl: string, fileKey: string, method: string, headers: Object, expiresIn: number }}
   */
  generatePresignedUploadUrl({ fileKey, contentType = 'application/pdf', expiresIn = 900, now = new Date() }) {
    if (!this.isConfigured()) {
      throw Object.assign(new Error('S3 storage is not configured (missing credentials or bucket).'), { statusCode: 503 });
    }

    const isoDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // e.g. 20260826T000000Z
    const dateStamp = isoDate.slice(0, 8); // e.g. 20260826

    const endpointUrl = new URL(this.endpoint);
    let host = endpointUrl.host;
    let canonicalUri = '';

    if (this.forcePathStyle) {
      canonicalUri = `/${this.bucket}/${fileKey.replace(/^\/+/, '')}`;
    } else {
      host = `${this.bucket}.${endpointUrl.host}`;
      canonicalUri = `/${fileKey.replace(/^\/+/, '')}`;
    }

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;

    const queryParams = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': isoDate,
      'X-Amz-Expires': String(Math.min(604800, Math.max(1, Number(expiresIn) || 900))),
      'X-Amz-SignedHeaders': 'host'
    };

    // Sort query params alphabetically
    const canonicalQueryString = Object.keys(queryParams)
      .sort()
      .map(key => `${uriEncode(key, true)}=${uriEncode(queryParams[key], true)}`)
      .join('&');

    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = [
      'PUT',
      uriEncode(canonicalUri, false),
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      isoDate,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join('\n');

    const signingKey = getSigningKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = hmacSha256(signingKey, stringToSign).toString('hex');

    const protocol = endpointUrl.protocol;
    const finalUrl = `${protocol}//${host}${uriEncode(canonicalUri, false)}?${canonicalQueryString}&X-Amz-Signature=${signature}`;

    return {
      uploadUrl: finalUrl,
      fileKey,
      method: 'PUT',
      headers: {
        'content-type': contentType
      },
      expiresIn: Number(queryParams['X-Amz-Expires'])
    };
  }
}

module.exports = { S3Storage, getSigningKey, hmacSha256, sha256Hex, uriEncode };
