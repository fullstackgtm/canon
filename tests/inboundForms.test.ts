import assert from 'node:assert/strict';
import test from 'node:test';
import '../modules/examples/inbound/__tests__/forms.test.ts';
const form: import("../modules/kernel/inboundForms.ts").InboundForm = { name: 'Contact us', fields: [{ key: 'email', label: 'Email', kind: 'email', required: true, mapsTo: 'email' }, { key: 'note', label: 'Message', kind: 'textarea' }, { key: 'consent', label: 'Consent', kind: 'checkbox', required: true }], hiddenParams: [] };


import { readFileSync } from 'node:fs';
import { loadConvex, memoryDb } from './convexHandlers.ts';
import { generateKeyPairSync } from 'node:crypto';
import { handleFormSubmit, renderFormToken, type FormDeps } from '../src/lib/formHttp.ts';
import { isPersonFact } from '../convex/lib/canon/personHold.ts';
const manifest = JSON.parse(readFileSync('modules/examples/inbound/module.json','utf8'));
let agent: string | null = null;
let demo = true;
const graph = loadConvex(['inboundForms.ts','modules.ts','objects.ts'], {
  'lib.ts': real => ({...real, isDevAuthBypassEnabled:()=>demo, getCurrentUser:async (ctx:any)=>ctx.db.get("publisher"), requireUser:async (ctx:any)=>ctx.db.get("publisher"), agentClientOf:async()=>agent}),
});
const inbound = graph['inboundForms.ts'];
function fixture() {
  const publicId='abcdefghijklmnopqrstuv';
  const db=memoryDb({
    organizations:[{_id:'org-a',name:'A'},{_id:'org-b',name:'B'}],
    users:[{_id:'publisher',orgId:'org-a',role:'admin',isActive:true,name:'Publisher'}],
    orgMemberships:[{_id:'membership',orgId:'org-a',userId:'publisher',role:'admin',isActive:true}],
    modulePackages:[{_id:'package',orgId:'org-a',moduleId:manifest.id,slug:'inbound',status:'installed',epoch:1,version:manifest.version,manifest:JSON.stringify(manifest),manifestHash:'hash',source:{kind:'canon',id:'inbound',ref:'0.1.0',sha:'abc'}}],
    recipeEnablements:[{_id:'enabled',orgId:'org-a',point:'module',contributionKey:'nav',recipeId:manifest.id,enabled:true}],
    moduleDocs:[{_id:'form',orgId:'org-a',moduleId:manifest.id,collection:'forms',key:'contact',version:2,createdAt:1,updatedAt:1,data:{...form,status:'live',publicId,publishedBy:'publisher'}}],
    moduleFormLinks:[{_id:'link',orgId:'org-a',moduleId:manifest.id,formKey:'contact',publicId,createdBy:'publisher',createdAt:1}],
  });
  const ctx:any={db,auth:{getUserIdentity:async()=>null},scheduler:{runAfter:async()=>null}};
  const args={publicId,nonce:'unique',ipHash:'hashed',userAgent:'test',answers:{email:'new@example.test',consent:true},params:{utm_source:'campaign'}};
  return {db,ctx,args};
}
test('intake binds the workspace, saves once with provenance, retains UTMs and refuses replay',async()=>{
  const {db,ctx,args}=fixture();
  const admitted=await inbound.admit.handler(ctx,args); assert.equal(admitted.status,202); assert.equal(admitted.orgId,'org-a');
  assert.equal((await inbound.commit.handler(ctx,{...args,version:admitted.version,match:{by:'none',candidates:[]}})).status,200);
  assert.equal(db.rows('canonEntities').length,1);
  assert.equal(db.rows('canonEntities')[0].orgId,'org-a');
  assert.equal(db.rows('ledgerEntries').length, 1);
  const submitted:any=db.rows('moduleDocs').find((r:any)=>r.collection==='submissions')!;
  assert.deepEqual(JSON.parse(submitted.data.utm),{utm_source:'campaign'});
  await inbound.commit.handler(ctx,{...args,version:admitted.version,match:{by:'none',candidates:[]}});
  assert.equal(db.rows('canonEntities').length,1);
  const text=JSON.stringify(db.rows('ledgerEntries'));
  assert.ok(text.includes('intake:@canon/inbound:contact:user:publisher'));
});
test('exact matches link without writes and ambiguous matches wait for review',async()=>{
  for(const match of [{by:'email',leadId:'known-lead',candidates:[]},{by:'email',personId:'known-person',candidates:[]},{by:'ambiguous',candidates:[]}]) {
    const {db,ctx,args}=fixture(); const a=await inbound.admit.handler(ctx,args);
    await inbound.commit.handler(ctx,{...args,version:a.version,match});
    assert.equal(db.rows('canonEntities').length,0);
    const submission:any=db.rows('moduleDocs').find((r:any)=>r.collection==='submissions')!;
    assert.equal(submission.data.outcome,match.by==='ambiguous'?'needs_review':'received');
  }
});
test('durable caps, demoted publishers, fake packages and disabled forms refuse intake',async()=>{
  const {db,ctx,args}=fixture();
  for(let i=0;i<10;i++) assert.equal((await inbound.admit.handler(ctx,{...args,nonce:String(i)})).status,202);
  assert.equal((await inbound.admit.handler(ctx,{...args,nonce:'eleven'})).status,429);
  await db.patch('membership',{role:'manager'}); assert.equal((await inbound.admit.handler(ctx,args)).status,404);
  await db.patch('membership',{role:'admin'}); await db.patch('package',{source:{kind:'canon',id:'fake'}}); assert.equal((await inbound.admit.handler(ctx,args)).status,404);
  await db.patch('package',{source:{kind:'canon',id:'inbound'}}); await db.patch('form',{data:{...form,status:'archived'}}); assert.equal((await inbound.admit.handler(ctx,args)).status,404);
});
test('only a broker can call either public Convex entry',async()=>{
  const {ctx,args}=fixture();
  await assert.rejects(inbound.publicForm.handler(ctx,{publicId:args.publicId}));
  await assert.rejects(inbound.submit.handler(ctx,args));
});
test('intake facts do not hold fields against CRM sync',()=>{
  assert.equal(isPersonFact({sourceKind:'user',sourceRef:'intake:@canon/inbound:form:user:publisher'}),false);
  assert.equal(isPersonFact({sourceKind:'user',sourceRef:'user:publisher'}),true);
});
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const signer={issuer:'https://forms.example.test',kid:'test',privateKeyPem:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString()};
test('HTTP boundary refuses early tokens, foreign origins, unknown keys and oversized streams; honeypot writes nothing',async()=>{
  const now=Date.now(),publicId='abcdefghijklmnopqrstuv'; let writes=0;
  const deps:FormDeps={env:{NEXT_PUBLIC_SITE_URL:'https://forms.example.test'},signer,available:async()=>true,limit:()=>true,now:()=>now,submit:async()=>{writes++;return {status:200};}};
  const body={publicId,token:renderFormToken(signer,publicId,now-4000),answers:{email:'a@example.test'},params:{},website:''};
  const req=(b:unknown,origin='https://forms.example.test')=>new Request('https://forms.example.test/api/forms/submit',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(b)});
  assert.equal((await handleFormSubmit(req({...body,website:'bot'}),deps)).status,200); assert.equal(writes,0);
  assert.equal((await handleFormSubmit(req({...body,token:renderFormToken(signer,publicId,now)}),deps)).status,400);
  for (const request of [req(body,'https://foreign.test'),req({...body,workspace:'other'}),req({...body,answers:{note:'x'.repeat(33000)}})]) assert.equal((await handleFormSubmit(request,deps)).status,404);
  assert.equal((await handleFormSubmit(req(body),deps)).status,200);assert.equal(writes,1);
  deps.available=async()=>false;assert.equal((await handleFormSubmit(req({...body,website:'bot'}),deps)).status,404);
});


