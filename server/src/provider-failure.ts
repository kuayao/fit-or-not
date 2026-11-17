import { z } from 'zod';

const errorSchema = z.object({ code: z.string().optional(), message: z.string().optional() });

export function providerFailure(error: unknown): { name: string; code?: string; notSent: boolean } {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  if (cause instanceof AggregateError) {
    const failures = z.array(z.unknown()).parse(cause.errors).map(providerFailure);
    return { name: cause.name, code: failures[0]?.code, notSent: failures.length > 0 && failures.every(failure => failure.notSent) };
  }
  const detail = errorSchema.safeParse(cause);
  const code = detail.success ? detail.data.code : undefined;
  return {
    name: error instanceof Error ? error.name : 'UnknownError', code,
    notSent: Boolean(code && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code)
      || code === 'ECONNRESET' && detail.success && detail.data.message?.includes('before secure TLS connection was established'))
  };
}
