export function findModelReference<T extends {modelId?: string;canonicalModelId?: string;aliases?: readonly string[];referencePriority?: number}>(model:string,rows:readonly T[]):T|undefined;
export function parseModelsDevReferencePrices(data:unknown):import('./trace-pricing').ModelPriceRule[];
export function modelIdentityKey(id:string):string;
export function modelIdentityWithoutDate(id:string):string;

export function modelReferenceIdentity(provider:string,id:string,canonical?:string): {canonicalModelId:string;aliases:string[];referencePriority:number};