test('form edits are admin-only, agents propose edits and cannot publish',async()=>{
  const {db,ctx,args}=fixture();
  await db.patch('form',{data:{...form,status:'draft'}});
  for(const role of ['manager','rep']) {
    await db.patch('publisher',{role});await db.patch('membership',{role});
    await assert.rejects(graph['modules.ts'].op.handler(ctx,{module:'inbound',op:'forms.update',key:'contact',expect:2,data:{name:'Changed'}}));
  }
  await db.patch('publisher',{role:'admin'});await db.patch('membership',{role:'admin'});
  agent='test-agent';
  try {
    const updated=await graph['modules.ts'].op.handler(ctx,{module:'inbound',op:'forms.update',key:'contact',expect:2,data:{name:'Changed'}});
    assert.ok(updated.proposed);
    await assert.rejects(graph['modules.ts'].callDispatch.handler(ctx,{module:'inbound',call:'publish',args:{key:'contact',expect:2}}));
  } finally {agent=null;}
});
test('a form daily cap holds across IPs',async()=>{
  const {db,ctx,args}=fixture();
  const row:any=await db.get('form');await db.patch('form',{data:{...row!.data,dailyCap:1}});
  assert.equal((await inbound.admit.handler(ctx,args)).status,202);
  assert.equal((await inbound.admit.handler(ctx,{...args,nonce:'two',ipHash:'different'})).status,429);
});


