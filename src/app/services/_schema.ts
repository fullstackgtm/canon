import { SALESFORCE_DEFAULT_FIELD_MAPPINGS } from '../../../engine/src/mappings.ts';
import type { DescribedObject } from '../../../convex/lib/objects/describe.ts';
import { V1Error } from '../api/v1/_lib.ts';

export class SalesforceError extends V1Error {
  constructor(code: string, message: string, fields: string[] = []) {
    super('invalid_request', message, { salesforceCode: code, fields });
  }
}
export const fail = (code: string, message: string): never => { throw new SalesforceError(code, message); };
export const OBJECTS: Record<string, string> = { Account: 'account', Contact: 'contact', Opportunity: 'deal', Lead: 'lead', Task: 'task', Event: 'meeting', Note: 'note', Product2: 'product', User: 'user' };
export const objectName = (canon: string) => Object.entries(OBJECTS).find(([, c]) => c === canon)?.[0] ?? `${canon}__c`;
const aliases: Record<string, Record<string, string>> = {
  account: { ...SALESFORCE_DEFAULT_FIELD_MAPPINGS.accounts, employees: 'NumberOfEmployees', phone: 'Phone', country: 'BillingCountry', city: 'BillingCity', description: 'Description' },
  contact: { ...SALESFORCE_DEFAULT_FIELD_MAPPINGS.contacts, fullName: 'Name' },
  deal: { ...SALESFORCE_DEFAULT_FIELD_MAPPINGS.deals, companyId: 'AccountId', primaryRepId: 'OwnerId', currency: 'CurrencyIsoCode', forecastCategory: 'ForecastCategoryName', description: 'Description' },
  lead: { firstName: 'FirstName', lastName: 'LastName', company: 'Company', title: 'Title', email: 'Email', phone: 'Phone', status: 'Status', leadSource: 'LeadSource' },
  task: { subject: 'Subject', status: 'Status', priority: 'Priority', dueDate: 'ActivityDate', description: 'Description', accountId: 'WhatId', contactId: 'WhoId' },
  meeting: { title: 'Subject', startAt: 'StartDateTime', endAt: 'EndDateTime', location: 'Location', notes: 'Description', accountId: 'WhatId', contactId: 'WhoId' },
  note: { body: 'Body' }, product: { name: 'Name', description: 'Description', sku: 'ProductCode', family: 'Family', active: 'IsActive' },
};
export type SfField = { name: string; canon: string; type: string; label: string; nillable: boolean; createable: boolean; updateable: boolean; custom: boolean; referenceTo?: string[]; relationshipName?: string; picklistValues?: { value: string; label: string; active: boolean; defaultValue: boolean }[] };
export type SfObject = { name: string; canon: string; label: string; fields: SfField[]; createable: boolean; updateable: boolean; deletable: boolean; custom: boolean };
const types: Record<string, string> = { text: 'string', number: 'double', currency: 'currency', date: 'date', datetime: 'datetime', checkbox: 'boolean', picklist: 'picklist', multipicklist: 'multipicklist', lookup: 'reference', user: 'reference' };
const system: Record<string, string> = { id: 'Id', createdAt: 'CreatedDate', updatedAt: 'LastModifiedDate', deletedAt: 'IsDeleted', ownerId: 'OwnerId' };
export function schema(def: DescribedObject): SfObject {
  const canon = def.apiName;
  const createable = def.canCreate || (def.register && def.writable);
  const fields: SfField[] = def.fields.map(f => {
    const name = system[f.apiName] ?? aliases[canon]?.[f.apiName] ?? `${f.apiName.replaceAll('.', '_')}__c`;
    const type = f.type === 'formula' ? f.returns : f.type;
    const referenceTo = f.type === 'lookup' ? [objectName(f.lookupTo)] : f.type === 'user' ? ['User'] : undefined;
    const registerCreate = canon === 'account' ? ['domain', 'name', 'industry', 'employees', 'country', 'linkedinUrl'].includes(f.apiName) : canon === 'contact' ? ['fullName', 'title', 'email', 'linkedinUrl'].includes(f.apiName) : canon === 'deal' ? ['name', 'amount', 'currency', 'closeDate', 'stage', 'pipelineId', 'dealType', 'revenueType', 'ownerId', 'companyId'].includes(f.apiName) || f.apiName.startsWith('custom.') : null;
    const readonly = !!f.system || def.readOnlyFields.includes(f.apiName);
    return { name, canon: f.apiName, label: f.label, type: types[type] ?? 'string', nillable: !f.required, custom: name.endsWith('__c'), createable: createable && (registerCreate ?? !readonly), updateable: def.writable && !readonly,
      ...(referenceTo ? { referenceTo, relationshipName: name.endsWith('__c') ? name.replace(/__c$/, '__r') : name.replace(/Id$/, '') } : {}),
      ...('options' in f ? { picklistValues: f.options.map(o => ({ ...o, defaultValue: false })) } : {}),
      ...(f.multiline ? { type: 'textarea' } : {}),
      ...(name === 'Probability' ? { type: 'percent' } : {}),
      ...(name === 'Email' ? { type: 'email' } : name === 'Phone' ? { type: 'phone' } : name === 'Website' ? { type: 'url' } : {}),
    };
  });
  if (canon === 'contact') {
    const name = fields.find(f => f.canon === 'fullName');
    if (name) {
      fields.push(...['FirstName', 'LastName'].map(n => ({ ...name, name: n, canon: n === 'FirstName' ? '$firstName' : '$lastName' })));
      fields.push({ name: 'AccountId', canon: 'accountId', type: 'reference', label: 'Account', referenceTo: ['Account'], relationshipName: 'Account', nillable: true, custom: false, createable, updateable: false });
    }
  }
  for (const [canon, name, type] of [['id', 'Id', 'id'], ['deletedAt', 'IsDeleted', 'boolean']] as const) fields.push({ canon, name, type, label: name, nillable: false, createable: false, updateable: false, custom: false });
  return { canon, name: objectName(canon), label: def.label, custom: canon.startsWith('custom_'), fields, createable, updateable: def.writable, deletable: def.canDelete };
}
export const field = (obj: SfObject, name: string): SfField => obj.fields.find(f => f.name.toLowerCase() === name.toLowerCase()) ?? fail('INVALID_FIELD', `No field ${name} on ${obj.name}`);
export const iso = (n: unknown) => typeof n === 'number' ? new Date(n).toISOString().replace('Z', '+0000') : n;
