/** Overflow waits outside Base UI, so unread messages never expire off screen. */
export interface QueuedToast<T> {
  key: string;
  signature: string;
  value: T;
}
/** Matches the existing Base UI stack's default visible capacity. */
export const TOAST_VISIBLE_LIMIT = 3;
export function createToastQueue<T>(sink: {
  show: (id: string, value: T, closed: () => void, removed: () => void) => void;
  update: (id: string, value: T) => void;
  close: (id: string) => void;
}, visibleLimit = TOAST_VISIBLE_LIMIT) {
  type Entry = QueuedToast<T> & { keys: Set<string> };
  type Delivery = { entry: Entry; id: string; closing: boolean; removalTimer?: ReturnType<typeof setTimeout> };
  const waiting: Entry[] = [];
  const active = new Map<string, Delivery>();
  let sequence = 0;
  const removed = (id: string) => {
    const delivery = active.get(id);
    if (!delivery) return;
    clearTimeout(delivery.removalTimer);
    // Base UI invokes onRemove before splicing its list. Deliver after mutation.
    queueMicrotask(() => {
      if (!active.delete(id)) return;
      deliver();
    });
  };
  const closing = (id: string) => {
    const delivery = active.get(id);
    if (!delivery || delivery.closing) return;
    delivery.closing = true;
    // Hidden WebViews may suspend animation cleanup. A dismissed notification
    // cannot block overflow forever; late cleanup cannot remove a newer item.
    delivery.removalTimer = setTimeout(() => removed(id), 750);
  };
  const deliver = () => {
    while (active.size < visibleLimit && waiting.length) {
      const entry = waiting.shift()!;
      const id = `xwxdeck-notification-${++sequence}`;
      active.set(id, { entry, id, closing: false });
      sink.show(id, entry.value, () => closing(id), () => removed(id));
    }
  };
  return {
    has(key: string) {
      return [...active.values()].some(item => !item.closing && item.entry.keys.has(key)) || waiting.some(entry => entry.keys.has(key));
    },
    add(item: QueuedToast<T>) {
      const delivery = [...active.values()].find(current => !current.closing && (current.entry.keys.has(item.key) || current.entry.signature === item.signature));
      const current = delivery?.entry ?? waiting.find(entry => entry.keys.has(item.key) || entry.signature === item.signature);
      if (current) {
        Object.assign(current, item);
        current.keys.add(item.key);
        if (delivery) sink.update(delivery.id, current.value);
      } else waiting.push({ ...item, keys: new Set([item.key]) });
      deliver();
    },
    close(key?: string) {
      for (let i = waiting.length - 1; i >= 0; i--) if (!key || waiting[i].keys.has(key)) waiting.splice(i, 1);
      for (const delivery of active.values()) if ((!key || delivery.entry.keys.has(key)) && !delivery.closing) {
        closing(delivery.id);
        sink.close(delivery.id);
      }
    }
  };
}