test('the switch makes every broker lookup and intake indistinguishable from unknown forms',async()=>{
  const {ctx,args}=fixture(); const prior=process.env.INBOUND_FORMS;delete process.env.INBOUND_FORMS;demo=false;
  try {
    const a=await inbound.admit.handler(ctx,args),b=await inbound.admit.handler(ctx,{...args,publicId:'unknown'});
    assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));
    assert.equal(a.status,404);
    ctx.auth.getUserIdentity=async()=>({issuer:'https://broker.test',subject:'auth_broker_server'});
    const issuer=process.env.CANON_SERVICE_JWT_ISSUER;process.env.CANON_SERVICE_JWT_ISSUER='https://broker.test';
    try {assert.equal(await inbound.publicForm.handler(ctx,{publicId:args.publicId}),null);}finally{if(issuer===undefined)delete process.env.CANON_SERVICE_JWT_ISSUER;else process.env.CANON_SERVICE_JWT_ISSUER=issuer;}
  }finally{demo=true;if(prior===undefined)delete process.env.INBOUND_FORMS;else process.env.INBOUND_FORMS=prior;}
});


test('publishing cannot be detached from its authorized form transition',async()=>{
  const {canonCallProblems}=await import('../modules/kernel/canonOperations.ts');
  const call=structuredClone(manifest.calls.publish);delete call.canon.then;
  assert.ok(canonCallProblems(manifest,'publish',call).length);
  const {ctx}=fixture();
  await assert.rejects(graph['modules.ts'].transition.handler(ctx,{module:'inbound',machine:'form',transition:'publish',key:'contact',expect:2,args:{publicId:'attacker'}}));
});


test('a publisher preview does not change the standing intake principal',async()=>{
  const {db,ctx,args}=fixture();
  await db.insert('users',{_id:'previewed',orgId:'org-a',role:'rep',isActive:true});
  await db.insert('accessPreviews',{orgId:'org-a',userId:'publisher',asUserId:'previewed',expiresAt:Date.now()+60000});
  const a=await inbound.admit.handler(ctx,args);assert.equal(a.status,202);
  await inbound.commit.handler(ctx,{...args,version:a.version,match:{by:'none',candidates:[]}});
  assert.equal(db.rows('canonEntities').length,1);
});


