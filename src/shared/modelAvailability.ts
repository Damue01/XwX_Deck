/** Only explicit service lifecycle facts remove a model from the menu. */
export function isUnavailableModel(model: { readonly lifecycleStatus?: string; readonly runtimeRetired?: boolean }): boolean {
  return model.runtimeRetired === true || ['shutdown', 'retired', 'discontinued', 'offline'].includes(model.lifecycleStatus?.toLowerCase() ?? '');
}

export interface ModelPurpose {
  readonly id: string;
  readonly modelKind?: string;
  readonly taskTypes?: readonly string[];
  readonly outputModalities?: readonly string[];
}

/** Image input is unrelated: a vision chat model still produces text. */
export function isNonConversationalModel(model: ModelPurpose): boolean {
  const id = model.id.trim().toLowerCase().split('/').pop() ?? '';
  // Ark labels its translation-only model TextGeneration. It cannot consume
  // a coding client's system/tool context or ordinary conversational payload.
  if (/^doubao-seed-translation(?:-|$)/.test(id)) return true;
  if (['image', 'video', 'embedding', 'embeddings', 'rerank', 'reranking', 'speech', 'audio', '3d', 'translation'].includes(model.modelKind?.toLowerCase() ?? '')) return true;
  const tasks = model.taskTypes?.map(task => task.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? [];
  const nonChatTasks = new Set(['textembedding', 'imageembedding', 'multimodalembedding', 'embedding', 'embeddings', 'rerank', 'reranking', 'texttoimage', 'imagetoimage', 'imagegeneration', 'texttovideo', 'imagetovideo', 'multimodaltovideo', 'videogeneration', 'videoextension', 'videoediting', 'imageto3d', 'textto3d', 'texttospeech', 'speechsynthesis', 'transcription', 'speechtotext']);
  if (tasks.length && tasks.every(task => nonChatTasks.has(task))) return true;
  if (model.outputModalities?.length && !model.outputModalities.some(modality => modality.toLowerCase() === 'text')) return true;
  if (tasks.length) return false;
  return /^(?:text-embedding|gpt-image|dall-e|embed|embedding|rerank|bge-reranker|sora|veo|imagen|whisper|tts|doubao-(?:embedding|seedream|seedance|seed3d)|hyper3d|hitem3d|qwen\d?(?:\.\d)?-(?:embedding|reranker))(?:[-_.]|$)/.test(id)
    || id === 'qwen-vl-ocr';
}
