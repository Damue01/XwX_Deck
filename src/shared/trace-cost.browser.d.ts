import type { TapModelUsage } from './trace-types';
import type { ModelPriceRule } from './trace-pricing';
export function traceCostBreakdown(usage: TapModelUsage, price: ModelPriceRule,
  estimate: (usage: TapModelUsage, price: ModelPriceRule) => number | undefined): { cost?: number; complete: boolean };
