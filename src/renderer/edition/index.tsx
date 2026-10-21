import type * as React from 'react';
import type { ProviderConnection } from '../../shared/providers';
export type EditionPageId = never;
export const editionNavItems: {id:EditionPageId;label:string;tip:string;Icon:React.ElementType}[] = [];
export function EditionPages(_props:{activePage:string}) { return null; }
export function EditionOverlays() { return null; }
export function ProviderExtras(_props:{provider?:ProviderConnection;active:boolean}) { return null; }
export function editionProviderIcon(_kind:string|undefined): string | undefined { return undefined; }

export type EditionProviderIconKind=never;
export function editionProviderKind(_url:string):EditionProviderIconKind|undefined {return undefined;}
