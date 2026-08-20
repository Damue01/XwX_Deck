export type GatewayMenuAction = 'close' | 'open';

/** A stale menu item must never execute the opposite action after state changes. */
export function gatewayMenuActionMatches(
  expected: GatewayMenuAction,
  current: GatewayMenuAction | undefined
): boolean {
  return expected === current;
}
