export const importSetKey = (parentKey: string, derivedKey: string): string => `import:${JSON.stringify([parentKey, derivedKey])}`;
