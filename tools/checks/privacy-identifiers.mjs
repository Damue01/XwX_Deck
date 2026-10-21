import {readFileSync} from 'node:fs';
import {createIdentifierMatcher} from '../shared-core/privacy-identifiers.mjs';
export {createIdentifierMatcher};
const policy=JSON.parse(readFileSync(new URL('./repository-policy.json',import.meta.url),'utf8'));
export const containsPrivateIdentifier=createIdentifierMatcher(policy.forbiddenIdentifierDigests);
