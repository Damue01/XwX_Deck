import { useBridge } from '@/bridge/store';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { t } from '@/lib/i18n';

/** Removal never silently changes a client's service. */
export function useConfigurationRemoval(onNavigate?: () => void) {
  const bridge = useBridge();
  const confirm = useConfirm();
  return async (providerIds: readonly string[], accountIds: readonly string[] = []) => {
    const impact = bridge.api.getConfigurationRemovalImpact
      ? await bridge.api.getConfigurationRemovalImpact({ providerIds, accountIds })
      : Object.entries(bridge.providers?.selected ?? {}).filter(([, id]) => id && providerIds.includes(id)).map(([client]) => client);
    if (!impact.length) return true;
    if (await confirm({ title: t('请先切换使用此配置的客户端'), body: t('以下客户端仍引用此配置：{0}。请先在模型页选择其他服务，再回来移除。', impact.join('、')), confirmText: t('前往模型页') })) {
      onNavigate?.();
      window.dispatchEvent(new CustomEvent('xwxdeck:navigate', { detail: 'models' }));
    }
    return false;
  };
}
