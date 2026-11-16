export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export function notFound(): never {
  throw new HttpError(404, 'RESOURCE_NOT_FOUND', '资源不存在或不可访问');
}
export function versionConflict(): never {
  throw new HttpError(409, 'VERSION_CONFLICT', '内容已在其他位置修改，请重新加载后再保存');
}
