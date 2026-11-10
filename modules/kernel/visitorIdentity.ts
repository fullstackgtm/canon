export const visitorEmail = (value: string): string | null => {
  const email = value.trim().toLowerCase();
  return email.length <= 320 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ? email : null;
};

export const visitorDomain = (value: string): string | null => {
  const domain = value.trim().toLowerCase();
  return domain.length <= 253 && visitorEmail(`visitor@${domain}`) ? domain : null;
};

export function visitorEmailAllowed(email: string, grant: { emails?: readonly string[]; domains?: readonly string[]; issuedTo: { email?: string } }): boolean {
  return (grant.emails ?? [grant.issuedTo.email]).includes(email) || (grant.domains ?? []).includes(email.slice(email.lastIndexOf("@") + 1));
}
