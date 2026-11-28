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
const currentUser = 'publisher';
let recordReads: string[] = [];
let recordFailure = false;
const graph = loadConvex(['inboundForms.ts','modules.ts','objects.ts','lib/modules/intake.ts'], {
  'records.ts': real => ({ ...real, clientFor: (ctx:any) => {
    const read = async (table:string, ws:string, id:string) => {
      recordReads.push(`${table}:${ws}:${id}`);
      if (recordFailure) throw new Error('Unavailable');
      return ctx.db.rows(table).find((r:any) => r._id === id && r.orgId === ws) ?? null;
    };
    return { getContact: (ws:string,id:string) => read('contacts',ws,id), get: async (ws:string,id:string) => { const account = await read('accounts',ws,id); return account ? { account, contacts: [], history: [] } : null; } };
  } }),
  'lib.ts': real => ({...real, isDevAuthBypassEnabled:()=>demo, getCurrentUser:async (ctx:any)=>ctx.db.get(currentUser), requireUser:async (ctx:any)=>ctx.db.get(currentUser), agentClientOf:async()=>agent}),
});
const inbound = graph['inboundForms.ts'];
function fixture() {
  const publicId='abcdefghijklmnopqrstuv';
  const db=memoryDb({
    contacts:[{_id:'candidate',orgId:'org-a',ownerId:'publisher'}],
    accounts:[{_id:'company',orgId:'org-a',ownerId:'publisher'}],
    organizations:[{_id:'org-a',name:'A'},{_id:'org-b',name:'B'}],
    users:[{_id:'publisher',orgId:'org-a',clerkUserId:'user_publisher',role:'admin',isActive:true,name:'Publisher'}],
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
  const deps:FormDeps={env:{NEXT_PUBLIC_SITE_URL:'https://forms.example.test',CANON_CLIENT_IP_HEADER:'x-real-ip'},signer,available:async()=>true,limit:()=>true,now:()=>now,submit:async()=>{writes++;return {status:200};}};
  const body={publicId,token:renderFormToken(signer,publicId,now-4000),answers:{email:'a@example.test'},params:{},website:''};
  const req=(b:unknown,origin='https://forms.example.test')=>new Request('https://forms.example.test/api/forms/submit',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(b)});
  assert.equal((await handleFormSubmit(req({...body,website:'bot'}),deps)).status,200); assert.equal(writes,0);
  assert.equal((await handleFormSubmit(req({...body,token:renderFormToken(signer,publicId,now)}),deps)).status,400);
  for (const request of [req(body,'https://foreign.test'),req({...body,workspace:'other'}),req({...body,answers:{note:'x'.repeat(33000)}})]) assert.equal((await handleFormSubmit(request,deps)).status,404);
  assert.equal((await handleFormSubmit(req(body),deps)).status,200);assert.equal(writes,1);
  deps.available=async()=>false;assert.equal((await handleFormSubmit(req({...body,website:'bot'}),deps)).status,404);
});
test('forms stay closed where visitors cannot be told apart, except on the local HTTP stack',async()=>{
  const now=Date.now(),publicId='abcdefghijklmnopqrstuv'; let writes=0;
  const post=(site:string,env:Record<string,string>)=>handleFormSubmit(new Request(`${site}/api/forms/submit`,{method:'POST',headers:{origin:site,'content-type':'application/json'},body:JSON.stringify({publicId,token:renderFormToken(signer,publicId,now-4000),answers:{email:'a@example.test'},params:{}})}),
    {env:{NEXT_PUBLIC_SITE_URL:site,...env},signer,available:async()=>true,limit:()=>true,now:()=>now,submit:async()=>{writes++;return {status:200};}});
  // Without the ingress header every visitor shares one limit bucket, so one script could lock every form.
  assert.equal((await post('https://forms.example.test',{})).status,404); assert.equal(writes,0);
  assert.equal((await post('https://forms.example.test',{CANON_CLIENT_IP_HEADER:'x-real-ip'})).status,200);
  assert.equal((await post('http://127.0.0.1:3000',{})).status,200);
  assert.equal((await post('http://127.0.0.1:3000',{NODE_ENV:'production'})).status,404);
});
test('two submissions of one new email a moment apart create one lead',async()=>{
  const {db,ctx,args}=fixture(); const none={by:'none',candidates:[]};
  // Both were matched before either lead existed, as two tabs or a retry with a fresh token would be.
  const a=await inbound.admit.handler(ctx,args); await inbound.commit.handler(ctx,{...args,version:a.version,match:none});
  await inbound.commit.handler(ctx,{...args,nonce:'second',version:a.version,match:none});
  assert.equal(db.rows('canonEntities').length,1);
  assert.deepEqual(db.rows('moduleDocs').filter((r:any)=>r.collection==='submissions').map((r:any)=>[r.data.outcome,!!r.data.leadId]),[['received',true],['duplicate',false]]);
  await inbound.commit.handler(ctx,{...args,nonce:'third',answers:{...args.answers,email:'other@example.test'},version:a.version,match:none});
  assert.equal(db.rows('canonEntities').length,2);
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
    for (const routeToAccountOwner of [false, true]) for (const redirect of [undefined, 'https://forms.example.test/thanks']) {
      for (const [name, match] of cases) {
        matching = match;
        const { db, ctx, args } = fixture();
        const row: any = await db.get('form');
        await db.patch('form', { data: { ...row.data, routeToAccountOwner, message: 'Received', ...(redirect ? { redirect } : {}) } });
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
          env: { NEXT_PUBLIC_SITE_URL: 'https://forms.example.test', CANON_CLIENT_IP_HEADER: 'x-real-ip' }, signer, available, limit: () => true, now: () => now,
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

const submissionRow = (db: ReturnType<typeof memoryDb>) => db.rows('moduleDocs').find((r:any)=>r.collection==='submissions') as any;
async function reviewFixture() {
  const f=fixture();
  await inbound.commit.handler(f.ctx,{...f.args,version:2,match:{by:'ambiguous',candidates:[{object:'person',id:'candidate',reason:'email',ownerId:'publisher',futureOwnerInfo:'ignored'}]}});
  return {...f,row:submissionRow(f.db)};
}
async function resolve(ctx:any,row:any,action='dismiss',candidateId?:string, handlers=graph['modules.ts']) {
  const input={module:'inbound',call:'resolve',args:{key:row.key,expect:row.version,action,...(candidateId?{candidateId}:{})}};
  ctx.runQuery = async (ref:unknown, a:unknown) => {
    const name = String(ref).split('.').at(-1)!;
    return handlers[name].handler(ctx,a);
  };
  ctx.runMutation = async (_ref:unknown, a:unknown) => handlers.executeCanonCall.handler(ctx,a);
  ctx.runAction = async (_ref:unknown, a:unknown) => handlers.prepareCanonResolution.handler(ctx,a);
  return handlers.call.handler(ctx,input);
}
async function asManager(db:any,rules:unknown[]=[]) {
  await db.patch('publisher',{role:'manager'});await db.patch('membership',{role:'manager'});
  await db.insert('rolePermissions',{orgId:'org-a',role:'manager',rules});
}

test('reps read only assigned submissions and never review rows',async()=>{
  const {db,ctx,row}=await reviewFixture();
  await db.patch('publisher',{role:'rep'});await db.patch('membership',{role:'rep'});
  const views=graph['modules.ts'];
  const result=await views.view.handler(ctx,{module:'inbound',view:'submissions.all',args:{}});
  assert.equal(result.length,0);
  assert.equal(await views.view.handler(ctx,{module:'inbound',view:'submissions.one',args:{key:row.key}}),null);
  await db.patch(row._id,{ownerUserId:'publisher',data:{...row.data,assignee:'publisher',outcome:'received'}});
  assert.equal((await views.view.handler(ctx,{module:'inbound',view:'submissions.all',args:{}})).length,1);
  assert.ok(await views.view.handler(ctx,{module:'inbound',view:'submissions.one',args:{key:row.key}}));
  assert.equal((await views.view.handler(ctx,{module:'inbound',view:'submissions.review',args:{}})).length,0);
});
test('other roles cannot read submissions',async()=>{
  assert.ok(!manifest.pages.find((p:any)=>p.path==='review').roles.includes('other'));
  const {db,ctx}=await reviewFixture();await db.patch('publisher',{role:'other'});await db.patch('membership',{role:'other'});
  assert.equal((await graph['modules.ts'].view.handler(ctx,{module:'inbound',view:'submissions.all',args:{}})).length,0);
});

test('rep and agent resolution are refused',async()=>{
  const {db,ctx,row}=await reviewFixture();await db.patch('publisher',{role:'rep'});await db.patch('membership',{role:'rep'});
  await assert.rejects(resolve(ctx,row));
  await db.patch('publisher',{role:'admin'});await db.patch('membership',{role:'admin'});agent='test-agent';
  try {await assert.rejects(resolve(ctx,row));} finally {agent=null;}
  assert.equal(((await db.get(row._id))!.data as any).outcome,'needs_review');
});
test('hidden lead candidates are refused to managers',async()=>{
  const {db,ctx,row,args}=await reviewFixture();
  await inbound.commit.handler(ctx,{...args,nonce:'seed-lead',version:2,match:{by:'none',candidates:[]}});
  const hidden=String(db.rows('canonEntities')[0]._id);
  await asManager(db,[{object:'lead',read:false}]);
  await db.patch(row._id,{data:{...row.data,candidates:[{object:'lead',id:hidden,reason:'email'}]}});
  await assert.rejects(resolve(ctx,row,'link',hidden));assert.equal(db.rows('canonEntities').length,1);
});
test('resolution refuses candidates outside the stored set',async()=>{
  const {ctx,row}=await reviewFixture();await assert.rejects(resolve(ctx,row,'link','foreign'));
});
test('manager without lead create permission cannot create',async()=>{
  const {db,ctx,row}=await reviewFixture();await asManager(db,[{object:'lead',create:false}]);
  await assert.rejects(resolve(ctx,row,'create'));assert.equal(((await db.get(row._id))!.data as any).outcome,'needs_review');
});
test('resolution refuses a View as preview without changing the submission or creating a lead',async()=>{
  const actual=loadConvex(['modules.ts','lib.ts']);
  const requireActual=actual['lib.ts'].requireUser as unknown as (ctx:any)=>Promise<unknown>;
  const previous=process.env.CANON_AUTH;process.env.CANON_AUTH='local';
  try {
    const {db,ctx,row}=await reviewFixture();
    ctx.auth.getUserIdentity=async()=>({issuer:'https://clerk.test',subject:'user_publisher',tokenIdentifier:'https://clerk.test|user_publisher'});
    await db.insert('users',{_id:'rep',orgId:'org-a',role:'rep',isActive:true});
    await db.insert('accessPreviews',{orgId:'org-a',userId:'publisher',asUserId:'rep',expiresAt:Date.now()+60000});
    const before=JSON.stringify(db.rows('moduleDocs'));
    await assert.rejects(requireActual(ctx),/viewing as/i);
    await assert.rejects(resolve(ctx,row,'create',undefined,actual['modules.ts']),/viewing as/i);
    assert.equal(JSON.stringify(db.rows('moduleDocs')),before);
    assert.equal(((await db.get(row._id))!.data as any).outcome,'needs_review');
    assert.equal(db.rows('canonEntities').length,0);
  } finally {if(previous===undefined)delete process.env.CANON_AUTH;else process.env.CANON_AUTH=previous;}
});
test('foreign workspace, fake and disabled packages refuse resolution',async()=>{
  for(const mode of ['foreign','fake','disabled']) {
    const {db,ctx,row}=await reviewFixture();
    if(mode==='foreign')await db.patch('publisher',{orgId:'org-b'});
    if(mode==='fake')await db.patch('package',{source:{kind:'canon',id:'fake'}});
    if(mode==='disabled')await db.patch('enabled',{enabled:false});
    await assert.rejects(resolve(ctx,row));
  }
});
test('fresh unowned candidate respects narrowed resolver unowned policy',async()=>{
  const {db,ctx,row}=await reviewFixture();await asManager(db,[{object:'contact',visibility:'own',unowned:false}]);
  await db.patch(row._id,{data:{...row.data,candidates:[{object:'person',id:'candidate',reason:'email'}]}});
  await db.patch('candidate',{ownerId:null});
  await assert.rejects(resolve(ctx,row,'link','candidate'));
});
test('own-only resolvers link only to their own person candidate',async()=>{
  for(const ownerId of ['someone-else','publisher']) {
    const {db,ctx,row}=await reviewFixture();await asManager(db,[{object:'contact',visibility:'own',unowned:false}]);
    await db.patch(row._id,{data:{...row.data,candidates:[{object:'person',id:'candidate',reason:'email',ownerId}]}});
    await db.patch('candidate',{ownerId});
    if(ownerId==='publisher'){await resolve(ctx,row,'link','candidate');assert.equal(((await db.get(row._id))!.data as any).outcome,'linked');}
    else await assert.rejects(resolve(ctx,row,'link','candidate'));
  }
});

test('ambiguous submissions retain candidates and send one notice per admin and manager',async()=>{
  const {db,ctx,row}=await reviewFixture();
  assert.equal(row.data.candidates[0].id,'candidate');
  assert.equal(db.rows('notifications').length,1);
  await db.insert('orgRoles',{orgId:'org-a',key:'custom-manager',base:'manager',name:'Manager',capabilities:[]});
  await db.insert('users',{_id:'manager',orgId:'org-a',role:'custom-manager',isActive:true,name:'Manager'});
  await inbound.commit.handler(ctx,{...fixture().args,nonce:'second-review',version:2,match:{by:'ambiguous',candidates:[]}});
  assert.deepEqual(db.rows('notifications').map((n:any)=>n.userId).sort(),['manager','publisher']);
});
test('Link records resolution metadata and notifies the assignee',async()=>{
  for(const object of ['person','lead']) {
    const {db,ctx,row}=await reviewFixture();let candidateId='candidate';
    if(object==='lead') {
      const save=graph['objects.ts'].saveAsCaller as unknown as (...args:any[])=>Promise<any>;
      const saved=await save(ctx,await db.get('publisher'),'lead',{op:'create',values:{lastName:'Known',email:'known@example.test',ownerId:'publisher'}});
      candidateId=saved.streamId;
      await db.patch(row._id,{data:{...row.data,candidates:[{object,id:candidateId,reason:'email'}]}});
    }
    await resolve(ctx,row,'link',candidateId);
    const resolved:any=(await db.get(row._id))!;
    assert.equal(resolved.data.outcome,'linked');assert.equal(resolved.data[object==='person'?'personId':'leadId'],candidateId);assert.equal(resolved.data.assignee,'publisher');
    assert.equal(resolved.data.resolvedBy,'publisher');assert.equal(typeof resolved.data.resolvedAt,'number');
    assert.equal(db.rows('notifications').length,2);
  }
});
test('Create with a company candidate uses intake values and creates exactly one lead',async()=>{
  const {db,ctx,row}=await reviewFixture();
  await db.patch(row._id,{data:{...row.data,candidates:[{object:'company',id:'company',reason:'domain',ownerId:'publisher'}]}});
  await resolve(ctx,row,'create','company');
  assert.equal(db.rows('canonEntities').length,1);
  const resolved:any=(await db.get(row._id))!;assert.equal(resolved.data.companyId,'company');assert.equal(resolved.data.outcome,'received');
  const hot:any=db.rows('recordRows')[0];assert.equal(hot.values.email,'new@example.test');assert.equal(hot.values.lastName,'new@example.test');
  assert.ok(JSON.stringify(db.rows('ledgerEntries')).includes('intake:@canon/inbound:contact:user:publisher'));
});
test('Dismiss keeps the submission and creates no record',async()=>{
  const {db,ctx,row}=await reviewFixture();await resolve(ctx,row);
  assert.equal(((await db.get(row._id))!.data as any).outcome,'dismissed');assert.equal(db.rows('canonEntities').length,0);
});
test('resolution compares versions and accepts only needs-review submissions',async()=>{
  const {db,ctx,row}=await reviewFixture();await resolve(ctx,row,'create');
  await assert.rejects(resolve(ctx,row,'create'),/Already resolved/);
  await assert.rejects(resolve(ctx,{...row,version:row.version+1},'create'),/Already resolved/);
  assert.equal(db.rows('canonEntities').length,1);
});
test('account-owner routing is opt-in and refuses departed members',async()=>{
  for(const setting of [false,true]){
    const {db,ctx,args}=fixture();const row:any=await db.get('form');await db.patch('form',{data:{...row.data,routeToAccountOwner:setting}});
    await inbound.commit.handler(ctx,{...args,version:2,match:{by:'domain',companyId:'company',accountOwner:'publisher',candidates:[]}});
    assert.equal((db.rows('recordRows')[0] as any).values.ownerId??null,setting?'publisher':null);
    assert.equal(submissionRow(db).data.assignee??null,setting?'publisher':null);
  }
  const {db,ctx,args}=fixture();const row:any=await db.get('form');await db.patch('form',{data:{...row.data,routeToAccountOwner:true}});
  await inbound.commit.handler(ctx,{...args,version:2,match:{by:'domain',companyId:'company',accountOwner:'departed',candidates:[]}});
  assert.equal((db.rows('recordRows')[0] as any).values.ownerId??null,null);assert.equal(submissionRow(db).data.assignee,undefined);
});
test('linked person falls back to the account owner when the older match omits ownership',async()=>{
  const {db,ctx,args}=fixture();await inbound.commit.handler(ctx,{...args,version:2,match:{by:'email',personId:'person',accountOwner:'publisher',candidates:[]}});
  assert.equal(submissionRow(db).data.assignee,'publisher');assert.equal(db.rows('notifications').length,1);
});
test('linked person prefers its own owner over the account owner',async()=>{
  const {db,ctx,args}=fixture();await db.insert('users',{_id:'owner',orgId:'org-a',role:'rep',isActive:true,name:'Owner'});
  await inbound.commit.handler(ctx,{...args,version:2,match:{by:'email',personId:'person',personOwner:'owner',accountOwner:'publisher',candidates:[]}});
  assert.equal(submissionRow(db).data.assignee,'owner');
});
test('owners who cannot see the person receive neither assignment nor notice',async()=>{
  const {db,ctx,args}=fixture();await db.insert('users',{_id:'owner',orgId:'org-a',role:'rep',isActive:true,name:'Owner'});
  await db.insert('rolePermissions',{orgId:'org-a',role:'rep',rules:[{object:'contact',read:false}]});
  await inbound.commit.handler(ctx,{...args,version:2,match:{by:'email',personId:'person',personOwner:'owner',candidates:[]}});
  assert.equal(submissionRow(db).data.assignee,undefined);assert.equal(db.rows('notifications').length,0);
});
test('duplicate outcomes send no notices; hourly notice limits still retain every submission',async()=>{
  const {db,ctx,args}=fixture();
  for(let i=0;i<12;i++)await inbound.commit.handler(ctx,{...args,nonce:`linked-${i}`,version:2,match:{by:'email',personId:'person',accountOwner:'publisher',candidates:[]}});
  assert.equal(db.rows('notifications').length,10);assert.equal(db.rows('moduleDocs').filter((r:any)=>r.collection==='submissions').length,12);
  await inbound.commit.handler(ctx,{...args,nonce:'new-1',version:2,match:{by:'none',candidates:[]}});
  await inbound.commit.handler(ctx,{...args,nonce:'new-2',version:2,match:{by:'none',candidates:[]}});
  assert.equal(db.rows('notifications').length,10);assert.equal(db.rows('moduleDocs').filter((r:any)=>r.data.outcome==='duplicate').length,1);
});
test('routing config and shared mapping are validated and resolution is restricted to Inbound without then',async()=>{
  const {formProblems,leadValuesFrom,normalizeSubmission}=await import('../modules/kernel/inboundForms.ts');
  assert.ok(formProblems({...form,routeToAccountOwner:'yes'}).length);
  const n=normalizeSubmission(form,{email:'UPPER@example.test',consent:true},{});assert.deepEqual(leadValuesFrom(form,n.answers),n.values);
  const {canonCallProblems}=await import('../modules/kernel/canonOperations.ts');
  assert.equal(canonCallProblems(manifest,'resolve',manifest.calls.resolve).length,0);
  assert.ok(canonCallProblems({...manifest,id:'@canon/different'},'resolve',manifest.calls.resolve).length);
  assert.ok(canonCallProblems(manifest,'resolve',{...manifest.calls.resolve,canon:{operation:'submissions.resolve',then:manifest.calls.publish.canon.then}}).length);
});

test('more than fifty review recipients cannot change public success or discard submissions',async()=>{
  const {db,ctx,args}=fixture();
  for(let i=0;i<51;i++)await db.insert('users',{_id:`admin-${i}`,orgId:'org-a',role:'admin',isActive:true,name:`Admin ${i}`});
  for(let i=0;i<2;i++) {
    const result=await inbound.commit.handler(ctx,{...args,nonce:`review-${i}`,version:2,match:{by:'ambiguous',candidates:[]}});
    assert.deepEqual(JSON.parse(JSON.stringify(result)),{status:200,message:'Thank you. Your submission was received.'});
  }
  assert.equal(db.rows('notifications').length,50);assert.equal(db.rows('moduleDocs').filter((r:any)=>r.collection==='submissions').length,2);
});
test('resolution cannot write lead fields locked by the manager role',async()=>{
  const {db,ctx,row}=await reviewFixture();await asManager(db,[{object:'lead',fields:[{apiName:'email',level:'readOnly'}]}]);
  await assert.rejects(resolve(ctx,row,'create'));
  assert.equal(db.rows('canonEntities').length,0);assert.equal(((await db.get(row._id))!.data as any).outcome,'needs_review');
});

test('owner metadata survives the HTTP client and remains additive to legacy match consumers',async()=>{
  const {matchInbound}=await import('../convex/lib/objects/inboundMatch.ts');
  const {createHttpRecordClient}=await import('../convex/lib/recordClient.ts');
  const widened=matchInbound({email:'p@example.test'},[{id:'company',name:'Company',ownerId:'account-owner'}],[{id:'person',email:'p@example.test',accountId:'company',ownerId:'person-owner'}],[]);
  const client=createHttpRecordClient({baseUrl:'https://service.test',token:'test',fetchImpl:async(input)=>new Response(JSON.stringify(String(input).endsWith('/healthz')?{version:'1.53.0'}:widened))});
  const result=await client.matchInbound('workspace',{email:'p@example.test'});
  assert.deepEqual(result,widened);
  const {personOwner:_owner,candidates,...legacy}=result as any;
  assert.deepEqual({...legacy,candidates:candidates.map(({ownerId:_id,...c}:any)=>c)},{by:'email',personId:'person',companyId:'company',accountOwner:'account-owner',candidates:[{object:'person',id:'person',reason:'email'}]});
});


test('old Inbound installs close intake before writing and tell the admin how to restore it', async () => {
  const { db, ctx, args } = fixture();
  const old = readFileSync('tests/fixtures/modules/inbound/pre-review.module.json', 'utf8');
  await db.patch('package', { manifest: old, manifestHash: 'pre-review' });
  const functions = graph['lib/modules/intake.ts'] as unknown as typeof import('../convex/lib/modules/intake.ts');
  assert.equal(await functions.formProjection(ctx, args.publicId), null);
  assert.equal((await inbound.admit.handler(ctx, args)).status, 404);
  assert.equal((await inbound.commit.handler(ctx, { ...args, version: 2, match: { by: 'none', candidates: [] } })).status, 404);
  await assert.rejects(functions.resolveSubmission(ctx, { key: 'old', expect: 1, action: 'dismiss' }), /Update Inbound.*Recipes/);
  assert.equal(db.rows('moduleRateLimits').length, 0);
  assert.equal(db.rows('canonEntities').length, 0);
  assert.equal(db.rows('moduleDocs').length, 1);
});

test('resolution uses current person and company owners in both visibility directions and for old submissions',async()=>{
  for (const object of ['person','company']) for (const currentOwner of ['publisher','other',null]) for (const legacy of [false,true]) {
    const {db,ctx,row}=await reviewFixture();
    const id=object==='person'?'candidate':'company';
    await asManager(db,[{object:object==='person'?'contact':'account',visibility:'own',unowned:true}]);
    await db.patch(id,{ownerId:currentOwner});
    await db.patch('form',{data:{...(await db.get('form'))!.data as any,routeToAccountOwner:true}});
    await db.patch(row._id,{data:{...row.data,candidates:[{object,id,reason:'email',...(legacy?{}:{ownerId:currentOwner==='publisher'?'other':'publisher'})}]}});
    if(currentOwner==='other') await assert.rejects(resolve(ctx,row,object==='person'?'link':'create',id),/role cannot/);
    else {
      await resolve(ctx,row,object==='person'?'link':'create',id);
      const saved:any=await db.get(row._id);
      assert.equal(saved.data.assignee??null,currentOwner);
      if(object==='company') assert.equal((db.rows('recordRows')[0] as any).values.ownerId??null,currentOwner);
    }
  }
});
test('resolution refuses deleted, foreign and unreachable records without falling back to snapshots',async()=>{
  for(const mode of ['deleted','foreign','outage']) {
    const {db,ctx,row}=await reviewFixture();
    if(mode==='deleted')await db.delete('candidate');
    if(mode==='foreign')await db.patch('candidate',{orgId:'org-b'});
    recordFailure=mode==='outage';
    try { await assert.rejects(resolve(ctx,row,'link','candidate'),mode==='outage'?/current owner/:/no longer exists/); }
    finally {recordFailure=false;}
    assert.equal(((await db.get(row._id))!.data as any).outcome,'needs_review');
  }
});
test('person resolution reads its company owner fresh and never uses a deleted company snapshot',async()=>{
  for(const deleted of [false,true]) {
    const {db,ctx,row}=await reviewFixture();
    await db.patch('candidate',{ownerId:null});
    await db.patch(row._id,{data:{...row.data,companyId:'company',accountOwner:'departed'}});
    if(deleted)await db.delete('company');
    recordReads=[];
    await resolve(ctx,row,'link','candidate');
    assert.deepEqual(recordReads,['contacts:org-a:candidate','accounts:org-a:company']);
    assert.equal(((await db.get(row._id))!.data as any).assignee,deleted?undefined:'publisher');
  }
});
test('dismiss and candidate-less create never read records',async()=>{
  for(const action of ['dismiss','create']) {
    const {ctx,row}=await reviewFixture();recordReads=[];
    await resolve(ctx,row,action,action==='dismiss'?'candidate':undefined);
    assert.deepEqual(recordReads,[]);
  }
});
test('resolution refuses missing or mismatched preparation and other operations reject it',async()=>{
  const {db,ctx,row}=await reviewFixture(),handlers=graph['modules.ts'];
  const input={module:'inbound',call:'resolve',args:{key:row.key,expect:row.version,action:'link',candidateId:'candidate'}};
  const authorization=await handlers.callDispatch.handler(ctx,input);
  await assert.rejects(handlers.executeCanonCall.handler(ctx,{...input,authorization}),/preparation/);
  const resolutionOwners={candidate:{id:'other',found:true,ownerId:'publisher'}};
  await assert.rejects(handlers.executeCanonCall.handler(ctx,{...input,authorization,resolutionOwners}),/Unexpected Canon preparation/);
  await db.patch('form',{data:{...form,status:'draft'}});
  const publish={module:'inbound',call:'publish',args:{key:'contact',expect:2}};
  const auth=await handlers.callDispatch.handler(ctx,publish);
  await assert.rejects(handlers.executeCanonCall.handler(ctx,{...publish,authorization:auth,resolutionOwners}),/Unexpected Canon preparation/);
});
test('missing, archived and converted leads are unavailable at resolution',async()=>{
  for(const lifecycle of ['missing','archived','converted']) {
    const {db,ctx,row}=await reviewFixture();
    let id='missing';
    if(lifecycle!=='missing') {
      const save=graph['objects.ts'].saveAsCaller as unknown as (...args:any[])=>Promise<any>;
      const result=await save(ctx,await db.get('publisher'),'lead',{op:'create',values:{lastName:'Known',email:'known@example.test'}});
      id=result.streamId;
      const changed=await save(ctx,await db.get('publisher'),'lead',lifecycle==='archived' ? {op:'delete',streamId:id} : {op:'update',streamId:id,values:{convertedAt:Date.now()}});
      assert.equal(changed.status,'applied');
    }
    await db.patch(row._id,{data:{...row.data,candidates:[{object:'lead',id,reason:'email'}]}});
    await assert.rejects(resolve(ctx,row,'link',id),/no longer available/);
  }
});
