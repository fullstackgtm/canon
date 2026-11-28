import { createHmac, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes } from 'node:crypto';
import { evidenceSigner } from './moduleEvidence.ts';
import type { ServiceJwtConfig } from './canonServiceJwt.ts';
import { authBrokerClient, rateLimit, clientIp } from '../app/api/cli/_lib.ts';
import { api } from '../../convex/_generated/api.js';
import { visitHeaders } from './visitHeaders.ts';
import { localHttp } from './visitHttp.ts';
export type FormSubmit = { publicId: string; nonce: string; ipHash: string; userAgent: string; answers: Record<string, unknown>; params: Record<string, unknown> };
export type FormDeps = { env: Record<string,string|undefined>; signer: ServiceJwtConfig | null; available(pid: string): Promise<boolean>; submit(args: FormSubmit): Promise<{status:number; message?:string; redirect?:string}>; limit(request:Request):boolean; now():number };
/** Per-visitor limits need the ingress to name the client. Without that every visitor shares one bucket, so one script could lock every form: forms stay closed, except on the local HTTP stack. */
export const formsReachable = (env: Record<string,string|undefined>) => !!env.CANON_CLIENT_IP_HEADER?.trim() || localHttp(env);
const json = (body: unknown, status: number) => Response.json(body, { status, headers: visitHeaders() });
const missing = () => json({ error: 'Form not found' }, 404);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function renderFormToken(signer: ServiceJwtConfig, pid: string, now = Date.now()) {
  const head = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:signer.kid})).toString('base64url');
  const body = Buffer.from(JSON.stringify({ aud:'canon-form', iss:signer.issuer, pid, iat:Math.floor(now/1000), nonce:randomBytes(16).toString('base64url') })).toString('base64url');
  const input = `${head}.${body}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(createPrivateKey(signer.privateKeyPem)).toString('base64url')}`;
}
function tokenOf(token: string, signer: ServiceJwtConfig, pid: string, now: number): { nonce:string } | null {
  try {
    if (token.length > 4096) return null;
    const [h,b,s,...rest] = token.split('.');
    if (rest.length || !s) return null;
    const header = JSON.parse(Buffer.from(h,'base64url').toString()), claims = JSON.parse(Buffer.from(b,'base64url').toString());
    if (header.alg !== 'RS256' || header.kid !== signer.kid || claims.aud !== 'canon-form' || claims.iss !== signer.issuer || claims.pid !== pid || !Number.isInteger(claims.iat) || now/1000-claims.iat < 3 || now/1000-claims.iat > 86400 || typeof claims.nonce !== 'string' || !/^[\w-]{22}$/.test(claims.nonce)) return null;
    if (!createVerify('RSA-SHA256').update(`${h}.${b}`).verify(createPublicKey(signer.privateKeyPem),Buffer.from(s,'base64url'))) return null;
    return { nonce: claims.nonce };
  } catch { return null; }
}
function defaults(): FormDeps {
  return { env:process.env, signer:evidenceSigner(), available: async publicId => !!await authBrokerClient().query(api.inboundForms.publicForm,{publicId}), submit: args => authBrokerClient().action(api.inboundForms.submit,args), limit:request=>rateLimit(request,'forms:submit',20), now:Date.now };
}
export async function handleFormSubmit(request: Request, deps: FormDeps = defaults()): Promise<Response> {
  try {
    if (!deps.signer || !formsReachable(deps.env) || !deps.env.NEXT_PUBLIC_SITE_URL || request.headers.get('origin') !== deps.env.NEXT_PUBLIC_SITE_URL || request.headers.get('content-type') !== 'application/json') return missing();
    const reader = request.body?.getReader();
    if (!reader) return missing();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) { await reader.cancel(); return missing(); } chunks.push(value); }
    const bytes = new Uint8Array(size); let at=0; for (const c of chunks) { bytes.set(c,at); at+=c.length; }
    const body: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if (!record(body) || Object.keys(body).some(k=>!['publicId','token','answers','params','website'].includes(k)) || typeof body.publicId !== 'string' || !/^[\w-]{22}$/.test(body.publicId) || typeof body.token !== 'string' || !record(body.answers) || Object.keys(body.answers).length > 25 || !record(body.params) || Object.keys(body.params).length > 15 || body.website !== undefined && typeof body.website !== 'string') return missing();
    if (!await deps.available(body.publicId)) return missing();
    if (!deps.limit(request)) return json({error:'Too many requests'},429);
    const token = tokenOf(body.token,deps.signer,body.publicId,deps.now());
    if (!token) return json({error:'Invalid or expired form'},400);
    if (body.website) return json({message:'Thank you. Your submission was received.'},200);
    const ipHash = createHmac('sha256',deps.signer.privateKeyPem).update(`canon-form:${body.publicId}:${clientIp(request)}`).digest('hex');
    const result = await deps.submit({publicId:body.publicId,nonce:token.nonce,ipHash,userAgent:(request.headers.get('user-agent')??'').slice(0,400),answers:body.answers,params:body.params});
    return result.status === 404 ? missing() : json(result.status === 429 ? {error:'Too many requests'} : {message:result.message??'Thank you. Your submission was received.',...(result.redirect ? {redirect:result.redirect}: {})},result.status);
  } catch { return missing(); }
}
