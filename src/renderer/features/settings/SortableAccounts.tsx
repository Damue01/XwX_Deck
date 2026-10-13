import * as React from 'react';
import { GripVertical } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { SubscriptionAccount } from '../../../shared/subscriptionAccounts';

/** Reorders metadata only. The caller commits once on drop, never mid-drag. */
export function SortableAccounts({ accounts, disabled, onOrder, children }: {
  accounts: readonly SubscriptionAccount[]; disabled?: boolean;
  onOrder: (ids: readonly string[]) => void;
  children: (account: SubscriptionAccount, handle: React.ReactNode) => React.ReactNode;
}): React.ReactElement {
  const ids = accounts.map(account => account.id);
  const [order, setOrder] = React.useState(ids);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const list = React.useRef<HTMLDivElement>(null);
  const positions = React.useRef(new Map<string, number>());
  const drag = React.useRef<{ id: string; startY: number; startTop: number; pointerY: number; original: readonly string[] } | null>(null);
  const currentOrder = React.useRef(order); currentOrder.current = order;
  const signature = JSON.stringify(ids);
  React.useEffect(() => { if (!drag.current) setOrder(JSON.parse(signature) as string[]); }, [signature]);
  const rows = () => [...list.current?.querySelectorAll<HTMLElement>('[data-account-id]') ?? []];
  const capture = () => {
    positions.current = new Map(rows().map(row => [row.dataset.accountId!, row.getBoundingClientRect().top]));
    rows().forEach(row => row.getAnimations?.().forEach(animation => animation.cancel()));
  };
  const updatePosition = () => {
    const pointer = drag.current; if (!pointer) return;
    const row = rows().find(item => item.dataset.accountId === pointer.id);
    row?.style.setProperty('--drag-offset', `${pointer.pointerY - pointer.startY + pointer.startTop - row.offsetTop}px`);
  };
  React.useLayoutEffect(() => {
    updatePosition();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    rows().forEach(row => {
      const before = positions.current.get(row.dataset.accountId!);
      if (before === undefined || row.dataset.accountId === drag.current?.id || reduced) return;
      const delta = before - row.getBoundingClientRect().top;
      if (Math.abs(delta) > .5) row.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
    positions.current.clear();
  }, [order, dragging]);
  const move = (id: string, target: string, commit = false) => {
    const next = [...currentOrder.current], from = next.indexOf(id), to = next.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    capture(); next.splice(from, 1); next.splice(to, 0, id); currentOrder.current = next; setOrder(next);
    setAnnouncement(t('{0}，第 {1} 位', accounts.find(account => account.id === id)?.label ?? '', to + 1));
    if (commit) onOrder(next);
  };
  const finish = (cancel = false) => {
    const pointer = drag.current; if (!pointer) return;
    capture(); rows().forEach(row => row.style.removeProperty('--drag-offset')); drag.current = null; setDragging(null);
    if (cancel) setOrder([...pointer.original]);
    else if (JSON.stringify(currentOrder.current) !== JSON.stringify(pointer.original)) onOrder(currentOrder.current);
  };
  return <div className="chatgpt-accounts-list" ref={list} aria-describedby={accounts.length ? 'subscription-order-help' : undefined}>
    {order.map(id => accounts.find(account => account.id === id)).filter((account): account is SubscriptionAccount => !!account).map(account => {
      const handle = <button type="button" className="account-drag-handle" disabled={disabled || accounts.length < 2}
        aria-label={t('调整 {0} 的排序', account.label)} title={t('拖动排序，也可使用上下方向键')}
        onKeyDown={event => {
          if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const index = order.indexOf(account.id);
          const target = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : event.key === 'Home' ? 0 : order.length - 1;
          if (target >= 0 && target < order.length) move(account.id, order[target], true);
        }} onPointerDown={event => {
          if (event.button !== 0 || disabled) return;
          event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: account.id, startY: event.clientY, pointerY: event.clientY, startTop: event.currentTarget.closest<HTMLElement>('[data-account-id]')!.offsetTop, original: order };
          setDragging(account.id);
        }} onPointerMove={event => {
          if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          drag.current.pointerY = event.clientY; updatePosition();
          const top = list.current!.getBoundingClientRect().top;
          for (const row of rows()) {
            const target = row.dataset.accountId!; if (target === account.id) continue;
            const from = currentOrder.current.indexOf(account.id), to = currentOrder.current.indexOf(target);
            const midpoint = top + row.offsetTop + row.offsetHeight / 2;
            if ((from > to && event.clientY < midpoint) || (from < to && event.clientY > midpoint)) { move(account.id, target); break; }
          }
        }} onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}><GripVertical size={16} /></button>;
      return <section className="chatgpt-account" data-account-id={account.id} data-dragging={dragging === account.id || undefined} key={account.id}>{children(account, handle)}</section>;
    })}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
