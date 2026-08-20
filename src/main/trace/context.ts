import { collectDeclaredResponsesTools, isAdditionalToolsItem } from './protocolBody';
import { TapContextBreakdown } from './types';

export function analyzeRequestContext(body: unknown): TapContextBreakdown | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const systemChars =
    charSize(obj.system ?? obj.instructions ?? (obj as Record<string, unknown>).systemInstruction) +
    countSystemRoleChars(obj.messages) +
    countSystemRoleChars(obj.input);
  const messagesChars = nonSystemRoleChars(obj.messages) + nonSystemRoleChars(obj.input);
  // Responses-lite hides the declarations in `input`; without this they would be
  // reported as "other" instead of as the tool budget they actually are.
  const declaredTools = collectDeclaredResponsesTools(obj);
  const toolsChars = declaredTools.length ? charSize(declaredTools) : charSize(obj.functions);
  const toolResultsChars = countToolResultChars(obj.messages) + countToolResultChars(obj.input);
  const known = systemChars + messagesChars + toolsChars;
  const totalChars = charSize(body);
  const otherChars = Math.max(0, totalChars - known);
  return {
    estimatedTokens: Math.max(1, Math.ceil(totalChars / 4)),
    totalChars,
    systemChars,
    messagesChars,
    toolsChars,
    toolResultsChars,
    otherChars
  };
}

export function extractModelId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>).model;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function countToolResultChars(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj.role === 'tool') total += charSize(obj.content);
    // OpenAI Responses 历史项：function_call_output，以及 Codex 的 freeform /
    // tool_search 变体（后者把结果放在 tools 而不是 output）。
    if (obj.type === 'function_call_output' || obj.type === 'custom_tool_call_output') total += charSize(obj.output);
    if (obj.type === 'tool_search_output') total += charSize(obj.tools ?? obj.output);
    if (Array.isArray(obj.content)) {
      for (const part of obj.content) {
        if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'tool_result') {
          total += charSize((part as Record<string, unknown>).content);
        }
      }
    }
  }
  return total;
}

function isSystemRole(role: unknown): boolean {
  return role === 'system' || role === 'developer';
}

function countSystemRoleChars(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const item of value) {
    if (item && typeof item === 'object' && isSystemRole((item as Record<string, unknown>).role)) {
      total += charSize((item as Record<string, unknown>).content);
    }
  }
  return total;
}

function nonSystemRoleChars(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') { total += charSize(item); continue; }
    // Already billed to toolsChars; it normally carries role=developer, but do not
    // rely on that or the declarations get counted twice.
    if (isAdditionalToolsItem(item)) continue;
    if (isSystemRole((item as Record<string, unknown>).role)) continue;
    total += charSize(item);
  }
  return total;
}

function charSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return value.length;
  try { return JSON.stringify(value).length; } catch { return String(value).length; }
}
