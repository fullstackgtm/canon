'use client';
import { useEffect, useState } from 'react';
import type { FormField } from '../../../../modules/kernel/inboundForms';
export function HostedForm({fields,publicId,token,params}:{fields:FormField[];publicId:string;token:string;params:Record<string,string>}) {
  const [ready,setReady] = useState(false);
  useEffect(()=>setReady(true),[]);
  const [message,setMessage] = useState(''), [pending,setPending] = useState(false), [done,setDone] = useState(false);
  return done ? <p role="status">{message}</p> : <form method="post" action="/api/forms/submit" className="space-y-4" onSubmit={async event=>{
    event.preventDefault(); if (pending) return; setPending(true); setMessage('');
    const data = new FormData(event.currentTarget), answers = Object.fromEntries(fields.map(f=>[f.key,f.kind==='checkbox' ? data.has(f.key) : String(data.get(f.key)??'')]));
    try { const res = await fetch('/api/forms/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publicId,token,params,answers,website:data.get('website')})}); const result = await res.json(); if (!res.ok) {setMessage('Could not submit. Please wait a moment and try again.'); return;} if (result.redirect) {window.location.assign(result.redirect); return;} setMessage(result.message); setDone(true); } catch {setMessage('Could not submit. Please try again.');} finally {setPending(false);}
  }}>
    {fields.map(f=><label className="block space-y-1" key={f.key}><span>{f.label}{f.required ? ' *' : ''}</span>{f.kind==='select' ? <select name={f.key} required={f.required} className="block w-full rounded border p-2"><option value="">Choose</option>{f.options?.map(o=><option key={o}>{o}</option>)}</select> : f.kind==='textarea' ? <textarea name={f.key} required={f.required} maxLength={2000} className="block w-full rounded border p-2"/> : <input name={f.key} required={f.required} type={f.kind==='phone' ? 'tel' : f.kind==='checkbox' ? 'checkbox' : f.kind==='email' ? 'email' : 'text'} maxLength={200} className={f.kind==='checkbox' ? 'ml-2' : 'block w-full rounded border p-2'}/>}</label>)}
    <div hidden aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off"/></label></div>
    {message && <p role="alert">{message}</p>}<button type="submit" disabled={pending || !ready} className="rounded bg-primary px-4 py-2 text-primary-foreground">{pending ? 'Submitting…' : 'Submit'}</button>
  </form>;
}
