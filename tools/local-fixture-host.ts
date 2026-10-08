import { networkInterfaces } from 'node:os';

/** Local HTTP fixtures must not depend on a public wildcard DNS service. */
export function localFixtureHost(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find(value => value.family === 'IPv4' && !value.internal
      && value.mac !== '00:00:00:00:00:00');
    if (address) return address.address;
  }
  throw new Error('No local IPv4 interface is available for the isolated HTTP fixture.');
}
