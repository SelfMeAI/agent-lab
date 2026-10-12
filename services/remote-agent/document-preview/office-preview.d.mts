export class DocumentPreviewError extends Error { readonly status: number; constructor(status: number, message: string); }
export function previewFailure(status: number): string;
export function convertOffice(path: string, baseUrl: string | undefined, request?: typeof fetch): Promise<Buffer>;
