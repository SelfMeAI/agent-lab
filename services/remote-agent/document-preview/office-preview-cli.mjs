import { convertOffice, DocumentPreviewError, previewFailure } from './office-preview.mjs';

// Separate executable so the native OC plugin can synchronously load the
// shared ESM library. No top-level await is present in its import graph.
try { process.stdout.write(await convertOffice(process.argv[2], process.env.AGENT_LAB_DOCUMENT_PREVIEW_URL)); }
catch (error) {
  process.stderr.write(JSON.stringify({ status: error instanceof DocumentPreviewError ? error.status : 500, message: error instanceof DocumentPreviewError ? error.message : previewFailure(500) }));
  process.exitCode = 1;
}