test('anonymous form responses reveal no email or company match outcome', async () => {
  type Match = import('../convex/lib/objects/inboundMatch.ts').InboundMatch;
  let matching: Match | null = null;
  const actions = loadConvex(['inboundForms.ts'], {
    'records.ts': real => ({ ...real, clientFor: () => ({
      matchInbound: async (orgId: string, input: { email: string }) => {
        assert.equal(orgId, 'org-a');
        assert.equal(input.email, 'new@example.test');
        if (!matching) throw new Error('Matching unavailable');
        return matching;
      },
    }) }),
  })['inboundForms.ts'];
  const cases: Array<[string, Match | null]> = [
    ['none', { by: 'none', candidates: [] }],
    ['lead', { by: 'email', leadId: 'private-lead', candidates: [{ object: 'lead', id: 'private-lead', reason: 'email' }] }],
    ['person', { by: 'email', personId: 'private-person', companyId: 'private-company', accountOwner: 'private-owner', candidates: [{ object: 'person', id: 'private-person', reason: 'email' }] }],
    ['ambiguous', { by: 'ambiguous', candidates: [{ object: 'lead', id: 'private-lead', reason: 'email' }, { object: 'person', id: 'private-person', reason: 'email' }] }],
    ['company', { by: 'domain', companyId: 'private-company', accountOwner: 'private-owner', candidates: [{ object: 'company', id: 'private-company', reason: 'domain' }] }],
    ['unavailable', null],
  ];
  const previous = process.env.CANON_SERVICE_JWT_ISSUER;
  process.env.CANON_SERVICE_JWT_ISSUER = 'https://broker.test';
  try {
    for (const redirect of [undefined, 'https://forms.example.test/thanks']) {
      for (const [name, match] of cases) {
        matching = match;
        const { db, ctx, args } = fixture();
        const row: any = await db.get('form');
        await db.patch('form', { data: { ...row.data, message: 'Received', ...(redirect ? { redirect } : {}) } });
        ctx.auth.getUserIdentity = async () => ({ issuer: 'https://broker.test', subject: 'auth_broker_server' });
        ctx.runMutation = async (ref: unknown, input: unknown) => {
          if (String(ref) === 'internal.inboundForms.admit') return inbound.admit.handler(ctx, input);
          assert.equal(String(ref), 'internal.inboundForms.commit');
          return inbound.commit.handler(ctx, input);
        };
        const projection = { name: form.name, fields: form.fields, hiddenParams: [] };
        const available = async (publicId: string) => {
          const value = await inbound.publicForm.handler(ctx, { publicId });
          assert.deepEqual(JSON.parse(JSON.stringify(value)), projection, name);
          return value !== null;
        };
        const success = { message: 'Received', ...(redirect ? { redirect } : {}) };
        const now = Date.now();
        const response = await handleFormSubmit(new Request('https://forms.example.test/api/forms/submit', {
          method: 'POST', headers: { origin: 'https://forms.example.test', 'content-type': 'application/json' },
          body: JSON.stringify({ publicId: args.publicId, token: renderFormToken(signer, args.publicId, now - 4000), answers: args.answers, params: args.params, website: '' }),
        }), {
          env: { NEXT_PUBLIC_SITE_URL: 'https://forms.example.test' }, signer, available, limit: () => true, now: () => now,
          submit: async input => {
            const result = await actions.submit.handler(ctx, input);
            assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 200, ...success }, name);
            return result;
          },
        });
        assert.deepEqual({ status: response.status, body: await response.json(), redirect: response.headers.get('location') }, { status: 200, body: success, redirect: null }, name);
        const submission: any = db.rows('moduleDocs').find(row => row.collection === 'submissions');
        assert.equal(submission.data.outcome, name === 'ambiguous' ? 'needs_review' : 'received', name);
        assert.equal(submission.data.matchUnavailable ?? false, name === 'unavailable', name);
        if (name === 'lead') assert.equal(submission.data.leadId, 'private-lead');
        if (name === 'person') assert.equal(submission.data.personId, 'private-person');
        if (name === 'company') assert.equal(submission.data.companyId, 'private-company');
        await available(args.publicId);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CANON_SERVICE_JWT_ISSUER;
    else process.env.CANON_SERVICE_JWT_ISSUER = previous;
  }
});
