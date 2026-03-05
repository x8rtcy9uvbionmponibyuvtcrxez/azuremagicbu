const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const domainPattern = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,}$/i;

export function isSyntheticTestTenantId(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase().startsWith("test-tenant-");
}

export function isLikelyTenantIdentifier(value: string | null | undefined): boolean {
  if (!value) return false;
  if (guidPattern.test(value)) return true;
  return domainPattern.test(value);
}
