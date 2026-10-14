import { open, lstat, constants } from 'node:fs/promises';
import { extname } from 'node:path';

const limit = 64 * 1024 * 1024;
const extensions = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
export class DocumentPreviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function previewFailure(status) {
  if (status === 400 || status === 422) return '此文档无法预览，可能已加密、损坏或内容与格式不匹配。可以下载原文件查看。';
  if (status === 413) return '文档超过 64 MB 预览上限，可以下载原文件查看。';
  if ([429, 503, 504].includes(status)) return '文档预览暂时繁忙或转换超时，请稍后重试；也可以下载原文件。';
  return '暂时无法生成文档预览，请重试；也可以下载原文件。';
}
async function inputBytes(path) {
  // O_NOFOLLOW is unavailable on Windows. Keep the atomic POSIX protection,
  // and also check pathname/handle identity before reading on every platform.
  const original = await lstat(path);
  if (original.isSymbolicLink() || !original.isFile()) throw new DocumentPreviewError(400, '不支持符号链接或非普通文件的预览。');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino || original.dev !== info.dev || original.ino !== info.ino) {
      throw new DocumentPreviewError(400, '预览文件已改变，请重试。');
    }
    if (!info.isFile() || info.size > limit) throw new DocumentPreviewError(413, previewFailure(413));
    const chunks = []; let count = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(256 * 1024), { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      count += bytesRead; if (count > limit) throw new DocumentPreviewError(413, previewFailure(413));
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}
function validSignature(bytes, extension) {
  const ole = bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const zip = bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  if (['.docx', '.xlsx', '.pptx'].includes(extension)) return zip || ole; // encrypted OOXML uses OLE
  return ole || (extension === '.doc' && bytes.subarray(0, 5).toString() === '{\\rtf');
}
export async function convertOffice(path, baseUrl, request = fetch) {
  const extension = extname(path).toLowerCase();
  if (!extensions.has(extension)) throw new DocumentPreviewError(400, '此格式不支持办公文档预览，可以下载原文件。');
  // Only the dedicated private renderer; never accept a user-supplied URL.
  if (!/^http:\/\/(?:agent-lab|selfme-lab)-document-preview-[a-f0-9]{16}:3000$/.test(baseUrl ?? '')) throw new DocumentPreviewError(503, '办公文档预览组件未就绪，请更新并重启远端服务；原文件仍可下载。');
  const bytes = await inputBytes(path);
  if (!validSignature(bytes, extension)) throw new DocumentPreviewError(400, previewFailure(400));
  const form = new FormData();
  form.set('files', new Blob([bytes]), 'document' + extension);
  form.set('updateIndexes', 'false'); form.set('exportFormFields', 'false');
  let response;
  try { response = await request(baseUrl + '/forms/libreoffice/convert', { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(65_000) }); }
  catch { throw new DocumentPreviewError(503, previewFailure(503)); }
  if (!response.ok) { await response.body?.cancel(); throw new DocumentPreviewError(response.status >= 500 ? 503 : response.status, previewFailure(response.status)); }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/pdf') || !response.body) {
    await response.body?.cancel(); throw new DocumentPreviewError(502, previewFailure(502));
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new DocumentPreviewError(413, '生成的预览超过 64 MB，请下载原文件查看。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const pdf = Buffer.concat(chunks);
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new DocumentPreviewError(502, previewFailure(502));
  return pdf;
}
