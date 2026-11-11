// @ts-check
'use strict'

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const crypto = require('crypto')

const s3 = new S3Client({ region: process.env.AWS_REGION })

function bucket() {
  return process.env.S3_DOCUMENTS_BUCKET
}

async function uploadDocument(businessId, buffer, filename, contentType) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  const key = `${businessId}/${hash}/${filename}`

  await s3.send(new PutObjectCommand({
    Bucket:      bucket(),
    Key:         key,
    Body:        buffer,
    ContentType: contentType
  }))

  return { key, hash }
}

async function getDocument(key) {
  const { Body } = await s3.send(new GetObjectCommand({
    Bucket: bucket(),
    Key:    key
  }))
  return Buffer.from(await Body.transformToByteArray())
}

// A small file the browser fetches straight from S3 (demo inbox attachments).
async function putFile(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buffer, ContentType: contentType }))
}

/** A short-lived link to read one object; disposition makes it open or download. */
async function signedGetUrl(key, { contentType, disposition, expiresIn = 300 } = {}) {
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket(), Key: key,
    ...(contentType ? { ResponseContentType: contentType } : {}),
    ...(disposition ? { ResponseContentDisposition: disposition } : {})
  }), { expiresIn })
}

// Remove one object (a session's reference photo when the session ends).
async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}

module.exports = { uploadDocument, getDocument, putFile, signedGetUrl, deleteFile }
