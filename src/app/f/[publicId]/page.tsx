import { notFound } from 'next/navigation';
import { authBrokerClient } from '../../api/cli/_lib';
import { api } from '../../../../convex/_generated/api';
import { evidenceSigner } from '../../../lib/moduleEvidence';
import { formsReachable, renderFormToken } from '../../../lib/formHttp';
import { HostedForm } from './public-form';
export const dynamic = 'force-dynamic';
export default async function FormPage({ params, searchParams }: { params:Promise<{publicId:string}>; searchParams:Promise<Record<string,string|string[]|undefined>> }) {
  const {publicId} = await params, signer = evidenceSigner();
  if (!signer || !formsReachable(process.env) || !/^[\w-]{22}$/.test(publicId)) notFound();
  const form = await authBrokerClient().query(api.inboundForms.publicForm,{publicId}).catch(()=>null);
  if (!form) notFound();
  const query = await searchParams;
  const hidden = Object.fromEntries(['utm_source','utm_medium','utm_campaign','utm_term','utm_content',...form.hiddenParams].flatMap(k=>typeof query[k] === 'string' ? [[k,(query[k] as string).slice(0,200)]] : []));
  return <main className="mx-auto max-w-xl p-6"><h1 className="mb-6 text-2xl font-semibold">{form.name}</h1><HostedForm fields={form.fields} publicId={publicId} token={renderFormToken(signer,publicId)} params={hidden}/></main>;
}
